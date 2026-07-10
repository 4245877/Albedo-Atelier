import { fetchWithTimeout } from "../../../shared/fetchWithTimeout";
import { isObject } from "../../../shared/isObject";
import type { PrinterConfig } from "../config";
import {
  estimateRemainingMinutes,
  firstText,
  firstFiniteNumber,
  makeOfflineStatus,
  roundOrNull,
  toFiniteNumber,
  toStatusState
} from "./mapper";
import {
  PrinterCommandError,
  type ActiveFilament,
  type PrinterCommand,
  type PrinterLiveStatus
} from "./types";

const MOONRAKER_TIMEOUT_MS = 3500;
const MOONRAKER_STATUS_OBJECTS = [
  "print_stats",
  "virtual_sdcard",
  "display_status",
  "webhooks",
  "extruder",
  "heater_bed"
];

export function moonrakerBaseUrl(printer: PrinterConfig): string {
  return `http://${printer.host}:${printer.port ?? 80}`;
}

export function moonrakerHeaders(printer: PrinterConfig): Record<string, string> | undefined {
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

/**
 * The first concrete filament material from a slicer metadata field. Slicers
 * emit `filament_type` either as a single string ("PLA"), a multi-material list
 * ("PLA;PETG" / "PLA,PETG"), or an array. We surface the first non-empty token —
 * a print's *primary* material — rather than guessing which slot is feeding.
 * `-1`/`""`/`unknown` (what an empty Creality slot reports) yields null.
 */
function firstFilamentToken(value: unknown): string | null {
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    for (const token of firstText(entry).split(/[;,]/)) {
      const material = token.trim();
      if (material && material !== "-1" && material.toLowerCase() !== "unknown") return material;
    }
  }
  return null;
}

/** First valid `#RRGGBB` from a slicer `filament_colors` array (or single value); null otherwise. */
function firstHexColor(value: unknown): string | null {
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(firstText(entry));
    if (match) return `#${match[1].toUpperCase()}`;
  }
  return null;
}

/**
 * The active filament for the K2 from the *current job's sliced metadata*
 * (`/server/files/metadata` — `filament_type` / `filament_colors`). This is the
 * material the slicer was told to use, not a physical sensor reading, and it
 * only exists while a sliced file is loaded — but it is the one honest live
 * filament signal Moonraker/Klipper exposes on this unit.
 *
 * Deliberately NOT sourced from Creality's `[box]` (CFS) or `filament_rack`:
 * the real K2 payload reports every slot as `-1`/`None` with no field telling
 * which slot is feeding, so an "active filament" read from them would be
 * invented. `tray`/`remainPct` stay null — metadata has no slot concept.
 */
export function parseMoonrakerJobFilament(metadata: Record<string, unknown>): ActiveFilament | null {
  const material = firstFilamentToken(metadata.filament_type) ?? firstFilamentToken(metadata.filament_name);
  const color = firstHexColor(metadata.filament_colors);
  if (!material && color === null) return null;
  return { material, color, tray: null, remainPct: null };
}

/**
 * Best-effort fetch of the current job's sliced filament from Moonraker's file
 * metadata. Never throws — filament is a nice-to-have that must not break (or
 * slow past its own timeout) the core status poll, so any failure returns null.
 */
async function fetchMoonrakerJobFilament(
  printer: PrinterConfig,
  filename: string
): Promise<ActiveFilament | null> {
  try {
    const res = await fetchWithTimeout(
      `${moonrakerBaseUrl(printer)}/server/files/metadata?filename=${encodeURIComponent(filename)}`,
      { timeoutMs: MOONRAKER_TIMEOUT_MS, headers: moonrakerHeaders(printer) }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: unknown };
    return isObject(json?.result) ? parseMoonrakerJobFilament(json.result) : null;
  } catch {
    return null;
  }
}

