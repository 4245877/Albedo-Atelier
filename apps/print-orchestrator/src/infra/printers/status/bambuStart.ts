import { requireReady } from "../capabilities";
import type { PrinterConfig } from "../config";
import { BAMBU_PLATE_GCODE_PATH } from "../files/bambuPackage";
import { anyNamesJob, jobNameStem } from "../files/jobIdentity";
import { getBambuRawPrint, publishBambuRequest, requestBambuFullReport } from "./bambu";
import { EXTERNAL_SPOOL_TRAY, parseAmsTrays } from "./bambuUsage";
import { verifyPinnedFeed, type FeedPlan, type FeedTray } from "../../../domain/printers/feedPlan";
import type { AmsTraySnapshot } from "./types";
import { parseBambuFaults, parseBambuMediaPresent, startBlockingFaults } from "./bambuFaults";
import { firstText } from "./mapper";
import { PrinterCommandError, type PrinterFault } from "./types";

/**
 * Starting a print on a Bambu printer over local MQTT — the last link the chain
 * was missing.
 *
 * Two commands exist in the LAN protocol, and this module picks by file type
 * rather than making the caller know the difference:
 *
 *  - **`project_file`** for a `.3mf` plate package. This is the canonical path —
 *    what Bambu Studio and OrcaSlicer send, and what every file already sitting
 *    on this farm's A1 is. `param` names the G-code *inside* the container
 *    (`Metadata/plate_1.gcode`) and `url` names the container on the SD card.
 *  - **`gcode_file`** for a bare `.gcode`, which takes the path directly.
 *
 * **Nothing here is fire-and-forget.** MQTT publish only proves the broker took
 * the bytes; it says nothing about whether the firmware accepted the job. So
 * after publishing, {@link confirmBambuStart} waits for the device's own report
 * to show the job actually running — and a start that cannot be confirmed is
 * raised as an *unknown* outcome, never a success. That distinction is what the
 * dispatch's `classifyError` turns into "hold the printer and reconcile" instead
 * of "re-send and maybe print twice".
 *
 * ## Three outcomes, not two
 *
 * Waiting for `gcode_state` alone could only ever answer "running" or "gave up",
 * and a real failure taught us what that costs. An A1 was handed a plate package
 * it had itself confirmed present, could not read its MicroSD card, put
 * `0500-C010` on its screen — and stayed at `IDLE`, because a job that never
 * begins never leaves idle. The wait therefore timed out into *unknown*, which
 * is the fail-closed branch: the run was held, the bed stayed reserved, and the
 * printer went on refusing its own queue as "занят" until a human intervened.
 * Every part of that was correct given the evidence; the evidence was simply
 * incomplete, because the device's fault register was never read.
 *
 * So the loop now watches both channels and separates:
 *
 *  - **started** — the device names our job in a running state;
 *  - **rejected** — the device raises a fault that provably prevents a start
 *    (`definitivelyRejected`), so the dispatch unwinds cleanly and a retry is
 *    safe once the operator has fixed the physical cause;
 *  - **unknown** — genuinely no verdict, which stays fail-closed as before.
 *
 * Because a rejection now returns the moment the device complains, the window
 * below is only ever spent in the third case — which is why it can be generous
 * without making a failed launch slow.
 */

/**
 * How long to wait for the device to report the job as started.
 *
 * Bambu parses the plate package off the card before `gcode_state` moves, and on
 * a large file or a tired card that can take well over the 20s this used to
 * allow — a timeout that produced an *unknown* outcome for what was often just a
 * slow, healthy start. The caller's HTTP deadline must exceed this (see the
 * dashboard's launch timeout); a client that gives up first turns the server's
 * verdict into a phantom failure, which is precisely what it did.
 */
export const START_CONFIRM_TIMEOUT_MS = 45_000;
const START_POLL_INTERVAL_MS = 1_000;

/** Bambu `gcode_state` values that mean a job is under way. */
const RUNNING_STATES = new Set(["RUNNING", "PREPARE", "SLICING", "PAUSE"]);

/**
 * A start whose *outcome could not be established*.
 *
 * Deliberately distinct from a refusal: the command may well have been accepted
 * and the print may be running. The dispatch must therefore hold the printer and
 * reconcile rather than retry — a retry here is how one model gets printed twice.
 */
export class BambuStartUnconfirmedError extends PrinterCommandError {
  constructor(message: string) {
    super(message);
    this.name = "BambuStartUnconfirmedError";
  }
}

