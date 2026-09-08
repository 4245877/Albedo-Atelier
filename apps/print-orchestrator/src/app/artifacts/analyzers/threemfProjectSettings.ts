import type { SafeZip } from "./zip";

/**
 * The print settings a *project* 3MF carries, read for display only.
 *
 * Two on-disk shapes cover every slicer this farm sees: Orca/Bambu write JSON in
 * `Metadata/project_settings.config`, PrusaSlicer writes `key = value` lines in
 * `Metadata/Slic3r_PE.config`. Both are read under the same byte bound as every
 * other entry, and both are treated as *untrusted description*: nothing here can
 * change a verdict, select a profile, or reach the slicer. It exists so the
 * operator can be told what they are overriding.
 */
export interface ProjectSettings {
  any: boolean;
  values: {
    printer: string | null;
    material: string | null;
    nozzleMm: number | null;
    layerHeightMm: number | null;
  };
}

const PROJECT_SETTINGS_ENTRY = /Metadata\/(project_settings|Slic3r_PE)\.config$/i;

export async function readProjectSettings(
  zip: SafeZip,
  entryNames: string[],
  maxBytes: number
): Promise<ProjectSettings> {
  const empty: ProjectSettings = {
    any: false,
    values: { printer: null, material: null, nozzleMm: null, layerHeightMm: null }
  };
  const name = entryNames.find((n) => PROJECT_SETTINGS_ENTRY.test(n));
  if (!name) return empty;

  let text: string;
  try {
    text = (await zip.read(name, maxBytes)).toString("utf8");
  } catch {
    // A config we cannot read is simply one we cannot describe. It never blocks:
    // the system profile is the source of truth either way.
    return empty;
  }

  const flat = /\.json$|^\s*\{/.test(text) ? readJsonConfig(text) : readIniConfig(text);
  const values = {
    printer: firstString(flat, ["printer_settings_id", "printer_model", "printer_variant"]),
    material: firstString(flat, ["filament_settings_id", "filament_type", "filament_type_0"]),
    nozzleMm: firstNumber(flat, ["nozzle_diameter", "nozzle_diameter_0"]),
    layerHeightMm: firstNumber(flat, ["layer_height"])
  };
  return {
    any: Object.values(values).some((v) => v !== null),
    values
  };
}

/** Orca/Bambu JSON: values are strings or single-element arrays of strings. */
function readJsonConfig(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  for (const [key, value] of Object.entries(asRecord(parsed))) {
    if (typeof value === "string") out.set(key.toLowerCase(), value);
    else if (Array.isArray(value) && typeof value[0] === "string") out.set(key.toLowerCase(), value[0]);
  }
  return out;
}

/** PrusaSlicer `key = value`, one per line, `;` comments. */
function readIniConfig(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  return out;
}

function firstString(flat: Map<string, string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = flat.get(key)?.trim();
    if (value) return value.slice(0, 120);
  }
  return null;
}

function firstNumber(flat: Map<string, string>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const raw = flat.get(key);
    if (!raw) continue;
    const n = Number.parseFloat(raw.split(",")[0]);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000) / 1000;
  }
  return null;
}

/** «Bambu Lab A1, PETG, сопло 0.4 мм, слой 0.2 мм» — only what was actually found. */
export function describeProjectSettings(project: ProjectSettings): string {
  const v = project.values;
  const parts: string[] = [];
  if (v.printer) parts.push(v.printer);
  if (v.material) parts.push(v.material);
  if (v.nozzleMm !== null) parts.push(`сопло ${v.nozzleMm} мм`);
  if (v.layerHeightMm !== null) parts.push(`слой ${v.layerHeightMm} мм`);
  return parts.join(", ") || "параметры не распознаны";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
