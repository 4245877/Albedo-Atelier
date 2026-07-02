import mqtt from "mqtt";
import WebSocket from "ws";

import type { PrinterConfig } from "./config";

/**
 * Live telemetry for one printer, straight from the device. Adapted from
 * apps/fulfillment (`modules/printers/routes.ts`), extended with temperature
 * targets and chamber readings where the device reports them. Every field that
 * a device does not report stays `null` — nothing here is ever invented.
 */
export interface PrinterLiveStatus {
  id: string;
  online: boolean;
  status: "idle" | "printing" | "paused" | "error" | "offline" | "unknown";
  currentFile: string | null;
  progressPct: number | null;
  remainingMinutes: number | null;
  nozzleTemp: number | null;
  nozzleTarget: number | null;
  bedTemp: number | null;
  bedTarget: number | null;
  chamberTemp: number | null;
  /** Raw device state string (e.g. moonraker "complete"/"cancelled"). */
  stateText: string | null;
  /** Human-readable reason (pause reason, error text) when the device gives one. */
  stateMessage: string | null;
  error: string | null;
  updatedAt: string;
}

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
const MOONRAKER_TIMEOUT_MS = 3500;
const CREALITY_TIMEOUT_MS = 2500;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numberValue = toFiniteNumber(value);
    if (numberValue !== null) return numberValue;
  }
  return null;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

export function toStatusState(value: unknown): PrinterLiveStatus["status"] {
  const state = String(value ?? "").toLowerCase();

  if (["printing", "running", "prepare", "preparing", "heating"].includes(state)) {
    return "printing";
  }
  if (["paused", "pause", "pausing"].includes(state)) return "paused";
  // `cancel`/`cancelled` land in "idle": an aborted print is not an error state.
  if (
    ["complete", "standby", "idle", "finished", "finish", "cancel", "cancelled", "canceled"].includes(
      state
    )
  ) {
    return "idle";
  }
  if (["error", "failed", "failure"].includes(state)) return "error";

  return "unknown";
}

function makeOfflineStatus(printer: PrinterConfig, error: string): PrinterLiveStatus {
  return {
    id: printer.id,
    online: false,
    status: "offline",
    currentFile: null,
    progressPct: null,
    remainingMinutes: null,
    nozzleTemp: null,
    nozzleTarget: null,
    bedTemp: null,
    bedTarget: null,
    chamberTemp: null,
    stateText: null,
    stateMessage: null,
    error,
    updatedAt: new Date().toISOString()
  };
}

function estimateRemainingMinutes(
  progressPct: number | null,
  elapsedSec: number | null
): number | null {
  if (!progressPct || progressPct <= 0 || !elapsedSec) return null;
  const totalSec = elapsedSec / (progressPct / 100);
  return Math.round(Math.max(0, totalSec - elapsedSec) / 60);
}

/* ── Moonraker (Klipper) ─────────────────────────────────────────────────── */

function moonrakerBaseUrl(printer: PrinterConfig): string {
  return `http://${printer.host}:${printer.port ?? 80}`;
}

