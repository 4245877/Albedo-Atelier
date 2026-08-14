import mqtt from "mqtt";

import { isObject } from "../../../shared/isObject";
import type { PrinterConfig } from "../config";
import { parseBambuFaults, parseBambuMediaPresent } from "./bambuFaults";
import { parseAmsTrays, resolveActiveFilament } from "./bambuUsage";
import {
  firstFiniteNumber,
  firstText,
  makeOfflineStatus,
  roundOrNull,
  toStatusState
} from "./mapper";
import { PrinterCommandError, type PrinterCommand, type PrinterLiveStatus } from "./types";

const bambuCache = new Map<string, PrinterLiveStatus>();
// Last known *raw* Bambu print payload, merged across partial MQTT reports.
const bambuRawPrint = new Map<string, Record<string, unknown>>();
// Last `info.get_version` reply — the device's own firmware/module report.
const bambuDeviceInfo = new Map<string, Record<string, unknown>>();
const bambuClients = new Map<string, mqtt.MqttClient>();
const bambuPushTimers = new Map<string, ReturnType<typeof setInterval>>();

// Bambu MQTT pushes a full report once (after a `pushall`), then only deltas.
// The A1/P1 series are unreliable at pushing the FINISH state change, so a
// missed delta would leave the cache stuck on "printing". Re-request a full
// report periodically so the current state is always resurfaced.
const BAMBU_PUSHALL_INTERVAL_MS = 30000;

function getBambuMqttErrorMessage(error: Error | string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes("server unavailable")) {
    return `${message}. Включите LAN mode на принтере и проверьте, что он в той же сети.`;
  }
  if (lower.includes("not authorized")) {
    return `${message}. Проверьте Bambu LAN access code (и что serial/accessCode не перепутаны).`;
  }
  if (lower.includes("unacceptable protocol version")) {
    return `${message}. Bambu local MQTT требует MQTT 3.1.1.`;
  }
  return message || "Неизвестная ошибка Bambu MQTT";
}

function getBambuPrintPayload(payload: unknown): Record<string, unknown> | null {
  if (!isObject(payload)) return null;
  if (isObject(payload.print)) return payload.print;
  if ("gcode_state" in payload || "mc_percent" in payload || "nozzle_temper" in payload) {
    return payload;
  }
  return null;
}

/**
 * The `info.get_version` reply, if this message is one.
 *
 * Bambu answers the request on the same `report` topic the status arrives on,
 * as `{"info":{"command":"get_version","module":[…]}}`. Until now every non-`print`
 * message was dropped, so the device's firmware and module list — the only
 * identity the LAN protocol offers — never reached the service.
 */
function getBambuInfoPayload(payload: unknown): Record<string, unknown> | null {
  if (!isObject(payload) || !isObject(payload.info)) return null;
  const info = payload.info;
  return Array.isArray(info.module) ? info : null;
}

/** The cached `info.get_version` reply for a printer, or null before one arrives. */
export function getBambuDeviceInfo(printerId: string): Record<string, unknown> | null {
  return bambuDeviceInfo.get(printerId) ?? null;
}

/** The cached merged `print` payload — the source of the AMS/nozzle facts. */
export function getBambuRawPrint(printerId: string): Record<string, unknown> | null {
  return bambuRawPrint.get(printerId) ?? null;
}

function bambuPrintIdentity(print: Record<string, unknown>): string | null {
  return (
    firstText(print.subtask_id, print.subtask_name, print.gcode_file, print.filename, print.task_name) ||
    null
  );
}

function readBambuLightState(
  printer: PrinterConfig,
  print: Record<string, unknown>
): boolean | null {
  const reports = print.lights_report;
  if (!Array.isArray(reports)) return null;

  const wantedNode = printer.light.bambuNode.toLowerCase();
  for (const report of reports) {
    if (!isObject(report)) continue;

    const node = firstText(report.node, report.led_node, report.name).toLowerCase();
    if (node && node !== wantedNode) continue;

    const mode = firstText(report.mode, report.led_mode, report.state).toLowerCase();
    if (["on", "true", "1"].includes(mode)) return true;
    if (["off", "false", "0"].includes(mode)) return false;
  }
  return null;
}