/** Interprets a raw Moonraker pin value as on/off, before any active-low inversion. */
function interpretPinState(rawValue: unknown): boolean | null {
  const numericValue = toFiniteNumber(rawValue);
  if (numericValue !== null) return numericValue > 0;

  const textValue = firstText(rawValue).toLowerCase();
  if (["on", "true", "enabled", "1"].includes(textValue)) return true;
  if (["off", "false", "disabled", "0"].includes(textValue)) return false;
  return null;
}

/**
 * The chamber light's live on/off state from its Moonraker status object. For an
 * active-low pin (`light.invert`) the physical fixture is lit when the pin reads
 * low, so the raw pin reading is flipped — the reported state always means "the
 * light is physically on", matching what the on/off commands drive. Exported for
 * unit testing.
 */
export function readMoonrakerLightState(
  printer: PrinterConfig,
  status: Record<string, unknown>
): boolean | null {
  if (!printer.light.enabled || !printer.light.statusObject) return null;

  const object = status[printer.light.statusObject];
  if (!isObject(object)) return null;

  const state = interpretPinState(object[printer.light.statusField]);
  if (state === null) return null;
  return printer.light.invert ? !state : state;
}

export async function getMoonrakerStatus(printer: PrinterConfig): Promise<PrinterLiveStatus> {
  const url = moonrakerStatusUrl(printer);

  try {
    const res = await fetchWithTimeout(url, {
      timeoutMs: MOONRAKER_TIMEOUT_MS,
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

    // Active filament from the current job's sliced metadata — the only honest
    // live filament signal the K2 exposes (CFS `box`/`filament_rack` report no
    // usable material and no active slot). Only meaningful while a print is
    // loaded, so skip the extra request otherwise.
    const currentFile = firstText(printStats.filename) || null;
    const activeFilament =
      currentFile && (mappedStatus === "printing" || mappedStatus === "paused")
        ? await fetchMoonrakerJobFilament(printer, currentFile)
        : null;

    return {
      id: printer.id,
      online: true,
      status: mappedStatus,
      currentFile,
      progressPct,
      remainingMinutes: estimateRemainingMinutes(progressPct, elapsedSec),
      filamentUsedMm,
      // Moonraker/Klipper has no AMS concept here; filament is one loaded reel.
      amsTrays: null,
      nozzleDiameterMm,
      // Klipper has no standard "nozzle type" field, so this stays null and the
      // view falls back to the configured nozzle type. (Active filament, by
      // contrast, now comes from the current job's sliced metadata — below.)
      nozzleType: null,
      activeFilament,
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
  }
}

export async function sendMoonrakerCommand(
  printer: PrinterConfig,
  command: PrinterCommand
): Promise<void> {
  const res = await fetchWithTimeout(`${moonrakerBaseUrl(printer)}/printer/print/${command}`, {
    method: "POST",
    timeoutMs: MOONRAKER_TIMEOUT_MS,
    headers: moonrakerHeaders(printer)
  });
  if (!res.ok) {
    throw new PrinterCommandError(`Moonraker HTTP ${res.status}`);
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

  const res = await fetchWithTimeout(
    `${moonrakerBaseUrl(printer)}/printer/print/start?filename=${encodeURIComponent(name)}`,
    {
      method: "POST",
      timeoutMs: MOONRAKER_TIMEOUT_MS,
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
}

export async function sendMoonrakerLightCommand(
  printer: PrinterConfig,
  on: boolean
): Promise<void> {
  const script = on ? printer.light.onGcode : printer.light.offGcode;
  if (!script) {
    throw new PrinterCommandError(`Moonraker light command is not configured for ${printer.name}`);
  }

  const res = await fetchWithTimeout(
    `${moonrakerBaseUrl(printer)}/printer/gcode/script?script=${encodeURIComponent(script)}`,
    {
      method: "POST",
      timeoutMs: MOONRAKER_TIMEOUT_MS,
      headers: moonrakerHeaders(printer)
    }
  );
  if (!res.ok) {
    throw new PrinterCommandError(`Moonraker HTTP ${res.status}`);
  }
}
