import { requireReady } from "../capabilities";
import type { PrinterConfig } from "../config";
import { BAMBU_PLATE_GCODE_PATH } from "../files/bambuPackage";
import { getBambuRawPrint, publishBambuRequest, requestBambuFullReport } from "./bambu";
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
const START_CONFIRM_TIMEOUT_MS = 45_000;
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
export async function sendBambuStart(printer: PrinterConfig, remotePath: string): Promise<void> {
  requireReady(printer);

  // Pre-flight: refuse before publishing when the device is already saying it
  // cannot do this. A file can be present, size-verified and completely correct
  // on a card the printer can no longer read — "the bytes are there" and "the
  // machine can open them" are different facts, and only the device knows the
  // second one.
  assertBambuCanStart(printer);

  const { payload, subtaskName } = buildBambuStartPayload(printer, remotePath);
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
  remotePath: string
): { payload: Record<string, unknown>; subtaskName: string } {
  const subtaskName = (remotePath.split("/").pop() ?? remotePath).replace(
    /\.(gcode\.3mf|3mf|gcode)$/i,
    ""
  );
  const payload = /\.3mf$/i.test(remotePath)
    ? projectFilePayload(printer, remotePath, subtaskName)
    : gcodeFilePayload(remotePath);
  return { payload, subtaskName };
}

/**
 * The `project_file` payload for a plate package.
 *
 * `use_ams` is driven by what the device *currently reports*, not by what the
 * model number implies: this farm's A1 Combo reports zero AMS units and feeds
 * from the external spool, and telling the firmware to use a non-existent AMS is
 * a refusal (or worse, a load attempt against an empty slot). When an AMS is
 * present the mapping is the documented five-slot reverse-indexed array with the
 * single active tray in the last position, `-1` meaning unused.
 */
function projectFilePayload(
  printer: PrinterConfig,
  remotePath: string,
  subtaskName: string
): Record<string, unknown> {
  const ams = resolveAmsUse(printer);
  return {
    sequence_id: String(Date.now()),
    command: "project_file",
    param: BAMBU_PLATE_GCODE_PATH,
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
    use_ams: ams.use,
    ...(ams.use ? { ams_mapping: ams.mapping } : {})
  };
}

/** The simpler payload for a bare `.gcode` already on the card. */
function gcodeFilePayload(remotePath: string): Record<string, unknown> {
  return {
    sequence_id: String(Date.now()),
    command: "gcode_file",
    param: `/${remotePath}`
  };
}

/**
 * Whether to print through the AMS, and the slot mapping if so — read from live
 * telemetry, never assumed from the printer's model name.
 */
export function resolveAmsUse(printer: PrinterConfig): { use: boolean; mapping: number[] } {
  const print = getBambuRawPrint(printer.id);
  const units = print && isRecord(print.ams) && Array.isArray(print.ams.ams) ? print.ams.ams : [];
  if (units.length === 0) return { use: false, mapping: [] };

  // First loaded tray wins; a multi-material mapping is a scheduling decision this
  // farm does not make yet, and inventing one would silently print in the wrong
  // filament.
  let slot = 0;
  for (const unit of units) {
    if (!isRecord(unit) || !Array.isArray(unit.tray)) continue;
    const index = unit.tray.findIndex((t) => isRecord(t) && firstText(t.tray_type).length > 0);
    if (index >= 0) {
      slot = index;
      break;
    }
  }
  return { use: true, mapping: [-1, -1, -1, -1, slot] };
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
  const wanted = normalizeJobName(subtaskName);
  if (!wanted) return false;
  for (const field of [print.subtask_name, print.gcode_file, print.filename, print.task_name]) {
    const reported = normalizeJobName(firstText(field));
    if (reported && (reported === wanted || reported.includes(wanted) || wanted.includes(reported))) {
      return true;
    }
  }
  return false;
}

function normalizeJobName(value: string): string {
  return (value.split("/").pop() ?? value)
    .replace(/\.(gcode\.3mf|3mf|gcode)$/i, "")
    .trim()
    .toLowerCase();
}

/** The device's fault codes as it displays them, appended to a refusal message. */
function describeFaults(print: Record<string, unknown>): string {
  const faults = parseBambuFaults(print);
  return faults.length > 0 ? `, код ошибки ${faults.map((f) => f.code).join(", ")}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
