import type { PrinterConfig } from "../config";
import {
  estimateRemainingMinutes,
  firstText,
  firstFiniteNumber,
  isObject,
  makeOfflineStatus,
  roundOrNull,
  toFiniteNumber,
  toStatusState
} from "./mapper";
import { PrinterCommandError, type PrinterCommand, type PrinterLiveStatus } from "./types";

const MOONRAKER_TIMEOUT_MS = 3500;
const MOONRAKER_STATUS_OBJECTS = [
  "print_stats",
  "virtual_sdcard",
  "display_status",
  "webhooks",
  "extruder",
  "heater_bed"
];

function moonrakerBaseUrl(printer: PrinterConfig): string {
  return `http://${printer.host}:${printer.port ?? 80}`;
}

function moonrakerHeaders(printer: PrinterConfig): Record<string, string> | undefined {
  return printer.apiKey ? { "X-Api-Key": printer.apiKey } : undefined;
}

function moonrakerStatusUrl(printer: PrinterConfig): string {
  const objects = [...MOONRAKER_STATUS_OBJECTS];
  if (printer.light.enabled && printer.light.statusObject) {
    objects.push(printer.light.statusObject);
  }
  return `${moonrakerBaseUrl(printer)}/printer/objects/query?${objects
    .map((object) => encodeURIComponent(object))
    .join("&")}`;
}

function readMoonrakerLightState(
  printer: PrinterConfig,
  status: Record<string, unknown>
): boolean | null {
  if (!printer.light.enabled || !printer.light.statusObject) return null;

  const object = status[printer.light.statusObject];
  if (!isObject(object)) return null;

  const rawValue = object[printer.light.statusField];
  const numericValue = toFiniteNumber(rawValue);
  if (numericValue !== null) return numericValue > 0;

  const textValue = firstText(rawValue).toLowerCase();
  if (["on", "true", "enabled", "1"].includes(textValue)) return true;
  if (["off", "false", "disabled", "0"].includes(textValue)) return false;
  return null;
}

export async function getMoonrakerStatus(printer: PrinterConfig): Promise<PrinterLiveStatus> {
  const url = moonrakerStatusUrl(printer);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MOONRAKER_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: moonrakerHeaders(printer)
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
      light: readMoonrakerLightState(printer, status),
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

export async function sendMoonrakerCommand(
  printer: PrinterConfig,
  command: PrinterCommand
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MOONRAKER_TIMEOUT_MS);
  try {
    const res = await fetch(`${moonrakerBaseUrl(printer)}/printer/print/${command}`, {
      method: "POST",
      signal: controller.signal,
      headers: moonrakerHeaders(printer)
    });
    if (!res.ok) {
      throw new PrinterCommandError(`Moonraker HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendMoonrakerLightCommand(
  printer: PrinterConfig,
  on: boolean
): Promise<void> {
  const script = on ? printer.light.onGcode : printer.light.offGcode;
  if (!script) {
    throw new PrinterCommandError(`Moonraker light command is not configured for ${printer.name}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MOONRAKER_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${moonrakerBaseUrl(printer)}/printer/gcode/script?script=${encodeURIComponent(script)}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: moonrakerHeaders(printer)
      }
    );
    if (!res.ok) {
      throw new PrinterCommandError(`Moonraker HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