/**
 * Fields that describe the **printer**, not the job it happens to be running.
 *
 * They survive the reset below, because a new subtask changes nothing about the
 * hardware. Leaving `nozzle_diameter`/`nozzle_type` out of this list was a real
 * defect with a confusing signature: the delta announcing a new job carries no
 * nozzle fields, so starting a print made the machine's own nozzle *unknown* for
 * the ~30s until the next `pushall`. That window is exactly the launch window,
 * so every start raced against a `printer_nozzle_unknown` review it had caused
 * itself — and because hardware discovery reads this same cache and replaces its
 * fact set wholesale, the loss was persisted rather than merely transient.
 */
const PRINTER_SCOPED_FIELDS = ["ams", "vt_tray", "nozzle_diameter", "nozzle_type"] as const;

// Bambu MQTT reports are partial deltas; merge them into the last full state so
// the status is always built from a complete snapshot. Reset when a different
// print starts so a previous job's fields can't leak into the next one — except
// the printer-scoped blocks above, which describe the machine rather than the
// job and which the announcing delta does not resend.
export function mergeBambuRawPrint(
  printerId: string,
  print: Record<string, unknown>
): Record<string, unknown> {
  const previous = bambuRawPrint.get(printerId);
  const nextId = bambuPrintIdentity(print);
  const prevId = previous ? bambuPrintIdentity(previous) : null;
  const startedNewPrint = nextId !== null && prevId !== null && nextId !== prevId;

  if (startedNewPrint) {
    bambuCache.delete(printerId);
  }

  const base: Record<string, unknown> = startedNewPrint ? {} : { ...(previous ?? {}) };
  if (startedNewPrint && previous) {
    for (const field of PRINTER_SCOPED_FIELDS) {
      if (field in previous) base[field] = previous[field];
    }
  }

  const merged = { ...base, ...print };
  bambuRawPrint.set(printerId, merged);
  return merged;
}

export function buildBambuStatus(printer: PrinterConfig, payload: unknown): PrinterLiveStatus | null {
  const print = getBambuPrintPayload(payload);
  if (!print) return null;

  const progressPct = firstFiniteNumber(print.mc_percent, print.progress, print.print_progress);
  const remainingMinutes = firstFiniteNumber(print.mc_remaining_time, print.remaining_time);
  // `nozzle_diameter` is a printer/slicer setting (not a physical sensor); a
  // manual nozzle swap without a settings update leaves it stale — see README.
  const nozzleDiameterMm = firstFiniteNumber(print.nozzle_diameter);
  const nozzleType = firstText(print.nozzle_type) || null;
  const amsTrays = parseAmsTrays(print);
  const activeFilament = resolveActiveFilament(print, amsTrays);
  const nozzleTemp = firstFiniteNumber(print.nozzle_temper, print.nozzle_temperature);
  const nozzleTarget = firstFiniteNumber(print.nozzle_target_temper);
  const bedTemp = firstFiniteNumber(print.bed_temper, print.bed_temperature);
  const bedTarget = firstFiniteNumber(print.bed_target_temper);
  const chamberTemp = firstFiniteNumber(print.chamber_temper);
  const light = readBambuLightState(printer, print);

  const rawState = firstText(print.gcode_state, print.print_status, print.status, print.state);
  const printErrorCode = firstFiniteNumber(print.print_error, print.mc_print_error_code);
  const currentFile = firstText(print.subtask_name, print.gcode_file, print.filename, print.task_name);

  if (
    !rawState &&
    !currentFile &&
    progressPct === null &&
    remainingMinutes === null &&
    nozzleTemp === null &&
    bedTemp === null &&
    light === null
  ) {
    return null;
  }

  // A non-zero print_error routinely accompanies a normal PAUSE and can linger
  // after a job ends, so it must not override the device's own paused/idle
  // state — a real failure arrives as gcode_state FAILED anyway. What the code
  // *does* do is travel on in `faults`, where a refusal that leaves the machine
  // sitting at IDLE is still visible to the launch path.
  const baseStatus = toStatusState(rawState);
  const hasErrorCode = printErrorCode !== null && printErrorCode > 0;
  const isError =
    baseStatus === "error" || (hasErrorCode && baseStatus !== "paused" && baseStatus !== "idle");
  const faults = parseBambuFaults(print);

  return {
    id: printer.id,
    online: true,
    status: isError ? "error" : baseStatus,
    currentFile: currentFile || null,
    progressPct: roundOrNull(progressPct),
    remainingMinutes: roundOrNull(remainingMinutes),
    // Bambu MQTT does not expose grams/length consumed (it lives in slicer
    // metadata). Filament is instead attributed per AMS tray at completion from
    // the drop in each tray's `remain` estimate — see bambuUsage.ts.
    filamentUsedMm: null,
    amsTrays,
    nozzleDiameterMm,
    nozzleType,
    activeFilament,
    nozzleTemp: roundOrNull(nozzleTemp),
    nozzleTarget: roundOrNull(nozzleTarget),
    bedTemp: roundOrNull(bedTemp),
    bedTarget: roundOrNull(bedTarget),
    chamberTemp: roundOrNull(chamberTemp),
    light,
    stateText: rawState || null,
    stateMessage: null,
    faults,
    mediaPresent: parseBambuMediaPresent(print),
    // The device's own code, not a paraphrase of it: `0500-C010` is what the
    // printer's screen shows and what the operator can act on, where the raw
    // decimal register was a number that appeared nowhere else in their world.
    error: isError
      ? faults.length > 0
        ? `Bambu сообщил об ошибке печати (${faults.map((f) => f.code).join(", ")})`
        : "Bambu сообщил об ошибке печати"
      : null,
    updatedAt: new Date().toISOString()
  };
}

