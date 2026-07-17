import type { ProfileType } from "./types";

/**
 * Typed reading of OrcaSlicer profile settings.
 *
 * OrcaSlicer stores almost every value as a string, and many as a single-element
 * array of strings (`"nozzle_diameter": ["0.4"]`). This module is the one place
 * that copes with that: it unwraps and coerces the handful of fields the
 * inheritance resolver and compatibility validator actually reason about, so the
 * rest of the domain sees plain numbers/strings and never touches Orca's shape.
 *
 * Everything here is pure and defensive — a missing or unparseable field is
 * `null`/`[]`, never a throw — so it is safe to run over a raw (un-resolved)
 * profile as well as a fully-merged one.
 */

/** OrcaSlicer settings object: keys → string | string[] (and the odd nested value). */
export type OrcaSettings = Record<string, unknown>;

/** Unwraps Orca's single-element-array convention to the scalar within. */
export function unwrap(value: unknown): unknown {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  return value;
}

/** A finite number from a string/number cell, else null. */
export function numOf(value: unknown): number | null {
  const v = unwrap(value);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A non-empty trimmed string from a cell, else null. */
export function strOf(value: unknown): string | null {
  const v = unwrap(value);
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  if (typeof v === "number") return String(v);
  return null;
}

/** A string[] from an Orca array cell (drops empties); a scalar becomes a 1-element list. */
export function listOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x !== "");
  }
  const s = strOf(value);
  return s ? [s] : [];
}

/** The profile's own declared type, if it carries one (Orca writes e.g. `"type":"machine"`). */
export function declaredType(settings: OrcaSettings): ProfileType | null {
  const raw = strOf(settings.type);
  if (raw === "machine" || raw === "printer") return "machine";
  if (raw === "process" || raw === "print") return "process";
  if (raw === "filament") return "filament";
  return null;
}

// ── Machine fields ───────────────────────────────────────────────────────────

export interface MachineFields {
  nozzleDiameterMm: number | null;
  printerVariant: string | null;
  printerModel: string | null;
  gcodeFlavor: string | null;
  maxLayerHeightMm: number | null;
  minLayerHeightMm: number | null;
  /** Bed width (X extent of `printable_area`), mm. */
  bedWidthMm: number | null;
  /** Bed depth (Y extent of `printable_area`), mm. */
  bedDepthMm: number | null;
  bedHeightMm: number | null;
}

export function readMachine(settings: OrcaSettings): MachineFields {
  const [bedWidthMm, bedDepthMm] = readPrintableArea(settings.printable_area);
  return {
    nozzleDiameterMm: numOf(settings.nozzle_diameter),
    printerVariant: strOf(settings.printer_variant),
    printerModel: strOf(settings.printer_model),
    gcodeFlavor: strOf(settings.gcode_flavor),
    maxLayerHeightMm: numOf(settings.max_layer_height),
    minLayerHeightMm: numOf(settings.min_layer_height),
    bedWidthMm,
    bedDepthMm,
    bedHeightMm: numOf(settings.printable_height)
  };
}

/** Extent of a `printable_area` polygon (["0x0","256x0",…]) → [maxX, maxY] mm. */
export function readPrintableArea(value: unknown): [number | null, number | null] {
  if (!Array.isArray(value) || value.length === 0) return [null, null];
  let maxX = 0;
  let maxY = 0;
  let seen = false;
  for (const pt of value) {
    if (typeof pt !== "string") continue;
    const m = pt.split("x");
    if (m.length !== 2) continue;
    const x = Number.parseFloat(m[0]);
    const y = Number.parseFloat(m[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      seen = true;
    }
  }
  return seen ? [maxX, maxY] : [null, null];
}

// ── Process fields ───────────────────────────────────────────────────────────

export interface ProcessFields {
  layerHeightMm: number | null;
  initialLayerHeightMm: number | null;
  compatiblePrinters: string[];
}

export function readProcess(settings: OrcaSettings): ProcessFields {
  return {
    layerHeightMm: numOf(settings.layer_height),
    initialLayerHeightMm: numOf(settings.initial_layer_print_height),
    compatiblePrinters: listOf(settings.compatible_printers)
  };
}

// ── Filament fields ──────────────────────────────────────────────────────────

export interface FilamentFields {
  filamentType: string | null;
  nozzleTempC: number | null;
  nozzleTempInitialC: number | null;
  bedTempC: number | null;
  compatiblePrinters: string[];
}

export function readFilament(settings: OrcaSettings): FilamentFields {
  return {
    filamentType: strOf(settings.filament_type),
    nozzleTempC: numOf(settings.nozzle_temperature),
    nozzleTempInitialC: numOf(settings.nozzle_temperature_initial_layer),
    // Orca has several bed-temp keys depending on plate; take the first present.
    bedTempC:
      numOf(settings.hot_plate_temp) ??
      numOf(settings.bed_temperature) ??
      numOf(settings.cool_plate_temp) ??
      numOf(settings.textured_plate_temp),
    compatiblePrinters: listOf(settings.compatible_printers)
  };
}

/**
 * A nozzle diameter *hinted* by a profile or parent name — used only to raise a
 * warning about intended use, never as authoritative geometry. Matches an explicit
 * "… 0.2 nozzle" first, then a clearly-nozzle size token (`0.6mm`/`0.8mm`/`1.0mm`);
 * ambiguous sizes like `0.2mm`/`0.4mm`/`0.08mm` (which are just as likely a layer
 * height) are deliberately ignored.
 */
export function intendedNozzleFromName(name: string | null | undefined): number | null {
  if (!name) return null;
  const explicit = name.match(/(\d(?:\.\d+)?)\s*(?:mm\s*)?nozzle/i);
  if (explicit) {
    const n = Number.parseFloat(explicit[1]);
    if (Number.isFinite(n)) return n;
  }
  const size = name.match(/(?:^|[^\d.])(\d\.\d)\s*mm\b/i);
  if (size) {
    const n = Number.parseFloat(size[1]);
    if (n === 0.6 || n === 0.8 || n === 1.0) return n;
  }
  return null;
}