/**
 * Sends the start command for a file already on the device, then confirms it.
 *
 * `remotePath` is relative to the SD-card root — the same path the FTPS upload
 * wrote and the listing verified.
 */
export async function sendBambuStart(
  printer: PrinterConfig,
  remotePath: string,
  options: { feed?: Record<string, unknown> | null; plateGcodePath?: string | null } = {}
): Promise<void> {
  requireReady(printer);

  // Pre-flight: refuse before publishing when the device is already saying it
  // cannot do this. A file can be present, size-verified and completely correct
  // on a card the printer can no longer read — "the bytes are there" and "the
  // machine can open them" are different facts, and only the device knows the
  // second one.
  assertBambuCanStart(printer);

  // The filament source was decided and pinned when the start was reserved.
  // Re-checked here against the report as it is NOW: a spool swapped in the
  // seconds between the decision and the send is a refusal with nothing sent,
  // never a quiet switch to whatever happens to be loaded.
  const plan = asFeedPlan(options.feed);
  assertFeedStillValid(printer, plan);

  const { payload, subtaskName } = buildBambuStartPayload(printer, remotePath, plan, options.plateGcodePath ?? null);
  await publishBambuRequest(printer, { print: payload });

  // Ask for a full report immediately so confirmation does not depend on the
  // 30s pushall timer; the device answers a `pushall` within a second or two.
  await requestBambuFullReport(printer).catch(() => undefined);
  await confirmBambuStart(printer, subtaskName);
}

/**
 * Refuses a start the device has already ruled out, naming the physical cause.
 *
 * Both checks read the report the status poll is already maintaining, so this
 * costs no I/O and cannot itself fail. Both raise `definitivelyRejected`, which
 * is the honest classification: nothing was published, so nothing can be
 * printing, and the dispatch may unwind completely instead of holding the
 * printer for a reconciliation that has nothing to reconcile.
 */
export function assertBambuCanStart(printer: PrinterConfig): void {
  const print = getBambuRawPrint(printer.id);
  if (!print) return; // No report yet — the dispatch gate refuses that separately.

  if (parseBambuMediaPresent(print) === false) {
    throw new PrinterCommandError(
      `«${printer.name}» не видит карту MicroSD, с которой запускается печать — ` +
        "вставьте карту и повторите запуск",
      true
    );
  }

  const blocking = startBlockingFaults(parseBambuFaults(print));
  if (blocking.length > 0) {
    throw new PrinterCommandError(describeFault(printer, blocking[0]), true);
  }
}

/** One fault as a sentence an operator can act on, code first. */
function describeFault(printer: PrinterConfig, fault: PrinterFault): string {
  const what = fault.title ?? "ошибка принтера";
  const how = fault.action ? ` ${fault.action}` : "";
  return `«${printer.name}» не может начать печать: ${what} (${fault.code}).${how}`;
}

/**
 * The exact command this start would publish, and the job name it will be
 * confirmed by. Pure — exported so the payload can be asserted in tests without
 * a broker, and so a caller can log precisely what was sent.
 */
export function buildBambuStartPayload(
  printer: PrinterConfig,
  remotePath: string,
  plan: FeedPlan | null = null,
  plateGcodePath: string | null = null
): { payload: Record<string, unknown>; subtaskName: string } {
  // The same normalization the confirmation compares by — derived once, so the
  // name we announce and the name we look for can never drift apart.
  const subtaskName = jobNameStem(remotePath);
  if (plan?.kind === "unresolved") {
    throw new PrinterCommandError(`Источник филамента не определён: ${plan.message}`, true);
  }
  if (!/\.3mf$/i.test(remotePath)) {
    // `gcode_file` carries no mapping at all; with the AMS involved the firmware
    // would pick a spool on its own, which is the defect this module removes.
    if (plan?.kind === "ams") {
      throw new PrinterCommandError(
        "Голый .gcode нельзя запустить через AMS с выбранным лотком — отправьте пакет .gcode.3mf",
        true
      );
    }
    return { payload: gcodeFilePayload(remotePath), subtaskName };
  }
  // The entry the package actually carries. A package this farm built has
  // `plate_1`; an operator's export of plate 2 has `plate_2`, and naming
  // `plate_1` there would start a plate that is not in the file. Only the
  // plate-entry shape is accepted — the name ends up inside a device command.
  const param = plateGcodePath ?? BAMBU_PLATE_GCODE_PATH;
  if (!PLATE_GCODE_ENTRY.test(param)) {
    throw new PrinterCommandError(`Недопустимая запись G-code в пакете: «${param}»`, true);
  }
  return { payload: projectFilePayload(printer, remotePath, subtaskName, plan, param), subtaskName };
}