export function mergeBambuStatus(
  previous: PrinterLiveStatus | undefined,
  next: PrinterLiveStatus
): PrinterLiveStatus {
  if (!previous || !previous.online || !next.online) return next;

  return {
    ...previous,
    ...next,
    status: next.status === "unknown" ? previous.status : next.status,
    currentFile: next.currentFile ?? previous.currentFile,
    progressPct: next.progressPct ?? previous.progressPct,
    remainingMinutes: next.remainingMinutes ?? previous.remainingMinutes,
    amsTrays: next.amsTrays ?? previous.amsTrays,
    // A partial delta may omit the nozzle setting or the active tray; keep the
    // last known value so the view doesn't flicker to "unknown".
    nozzleDiameterMm: next.nozzleDiameterMm ?? previous.nozzleDiameterMm,
    nozzleType: next.nozzleType ?? previous.nozzleType,
    activeFilament: next.activeFilament ?? previous.activeFilament,
    nozzleTemp: next.nozzleTemp ?? previous.nozzleTemp,
    nozzleTarget: next.nozzleTarget ?? previous.nozzleTarget,
    bedTemp: next.bedTemp ?? previous.bedTemp,
    bedTarget: next.bedTarget ?? previous.bedTarget,
    chamberTemp: next.chamberTemp ?? previous.chamberTemp,
    light: next.light ?? previous.light,
    // Faults are computed from the *merged* raw report, so `next` already
    // reflects everything the device has said and an empty list is the device
    // clearing them — never a delta that merely omitted the register.
    faults: next.faults,
    mediaPresent: next.mediaPresent ?? previous.mediaPresent,
    error: next.error,
    updatedAt: next.updatedAt
  };
}

function bambuRequestTopic(printer: PrinterConfig): string {
  return `device/${printer.serial}/request`;
}

/**
 * Publishes one MQTT message and waits for the broker to accept it, so a failed
 * publish surfaces as a real error instead of a silent no-op that still lets the
 * API report success. Rejects with a {@link PrinterCommandError}.
 */
