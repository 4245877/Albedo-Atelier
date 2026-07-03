import mqtt from "mqtt";

import type { PrinterConfig } from "../config";
import {
  firstFiniteNumber,
  firstText,
  isObject,
  makeOfflineStatus,
  roundOrNull,
  toStatusState
} from "./mapper";
import { PrinterCommandError, type PrinterCommand, type PrinterLiveStatus } from "./types";

const bambuCache = new Map<string, PrinterLiveStatus>();
// Last known *raw* Bambu print payload, merged across partial MQTT reports.
const bambuRawPrint = new Map<string, Record<string, unknown>>();
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

// Bambu MQTT reports are partial deltas; merge them into the last full state so
// the status is always built from a complete snapshot. Reset when a different
// print starts so a previous job's fields can't leak into the next one.
function mergeBambuRawPrint(
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

  const merged = { ...(startedNewPrint ? {} : previous ?? {}), ...print };
  bambuRawPrint.set(printerId, merged);
  return merged;
}

function buildBambuStatus(printer: PrinterConfig, payload: unknown): PrinterLiveStatus | null {
  const print = getBambuPrintPayload(payload);
  if (!print) return null;

  const progressPct = firstFiniteNumber(print.mc_percent, print.progress, print.print_progress);
  const remainingMinutes = firstFiniteNumber(print.mc_remaining_time, print.remaining_time);
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
  // state — a real failure arrives as gcode_state FAILED anyway.
  const baseStatus = toStatusState(rawState);
  const hasErrorCode = printErrorCode !== null && printErrorCode > 0;
  const isError =
    baseStatus === "error" || (hasErrorCode && baseStatus !== "paused" && baseStatus !== "idle");

  return {
    id: printer.id,
    online: true,
    status: isError ? "error" : baseStatus,
    currentFile: currentFile || null,
    progressPct: roundOrNull(progressPct),
    remainingMinutes: roundOrNull(remainingMinutes),
    // Bambu MQTT does not expose grams/length consumed (it lives in slicer metadata).
    filamentUsedMm: null,
    nozzleTemp: roundOrNull(nozzleTemp),
    nozzleTarget: roundOrNull(nozzleTarget),
    bedTemp: roundOrNull(bedTemp),
    bedTarget: roundOrNull(bedTarget),
    chamberTemp: roundOrNull(chamberTemp),
    light,
    stateText: rawState || null,
    stateMessage: null,
    error: isError
      ? hasErrorCode
        ? `Bambu сообщил об ошибке печати (код ${printErrorCode})`
        : "Bambu сообщил об ошибке печати"
      : null,
    updatedAt: new Date().toISOString()
  };
}

function mergeBambuStatus(
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
    nozzleTemp: next.nozzleTemp ?? previous.nozzleTemp,
    nozzleTarget: next.nozzleTarget ?? previous.nozzleTarget,
    bedTemp: next.bedTemp ?? previous.bedTemp,
    bedTarget: next.bedTarget ?? previous.bedTarget,
    chamberTemp: next.chamberTemp ?? previous.chamberTemp,
    light: next.light ?? previous.light,
    error: next.error,
    updatedAt: next.updatedAt
  };
}

function bambuRequestTopic(printer: PrinterConfig): string {
  return `device/${printer.serial}/request`;
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

  client.on("connect", () => {
    client.subscribe(reportTopic);
    requestFullReport();
  });

  const pushTimer = setInterval(() => {
    if (client.connected) requestFullReport();
  }, BAMBU_PUSHALL_INTERVAL_MS);
  pushTimer.unref?.();
  bambuPushTimers.set(printer.id, pushTimer);

  client.on("message", (_topic, payload) => {
    try {
      const json = JSON.parse(payload.toString());
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

export function sendBambuCommand(printer: PrinterConfig, command: PrinterCommand): void {
  const client = bambuClients.get(printer.id);
  if (!client || !client.connected) {
    throw new PrinterCommandError("Нет активного MQTT-подключения к принтеру");
  }
  const bambuCommand = command === "cancel" ? "stop" : command;
  client.publish(
    bambuRequestTopic(printer),
    JSON.stringify({
      print: { sequence_id: String(Date.now()), command: bambuCommand, param: "" }
    })
  );
}

export function sendBambuLightCommand(printer: PrinterConfig, on: boolean): void {
  const client = bambuClients.get(printer.id);
  if (!client || !client.connected) {
    throw new PrinterCommandError("Нет активного MQTT-подключения к принтеру");
  }

  client.publish(
    bambuRequestTopic(printer),
    JSON.stringify({
      system: {
        sequence_id: String(Date.now()),
        command: "ledctrl",
        led_node: printer.light.bambuNode,
        led_mode: on ? "on" : "off"
      }
    })
  );
  client.publish(
    bambuRequestTopic(printer),
    JSON.stringify({ pushing: { sequence_id: String(Date.now()), command: "pushall" } })
  );
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
}
