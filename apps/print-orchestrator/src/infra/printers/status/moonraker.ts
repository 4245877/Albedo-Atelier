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
  const query = objects.map((object) => encodeURIComponent(object)).join("&");
  // `configfile=settings` selects only the parsed-settings subtree (which holds
  // `extruder.nozzle_diameter`) rather than the whole raw+parsed config blob.
  // `settings` is a literal Moonraker sub-field spec, so it is not URL-encoded.
  return `${moonrakerBaseUrl(printer)}/printer/objects/query?${query}&configfile=settings`;
}

/**
 * Klipper's configured nozzle diameter, read live from the device's own config
 * via the Moonraker `configfile` object (`settings.extruder.nozzle_diameter`,
 * already type-converted to a number; the raw `config` string is a fallback).
 * This is the printer/slicer *setting*, not a physical sensor — a manual nozzle
 * swap without updating `printer.cfg` leaves it stale (same caveat as Bambu).
 * `null` when the object is absent or malformed — never invented.
 */
export function parseMoonrakerNozzleDiameter(status: Record<string, unknown>): number | null {
  const configfile = isObject(status.configfile) ? status.configfile : null;
  if (!configfile) return null;

  const settings = isObject(configfile.settings) ? configfile.settings : null;
  const config = isObject(configfile.config) ? configfile.config : null;
  const fromSettings = settings && isObject(settings.extruder) ? settings.extruder.nozzle_diameter : null;
  const fromConfig = config && isObject(config.extruder) ? config.extruder.nozzle_diameter : null;

  const diameter = firstFiniteNumber(fromSettings, fromConfig);
  // Guard against a bogus 0/negative slipping through as a real value.
  return diameter !== null && diameter > 0 ? diameter : null;
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
    // Klipper reports cumulative filament extruded this print, in mm. Held until
    // the next print starts, so it is still the final total at the completion poll.
    const filamentUsedMm = toFiniteNumber(printStats.filament_used);

    const stateText = firstText(printStats.state) || null;
    const stateMessage = firstText(printStats.message) || null;
    const mappedStatus = toStatusState(printStats.state);

    // Nozzle diameter comes from Klipper's parsed config (a setting, not a live
    // sensor). The Creality K2 runs Klipper over Moonraker, so this populates for
    // it too — see README "Nozzle & active filament".
    const nozzleDiameterMm = parseMoonrakerNozzleDiameter(status);

    return {
      id: printer.id,
      online: true,
      status: mappedStatus,
      currentFile: firstText(printStats.filename) || null,
      progressPct,
      remainingMinutes: estimateRemainingMinutes(progressPct, elapsedSec),
      filamentUsedMm,
      // Moonraker/Klipper has no AMS concept here; filament is one loaded reel.
      amsTrays: null,
      nozzleDiameterMm,
      // Klipper has no standard "nozzle type" field, and the active filament
      // material is not in these core objects (Creality's CFS `box` object /
      // sliced-file metadata are the upgrade path — see README). Left null so the
      // view falls back to the configured nozzle type / material.
      nozzleType: null,
      activeFilament: null,
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

/**
 * Starts a print of a file already present on the printer's virtual SD card via
 * Moonraker's `/printer/print/start?filename=`. The file must exist on the
 * device (no remote upload here); a wrong name surfaces as a Moonraker error.
 */
export async function sendMoonrakerStart(printer: PrinterConfig, filename: string): Promise<void> {
  const name = filename.trim();
  if (!name) {
    throw new PrinterCommandError("Не задано имя файла для запуска печати");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MOONRAKER_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${moonrakerBaseUrl(printer)}/printer/print/start?filename=${encodeURIComponent(name)}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: moonrakerHeaders(printer)
      }
    );
    if (!res.ok) {
      throw new PrinterCommandError(
        res.status === 404
          ? `Moonraker не нашёл файл «${name}» на принтере`
          : `Moonraker HTTP ${res.status}`
      );
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