/**
 * The `project_file` payload for a plate package.
 *
 * The filament source comes from the pinned {@link FeedPlan} and from nothing
 * else. `ams_mapping` follows the vendor's own client (Bambu Studio): one entry
 * per filament *of the job*, in the job's filament order, each the global tray
 * id (`ams_id × 4 + slot`), `-1` for a filament the plate does not use; it is
 * sent together with `ams_mapping2` (`{ams_id, slot_id}` pairs, 255 unused). The
 * older five-element right-aligned form that used to be sent here put a
 * single-filament job's tray in position 4, i.e. it mapped the job's *fifth*
 * filament and left the one it actually uses unmapped.
 *
 * No plan at all (a caller that predates pinning) is only accepted when the
 * printer reports no AMS — then the external spool is the only path there is.
 */
function projectFilePayload(
  printer: PrinterConfig,
  remotePath: string,
  subtaskName: string,
  plan: FeedPlan | null,
  plateGcodePath: string
): Record<string, unknown> {
  const useAms = plan?.kind === "ams";
  return {
    sequence_id: String(Date.now()),
    command: "project_file",
    param: plateGcodePath,
    // Always "0" for a local print — these identify a cloud job, which this is not.
    project_id: "0",
    profile_id: "0",
    task_id: "0",
    subtask_id: "0",
    subtask_name: subtaskName,
    file: "",
    url: `file:///mnt/sdcard/${remotePath}`,
    md5: "",
    timelapse: false,
    bed_type: "auto",
    // Levelling on, calibration off: a bed mesh is cheap insurance, while flow and
    // vibration calibration add minutes to every job and are a machine-level
    // setting an operator makes deliberately, not a per-print default.
    bed_leveling: true,
    flow_cali: false,
    vibration_cali: false,
    layer_inspect: false,
    use_ams: useAms,
    ...(plan?.kind === "ams" ? { ams_mapping: plan.mapping, ams_mapping2: plan.mapping2 } : {})
  };
}

/** A plate payload entry as Bambu packages lay it out: `Metadata/plate_<n>.gcode`. */
const PLATE_GCODE_ENTRY = /^Metadata\/plate_[1-9][0-9]{0,2}\.gcode$/;

/** The simpler payload for a bare `.gcode` already on the card. */
function gcodeFilePayload(remotePath: string): Record<string, unknown> {
  return {
    sequence_id: String(Date.now()),
    command: "gcode_file",
    param: `/${remotePath}`
  };
}

/**
 * The printer's feeding options as it reports them now: whether an AMS unit is
 * present and every spool it could draw from (AMS slots and the external
 * holder). `null` trays when the device has sent no report at all — which is not
 * "no AMS", it is "unknown".
 */
export function liveFeedState(printer: PrinterConfig): { hasAms: boolean | null; trays: FeedTray[] | null } {
  const print = getBambuRawPrint(printer.id);
  if (!print) return { hasAms: null, trays: null };
  return feedStateFromReport(print);
}

/** The same, from a raw report — pure, for the status mapping and tests. */
export function feedStateFromReport(print: Record<string, unknown>): {
  hasAms: boolean;
  trays: FeedTray[];
} {
  const trays = (parseAmsTrays(print) ?? []).map(toFeedTray);
  return { hasAms: trays.some((t) => !t.external), trays };
}

/** An AMS/external tray snapshot as the feed planner reads it. */
export function toFeedTray(tray: AmsTraySnapshot): FeedTray {
  return {
    trayId: tray.tray,
    external: tray.tray === EXTERNAL_SPOOL_TRAY,
    material: tray.material,
    color: tray.color,
    active: tray.active
  };
}

/**
 * Refuses — with nothing published — a start whose pinned feed no longer
 * matches the device, or a start with no pinned feed on a printer that reports
 * an AMS (whose spool would otherwise be picked by nobody).
 */