function publishRequest(
  client: mqtt.MqttClient,
  printer: PrinterConfig,
  payload: Record<string, unknown>
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(bambuRequestTopic(printer), JSON.stringify(payload), (error) => {
      if (error) {
        reject(new PrinterCommandError(`Не удалось отправить команду Bambu: ${error.message}`));
      } else {
        resolve();
      }
    });
  });
}

function ensureBambuClient(printer: PrinterConfig): void {
  if (!printer.serial || !printer.accessCode) {
    bambuCache.set(
      printer.id,
      makeOfflineStatus(printer, "Bambu serial/accessCode не настроены")
    );
    return;
  }

  if (bambuClients.has(printer.id)) return;

  // Bambu's local MQTT uses a per-printer self-signed certificate with no CA to
  // verify against, so `rejectUnauthorized: false` is required to connect at all
  // — verification would need certificate pinning per device. Because that
  // disables TLS authentication entirely, it is an EXPLICIT OPT-IN: the
  // per-printer `allowInsecureTls: true` in printers.json, or the global
  // `BAMBU_ALLOW_INSECURE_TLS=1`. Without it the adapter refuses honestly.
  const insecureAllowed =
    printer.allowInsecureTls === true || process.env.BAMBU_ALLOW_INSECURE_TLS === "1";
  if (!insecureAllowed) {
    bambuCache.set(
      printer.id,
      makeOfflineStatus(
        printer,
        "Bambu LAN MQTT требует TLS без проверки сертификата — подтвердите это явно " +
          "(allowInsecureTls: true у принтера или BAMBU_ALLOW_INSECURE_TLS=1) на изолированном сегменте сети"
      )
    );
    return;
  }

  const port = printer.port ?? 8883;
  const client = mqtt.connect(`mqtts://${printer.host}:${port}`, {
    username: "bblp",
    password: printer.accessCode,
    rejectUnauthorized: false,
    connectTimeout: 3500,
    reconnectPeriod: 5000
  });

  const reportTopic = `device/${printer.serial}/report`;
  const requestFullReport = () => {
    client.publish(
      bambuRequestTopic(printer),
      JSON.stringify({ pushing: { sequence_id: String(Date.now()), command: "pushall" } })
    );
  };
  // The device's identity (firmware, module list) never changes while the
  // connection lives, so it is asked for once per connect rather than on the
  // pushall timer. A firmware update reconnects the client, which re-asks.
  const requestDeviceInfo = () => {
    client.publish(
      bambuRequestTopic(printer),
      JSON.stringify({ info: { sequence_id: String(Date.now()), command: "get_version" } })
    );
  };

  client.on("connect", () => {
    client.subscribe(reportTopic);
    requestFullReport();
    requestDeviceInfo();
  });

  const pushTimer = setInterval(() => {
    if (client.connected) requestFullReport();
  }, BAMBU_PUSHALL_INTERVAL_MS);
  pushTimer.unref?.();
  bambuPushTimers.set(printer.id, pushTimer);

  client.on("message", (_topic, payload) => {
    try {
      const json = JSON.parse(payload.toString());

      const info = getBambuInfoPayload(json);
      if (info) {
        bambuDeviceInfo.set(printer.id, info);
        return;
      }

      const print = getBambuPrintPayload(json);
      if (!print) return;

      const merged = mergeBambuRawPrint(printer.id, print);
      const status = buildBambuStatus(printer, { print: merged });
      if (!status) return;

      bambuCache.set(printer.id, mergeBambuStatus(bambuCache.get(printer.id), status));
    } catch {
      // ignore bad mqtt payload
    }
  });

  client.on("error", (error) => {
    bambuCache.set(printer.id, makeOfflineStatus(printer, getBambuMqttErrorMessage(error)));
  });

  bambuClients.set(printer.id, client);
}

export function getBambuStatus(printer: PrinterConfig): PrinterLiveStatus {
  ensureBambuClient(printer);

  const cached = bambuCache.get(printer.id);
  if (cached) return cached;

  return {
    ...makeOfflineStatus(printer, "Ожидание первого статуса по Bambu MQTT"),
    status: "unknown"
  };
}

