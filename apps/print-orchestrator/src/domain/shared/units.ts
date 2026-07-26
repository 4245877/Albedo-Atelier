/**
 * Length units a model file may declare, and the single conversion table to
 * millimetres.
 *
 * Millimetres are the orchestrator's only internal length unit: build volumes,
 * nozzle diameters and every bounding box the scheduler compares are mm. A model
 * file, however, may say otherwise — the 3MF core spec lets `<model unit="…">`
 * be any of micron / millimeter / centimeter / meter / inch / foot, and an STL
 * declares nothing at all.
 *
 * Two rules the rest of the system depends on:
 *
 *   - **A unit is resolved, never assumed.** {@link resolveUnits} maps only the
 *     spellings it actually knows; anything else comes back `unknown` with the
 *     verbatim token kept, so the caller reports "we could not read the unit"
 *     rather than silently treating inches as millimetres.
 *   - **`unknown` has no factor.** {@link mmPerUnit} returns `null` for it, and a
 *     `null` factor must propagate as "size unknown" — the conversion is simply
 *     not performed. This is what keeps a 25.4×-too-small model from passing a
 *     build-volume check.
 */

/** The unit set the 3MF core spec defines, plus `unknown` for a file that declares none. */
export type ModelUnits =
  | "micron"
  | "millimeter"
  | "centimeter"
  | "meter"
  | "inch"
  | "foot"
  | "unknown";

/** Every unit we can convert, and its length in millimetres. */
export const UNIT_TO_MM: Record<Exclude<ModelUnits, "unknown">, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  meter: 1000,
  inch: 25.4,
  foot: 304.8
};

/** The convertible units, for validating operator input. */
export const KNOWN_UNITS: readonly Exclude<ModelUnits, "unknown">[] = [
  "micron",
  "millimeter",
  "centimeter",
  "meter",
  "inch",
  "foot"
];

/**
 * Spellings accepted for each unit: the 3MF spec tokens plus the common
 * abbreviations and the -re/-er variants real exporters emit. Anything outside
 * this table is deliberately *not* guessed at.
 */
const ALIASES: Record<string, Exclude<ModelUnits, "unknown">> = {
  micron: "micron",
  microns: "micron",
  micrometer: "micron",
  micrometre: "micron",
  um: "micron",
  "µm": "micron", // µm
  "μm": "micron", // μm (Greek mu)
  millimeter: "millimeter",
  millimetre: "millimeter",
  millimeters: "millimeter",
  millimetres: "millimeter",
  mm: "millimeter",
  centimeter: "centimeter",
  centimetre: "centimeter",
  centimeters: "centimeter",
  centimetres: "centimeter",
  cm: "centimeter",
  meter: "meter",
  metre: "meter",
  meters: "meter",
  metres: "meter",
  m: "meter",
  inch: "inch",
  inches: "inch",
  in: "inch",
  foot: "foot",
  feet: "foot",
  ft: "foot"
};

/** What a declared unit token resolved to. */
export interface ResolvedUnits {
  units: ModelUnits;
  /** Millimetres per source unit; null when {@link units} is `unknown`. */
  mmPerUnit: number | null;
  /** The token exactly as the file spelled it; null when the file declared none. */
  declared: string | null;
  /** True when a unit *was* declared but is not one we can convert. */
  unrecognized: boolean;
}

/** `unknown` units — no factor, nothing declared. */
export function unknownUnits(declared: string | null = null): ResolvedUnits {
  return { units: "unknown", mmPerUnit: null, declared, unrecognized: declared !== null };
}

/**
 * Resolves a declared unit token. A missing/blank token is *not* an error and is
 * not defaulted here — the caller decides what "undeclared" means for its format
 * (3MF's spec default is millimetre; STL has no default at all).
 */
export function resolveUnits(raw: unknown): ResolvedUnits {
  if (typeof raw !== "string") return unknownUnits(null);
  const token = raw.trim();
  if (token === "") return unknownUnits(null);
  const unit = ALIASES[token.toLowerCase()];
  if (!unit) return unknownUnits(token);
  return { units: unit, mmPerUnit: UNIT_TO_MM[unit], declared: token, unrecognized: false };
}

/** Millimetres per unit, or null when the unit is unknown/unconvertible. */
export function mmPerUnit(units: ModelUnits): number | null {
  return units === "unknown" ? null : UNIT_TO_MM[units];
}

/** Whether a value is one of the units we can actually convert. */
export function isKnownUnit(value: unknown): value is Exclude<ModelUnits, "unknown"> {
  return typeof value === "string" && value in UNIT_TO_MM;
}