async function getMoonrakerStatus(printer: PrinterConfig): Promise<PrinterLiveStatus> {
  const url =
    `${moonrakerBaseUrl(printer)}/printer/objects/query` +
    `?print_stats&virtual_sdcard&display_status&webhooks&extruder&heater_bed`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MOONRAKER_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: printer.apiKey ? { "X-Api-Key": printer.apiKey } : undefined
    });
    if (!res.ok) {
      throw new Error(`Moonraker HTTP ${res.status}`);
    }

    const json = (await res.json()) as { result?: { status?: Record<string, unknown> } };
    const status = json?.result?.status ?? {};

    const printStats = isObject(status.print_stats) ? status.print_stats : {};
    const virtualSd = isObject(status.virtual_sdcard) ? status.virtual_sdcard : {};
    const displayStatus = isObject(status.display_status) ? status.display_status : {};
    const webhooks = isObject(status.webhooks) ? status.webhooks : {};
    const extruder = isObject(status.extruder) ? status.extruder : {};
    const bed = isObject(status.heater_bed) ? status.heater_bed : {};

    const progressRatio = firstFiniteNumber(virtualSd.progress, displayStatus.progress);
    const progressPct = progressRatio === null ? null : Math.round(progressRatio * 100);
    const elapsedSec = toFiniteNumber(printStats.print_duration);

    const stateText = firstText(printStats.state) || null;
    const stateMessage = firstText(printStats.message) || null;
    const mappedStatus = toStatusState(printStats.state);

    return {
      id: printer.id,
      online: true,
      status: mappedStatus,
      currentFile: firstText(printStats.filename) || null,
      progressPct,
      remainingMinutes: estimateRemainingMinutes(progressPct, elapsedSec),
      nozzleTemp: roundOrNull(toFiniteNumber(extruder.temperature)),
      nozzleTarget: roundOrNull(toFiniteNumber(extruder.target)),
      bedTemp: roundOrNull(toFiniteNumber(bed.temperature)),
      bedTarget: roundOrNull(toFiniteNumber(bed.target)),
      chamberTemp: null,
      stateText,
      stateMessage,
      error:
        mappedStatus === "error"
          ? stateMessage || firstText(webhooks.state_message) || "Принтер сообщил об ошибке"
          : null,
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    return makeOfflineStatus(
      printer,
      error instanceof Error ? error.message : "Неизвестная ошибка Moonraker"
    );
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Bambu Lab (local MQTT) ──────────────────────────────────────────────── */

export function getBambuMqttErrorMessage(error: Error | string): string {
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

  const rawState = firstText(print.gcode_state, print.print_status, print.status, print.state);
  const printErrorCode = firstFiniteNumber(print.print_error, print.mc_print_error_code);
  const currentFile = firstText(print.subtask_name, print.gcode_file, print.filename, print.task_name);

  if (
    !rawState &&
    !currentFile &&
    progressPct === null &&
    remainingMinutes === null &&
    nozzleTemp === null &&
    bedTemp === null
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
    nozzleTemp: roundOrNull(nozzleTemp),
    nozzleTarget: roundOrNull(nozzleTarget),
    bedTemp: roundOrNull(bedTemp),
    bedTarget: roundOrNull(bedTarget),
    chamberTemp: roundOrNull(chamberTemp),
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

function getBambuStatus(printer: PrinterConfig): PrinterLiveStatus {
  ensureBambuClient(printer);

  const cached = bambuCache.get(printer.id);
  if (cached) return cached;

  return {
    ...makeOfflineStatus(printer, "Ожидание первого статуса по Bambu MQTT"),
    status: "unknown"
  };
}

/* ── Creality (WebSocket) ────────────────────────────────────────────────── */

function normalizeCrealityState(state: unknown): PrinterLiveStatus["status"] {
  const value = String(state ?? "").toLowerCase();

  if (value === "1" || value.includes("print")) return "printing";
  if (value === "5" || value.includes("pause")) return "paused";
  if (value === "0" || value.includes("stop") || value.includes("idle")) return "idle";
  if (value.includes("error") || value.includes("fail")) return "error";

  return "unknown";
}

function getCrealityStatus(printer: PrinterConfig): Promise<PrinterLiveStatus> {
  const url = `ws://${printer.host}:${printer.port ?? 9999}`;

  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let settled = false;

    const finish = (status: PrinterLiveStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws?.close();
      } catch {
        // ignore
      }
      resolve(status);
    };

    const timeout = setTimeout(() => {
      finish(makeOfflineStatus(printer, "Creality WebSocket: таймаут"));
    }, CREALITY_TIMEOUT_MS);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      finish(makeOfflineStatus(printer, err instanceof Error ? err.message : String(err)));
      return;
    }

    ws.on("open", () => {
      try {
        ws?.send(JSON.stringify({ ModeCode: "heart_beat", msg: new Date().toISOString() }));
      } catch {
        // ignore
      }
    });

    ws.on("message", (data) => {
      try {
        const raw = data.toString();
        if (!raw || raw === "ok") return;

        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const progress = toFiniteNumber(parsed.printProgress);
        const mappedStatus = normalizeCrealityState(parsed.state);
        const stateMessage = firstText(parsed.err, parsed.errorMsg) || null;
        const leftSec = toFiniteNumber(parsed.printLeftTime);

        finish({
          id: printer.id,
          online: true,
          status: mappedStatus,
          currentFile: firstText(parsed.printFileName) || null,
          progressPct: progress,
          remainingMinutes: leftSec === null ? null : Math.round(leftSec / 60),
          nozzleTemp: roundOrNull(toFiniteNumber(parsed.nozzleTemp)),
          nozzleTarget: roundOrNull(firstFiniteNumber(parsed.targetNozzleTemp, parsed.nozzleTempTarget)),
          bedTemp: roundOrNull(toFiniteNumber(parsed.bedTemp0)),
          bedTarget: roundOrNull(firstFiniteNumber(parsed.targetBedTemp0, parsed.bedTemp0Target)),
          chamberTemp: null,
          stateText: firstText(parsed.state) || null,
          stateMessage,
          error: mappedStatus === "error" ? stateMessage || "Принтер сообщил об ошибке" : null,
          updatedAt: new Date().toISOString()
        });
      } catch (err) {
        finish(makeOfflineStatus(printer, err instanceof Error ? err.message : String(err)));
      }
    });

    ws.on("error", () => {
      finish(makeOfflineStatus(printer, "Creality WebSocket: ошибка соединения"));
    });

    ws.on("close", () => {
      if (!settled) {
        finish(makeOfflineStatus(printer, "Creality WebSocket: соединение закрыто"));
      }
    });
  });
}

/* ── Public API ──────────────────────────────────────────────────────────── */

export async function getPrinterLiveStatus(printer: PrinterConfig): Promise<PrinterLiveStatus> {
  if (printer.protocol === "moonraker") return getMoonrakerStatus(printer);
  if (printer.protocol === "bambu") return getBambuStatus(printer);
  if (printer.protocol === "creality") return getCrealityStatus(printer);
  return makeOfflineStatus(printer, "Неподдерживаемый протокол принтера");
}

export type PrinterCommand = "pause" | "resume" | "cancel";

export class PrinterCommandError extends Error {}

/**
 * Sends a real control command to the device. Supported: Moonraker HTTP
 * (`/printer/print/*`) and Bambu local MQTT (`print.command`). Creality's
 * WebSocket control protocol is not implemented — that is reported honestly.
 */
export async function sendPrinterCommand(
  printer: PrinterConfig,
  command: PrinterCommand
): Promise<void> {
  if (printer.protocol === "moonraker") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MOONRAKER_TIMEOUT_MS);
    try {
      const res = await fetch(`${moonrakerBaseUrl(printer)}/printer/print/${command}`, {
        method: "POST",
        signal: controller.signal,
        headers: printer.apiKey ? { "X-Api-Key": printer.apiKey } : undefined
      });
      if (!res.ok) {
        throw new PrinterCommandError(`Moonraker HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
    return;
  }

  if (printer.protocol === "bambu") {
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
    return;
  }

  throw new PrinterCommandError(
    `Управление печатью для протокола «${printer.protocol}» пока не поддерживается`
  );
}

/** Closes all persistent device connections (Bambu MQTT clients, timers). */
export function shutdownPrinterConnections(): void {
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