/**
 * Publishes one arbitrary request payload on the printer's MQTT request topic,
 * over the SAME persistent client the status poll maintains.
 *
 * Exported for the start command (`bambuStart.ts`), which must not open a second
 * connection: Bambu accepts very few concurrent sessions, and a start issued on
 * a private client would also be invisible to the status cache that has to
 * confirm it. Rejects with {@link PrinterCommandError} when no live connection
 * exists, so a start is never reported as sent over a dead socket.
 */
export async function publishBambuRequest(
  printer: PrinterConfig,
  payload: Record<string, unknown>
): Promise<void> {
  // Make sure the persistent client exists (and the credentials/TLS opt-in are
  // satisfied) before deciding there is nothing to publish on.
  ensureBambuClient(printer);
  const client = bambuClients.get(printer.id);
  if (!client || !client.connected) {
    throw new PrinterCommandError(
      `Нет активного MQTT-подключения к «${printer.name}» — команда не отправлена`
    );
  }
  await publishRequest(client, printer, payload);
}

/** Asks the device for a full status report; best-effort, used to speed up confirmation. */
export async function requestBambuFullReport(printer: PrinterConfig): Promise<void> {
  await publishBambuRequest(printer, {
    pushing: { sequence_id: String(Date.now()), command: "pushall" }
  });
}

export async function sendBambuCommand(
  printer: PrinterConfig,
  command: PrinterCommand
): Promise<void> {
  const client = bambuClients.get(printer.id);
  if (!client || !client.connected) {
    throw new PrinterCommandError("Нет активного MQTT-подключения к принтеру");
  }
  const bambuCommand = command === "cancel" ? "stop" : command;
  await publishRequest(client, printer, {
    print: { sequence_id: String(Date.now()), command: bambuCommand, param: "" }
  });
}

export async function sendBambuLightCommand(printer: PrinterConfig, on: boolean): Promise<void> {
  const client = bambuClients.get(printer.id);
  if (!client || !client.connected) {
    throw new PrinterCommandError("Нет активного MQTT-подключения к принтеру");
  }

  await publishRequest(client, printer, {
    system: {
      sequence_id: String(Date.now()),
      command: "ledctrl",
      led_node: printer.light.bambuNode,
      led_mode: on ? "on" : "off"
    }
  });
  // Nudge a fresh full report so the new light state resurfaces promptly; this is
  // best-effort and must not fail the command if the broker drops it.
  await publishRequest(client, printer, {
    pushing: { sequence_id: String(Date.now()), command: "pushall" }
  }).catch(() => {});
}

/**
 * Closes the MQTT connection to ONE printer and forgets its cached state.
 *
 * Called when a printer's credentials or endpoint change: the client is
 * authenticated with the old access code and keeps publishing a plausible
 * status, so leaving it open would make a fixed printer look broken (or, worse,
 * a broken one look fine) until the service restarts. The next poll re-opens the
 * connection from the current config.
 */
export function dropBambuConnection(printerId: string): void {
  const client = bambuClients.get(printerId);
  if (client) {
    try {
      client.end(true);
    } catch {
      // ignore — the socket is being discarded either way
    }
    bambuClients.delete(printerId);
  }
  const timer = bambuPushTimers.get(printerId);
  if (timer) {
    clearInterval(timer);
    bambuPushTimers.delete(printerId);
  }
  bambuCache.delete(printerId);
  bambuRawPrint.delete(printerId);
  bambuDeviceInfo.delete(printerId);
}

/** Closes all persistent Bambu MQTT connections and clears cached state. */
export function shutdownBambuConnections(): void {
  for (const [printerId, client] of bambuClients) {
    try {
      client.end(true);
    } catch {
      // ignore
    }
    const timer = bambuPushTimers.get(printerId);
    if (timer) clearInterval(timer);
  }
  bambuClients.clear();
  bambuPushTimers.clear();
  bambuCache.clear();
  bambuRawPrint.clear();
  bambuDeviceInfo.clear();
}