function assertFeedStillValid(printer: PrinterConfig, plan: FeedPlan | null): void {
  const live = liveFeedState(printer);
  if (!plan) {
    if (live.hasAms === true) {
      throw new PrinterCommandError(
        `«${printer.name}»: источник филамента не выбран — запуск через AMS без сопоставления лотков с материалом задания запрещён`,
        true
      );
    }
    return;
  }
  if (plan.kind === "unresolved") {
    throw new PrinterCommandError(`«${printer.name}»: ${plan.message}`, true);
  }
  if (live.hasAms === null) {
    // No report at all — the AMS slots cannot be confirmed. The external spool
    // needs no confirmation of its own here (the material rule covered it).
    if (plan.kind === "ams") {
      throw new PrinterCommandError(
        `«${printer.name}» не сообщает состояние AMS — выбранные лотки нельзя подтвердить, запуск отменён`,
        true
      );
    }
    return;
  }
  const problem = verifyPinnedFeed(plan, live.trays, live.hasAms);
  if (problem) {
    throw new PrinterCommandError(`«${printer.name}»: ${problem} — запуск отменён, команда не отправлялась`, true);
  }
}

/** The pinned plan as it travels through run metadata, validated on the way out. */
function asFeedPlan(raw: Record<string, unknown> | null | undefined): FeedPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind;
  if (kind === "external") return raw as unknown as FeedPlan;
  if (kind === "unresolved") return raw as unknown as FeedPlan;
  if (
    kind === "ams" &&
    Array.isArray(raw.mapping) &&
    raw.mapping.every((v) => Number.isInteger(v)) &&
    Array.isArray(raw.mapping2) &&
    Array.isArray(raw.assignments)
  ) {
    return raw as unknown as FeedPlan;
  }
  throw new PrinterCommandError("Закреплённый источник филамента повреждён — запуск отменён", true);
}

/**
 * Waits for the printer's own report to show the job running.
 *
 * Success requires the device to say so. A timeout is **not** downgraded to
 * success and **not** treated as a refusal — it raises
 * {@link BambuStartUnconfirmedError}, which the dispatch classifies as `unknown`
 * so the run is held for reconciliation rather than retried.
 */
export async function confirmBambuStart(
  printer: PrinterConfig,
  subtaskName: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? START_CONFIRM_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? START_POLL_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const deadline = now() + timeoutMs;
  let lastState = "";
  // Faults already active before the command went out are the printer's standing
  // complaints, not this start's verdict — only a *newly raised* one is evidence
  // about the job we just sent. Without this an old, unacknowledged advisory
  // would fail every subsequent launch on the same machine.
  const preexisting = new Set(
    startBlockingFaults(parseBambuFaults(getBambuRawPrint(printer.id) ?? {})).map((f) => f.code)
  );

  while (now() < deadline) {
    const print = getBambuRawPrint(printer.id);
    if (print) {
      const state = firstText(print.gcode_state).toUpperCase();
      lastState = state || lastState;

      // The device is running our job: done, whatever else it is complaining about.
      if (RUNNING_STATES.has(state) && namesJob(print, subtaskName)) {
        return;
      }

      if (state === "FAILED") {
        throw new PrinterCommandError(
          `Принтер «${printer.name}» отклонил запуск (gcode_state=FAILED)` + describeFaults(print),
          true
        );
      }

      // A fault that blocks starting, raised after the command went out, while
      // the job is demonstrably not running: the start was refused. This is the
      // branch the MicroSD failure needed — the machine sat at IDLE and said so
      // in the only channel that carried the answer.
      const raised = startBlockingFaults(parseBambuFaults(print)).filter(
        (f) => !preexisting.has(f.code)
      );
      if (raised.length > 0) {
        throw new PrinterCommandError(describeFault(printer, raised[0]), true);
      }
    }
    await sleep(intervalMs);
  }

  throw new BambuStartUnconfirmedError(
    `Принтер «${printer.name}» не подтвердил запуск «${subtaskName}» за ${Math.round(timeoutMs / 1000)} с` +
      (lastState ? ` (последнее состояние: ${lastState})` : "") +
      " — состояние запуска неизвестно, проверьте принтер перед повторной попыткой"
  );
}

/**
 * Whether the running job is the one we just started.
 *
 * Without this a print that was *already* running would confirm any start
 * command, which is precisely the false positive that turns "the command was
 * ignored" into "the dispatch succeeded". Bambu reports the job under several
 * field names depending on firmware, so all of them are compared, and the
 * comparison ignores the container extension the device may or may not include.
 */
function namesJob(print: Record<string, unknown>, subtaskName: string): boolean {
  return anyNamesJob(
    [print.subtask_name, print.gcode_file, print.filename, print.task_name].map(firstText),
    subtaskName
  );
}

/** The device's fault codes as it displays them, appended to a refusal message. */
function describeFaults(print: Record<string, unknown>): string {
  const faults = parseBambuFaults(print);
  return faults.length > 0 ? `, код ошибки ${faults.map((f) => f.code).join(", ")}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
