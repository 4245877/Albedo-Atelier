import type {
  AmsFacts,
  BuildVolumeFacts,
  DiscoveredFacts,
  Fact,
  LoadedMaterialFact,
  PrinterDiscoveryRecord
} from "./discovery";
import type { PrinterTechnology } from "./types";

/**
 * Resolving one printer's specification from everything the farm knows about it.
 *
 * Three parties can answer "what nozzle is on this machine?": the device itself,
 * the operator who typed a value into the hardware card, and the model catalogue.
 * They disagree, and **this module is the only place in the service that decides
 * who wins** — so the card, the live view, the scheduler and the published
 * inventory can never drift into three different answers.
 *
 * The order is `printer` → `manual` → `catalog` → `unknown`:
 *
 *  - **the device wins.** The point of the feature is that connecting a printer
 *    fills its card in; a stale hand-typed value silently overriding the machine
 *    would put the manual transfer of specs straight back;
 *  - **the operator outranks the catalogue.** Both speak about this specific
 *    unit — but the operator has seen it, and the catalogue only knows the model;
 *  - **nothing is invented.** With no source at all the value is `null` and the
 *    source is `unknown`, which the card renders as «принтер эту характеристику
 *    не передаёт» rather than a blank that looks like a zero.
 *
 * A manual value that loses is not discarded, it is reported as
 * {@link ResolvedSpec.overriddenManual}, and the card shows it as a conflict to
 * resolve. That matters because a device's nozzle fields are a *setting*, not a
 * sensor: swapping a nozzle without updating the printer leaves the device
 * confidently wrong, and the operator needs to see the disagreement to fix it.
 */

/** Who supplied the winning value. */
export type SpecSource = "printer" | "manual" | "catalog" | "unknown";

/**
 * The operator-declared half of a printer — exactly the fields the resolver
 * reads, and nothing else.
 *
 * Structural rather than tied to {@link PrinterRecord} so both shapes of "a
 * printer the farm knows about" satisfy it: the stored record (the config card,
 * the inventory) and the materialized runtime config (the poller, the live
 * view). Both must resolve to the same answer, and the way to guarantee that is
 * for both to go through this one function.
 */
export interface DeclaredPrinterSpecs {
  model?: string;
  type: PrinterTechnology;
  material?: string;
  nozzleDiameterMm?: number | null;
  nozzleType?: string;
  buildVolume?: { x: number; y: number; z: number } | null;
  /** When the declaration was last edited; absent for the runtime config shape. */
  updatedAt?: string;
}

export interface ResolvedSpec<T> {
  /** The value to use, or null when nobody knows it. */
  value: T | null;
  source: SpecSource;
  /** Human-readable provenance for the winning value; null when `unknown`. */
  via: string | null;
  /** When the winning value was observed/last edited; null when `unknown`. */
  observedAt: string | null;
  /**
   * A stored manual value that the device overruled, when the two differ. Drives
   * the «принтер сообщает X» warning; null when there is no conflict.
   */
  overriddenManual: T | null;
  /**
   * The catalogue's value when it lost to a higher source AND differs from it —
   * shown as a hint, never applied. Null when the catalogue agrees or is silent.
   */
  catalogHint: T | null;
}

/** The full resolved specification of one printer. */
export interface ResolvedPrinterSpecs {
  model: ResolvedSpec<string>;
  firmware: ResolvedSpec<string>;
  deviceName: ResolvedSpec<string>;
  technology: ResolvedSpec<PrinterTechnology>;
  buildVolume: ResolvedSpec<BuildVolumeFacts>;
  nozzleDiameterMm: ResolvedSpec<number>;
  nozzleType: ResolvedSpec<string>;
  /** The single "loaded material" label — the active slot, else what was declared. */
  material: ResolvedSpec<string>;
  extruderCount: ResolvedSpec<number>;
  ams: ResolvedSpec<AmsFacts>;
  materials: ResolvedSpec<LoadedMaterialFact[]>;
  chamberSensor: ResolvedSpec<boolean>;
  heatedChamber: ResolvedSpec<boolean>;
  filamentSensor: ResolvedSpec<boolean>;
  kinematics: ResolvedSpec<string>;
}

/** Spec keys that a printer card renders as an editable field with a source badge. */
export const EDITABLE_SPEC_FIELDS = [
  "model",
  "buildVolume",
  "nozzleDiameterMm",
  "nozzleType",
  "material"
] as const satisfies readonly (keyof ResolvedPrinterSpecs)[];

export type EditableSpecField = (typeof EDITABLE_SPEC_FIELDS)[number];

const UNKNOWN_SPEC = {
  value: null,
  source: "unknown",
  via: null,
  observedAt: null,
  overriddenManual: null,
  catalogHint: null
} as const;

/** An empty resolution — every field unknown. Used when a printer has never been probed. */
export function unknownSpec<T>(): ResolvedSpec<T> {
  return { ...UNKNOWN_SPEC } as ResolvedSpec<T>;
}

/**
 * Resolves a printer's specification. Pure: same inputs, same answer, no clock
 * and no I/O — which is what makes the priority rule testable as a matrix.
 */
export function resolvePrinterSpecs(
  record: DeclaredPrinterSpecs,
  discovery: PrinterDiscoveryRecord | null
): ResolvedPrinterSpecs {
  const facts: DiscoveredFacts = discovery?.facts ?? {};
  const observedAt = discovery?.probedAt ?? null;
  const editedAt = record.updatedAt ?? null;

  const resolve = <T>(fact: Fact<T> | undefined, manual: T | null): ResolvedSpec<T> =>
    resolveOne(fact, manual, observedAt, editedAt);

  return {
    model: resolve(facts.model, orNull(record.model)),
    firmware: resolve(facts.firmware, null),
    deviceName: resolve(facts.deviceName, null),
    // `type` always holds a value (it defaults to FDM), so it is never absent —
    // the catalogue can only ever confirm it or be reported as a hint.
    technology: resolve(facts.technology, record.type),
    buildVolume: resolve(facts.buildVolume, record.buildVolume ?? null),
    nozzleDiameterMm: resolve(facts.nozzleDiameterMm, record.nozzleDiameterMm ?? null),
    nozzleType: resolve(facts.nozzleType, orNull(record.nozzleType)),
    material: resolve(activeMaterialFact(facts), orNull(record.material)),
    extruderCount: resolve(facts.extruderCount, null),
    ams: resolve(facts.ams, null),
    materials: resolve(facts.materials, null),
    chamberSensor: resolve(facts.chamberSensor, null),
    heatedChamber: resolve(facts.heatedChamber, null),
    filamentSensor: resolve(facts.filamentSensor, null),
    kinematics: resolve(facts.kinematics, null)
  };
}

/**
 * Overlays a fresher live-telemetry reading on a resolved spec.
 *
 * Discovery is persisted and refreshed on its own interval; the poll loop sees
 * the same device fields every few seconds. When the live status carries a
 * value, it is by definition the most recent thing the device said, so it wins —
 * but the resolution rule itself is unchanged: a manual override that the stored
 * device fact already overruled stays overruled, and one that had won (because
 * the device was silent) now yields to the device, correctly.
 */
export function withLiveReading<T>(
  spec: ResolvedSpec<T>,
  live: T | null,
  via: string,
  observedAt: string | null
): ResolvedSpec<T> {
  if (live === null || live === undefined) return spec;

  const manual = spec.source === "manual" ? spec.value : spec.overriddenManual;
  return {
    value: live,
    source: "printer",
    via,
    observedAt,
    overriddenManual: manual !== null && !sameValue(manual, live) ? manual : null,
    catalogHint: spec.source === "catalog" && !sameValue(spec.value, live) ? spec.value : null
  };
}

function resolveOne<T>(
  fact: Fact<T> | undefined,
  manual: T | null,
  observedAt: string | null,
  editedAt: string | null
): ResolvedSpec<T> {
  const fromPrinter = fact && fact.source === "printer" ? fact : null;
  const fromCatalog = fact && fact.source === "catalog" ? fact : null;

  if (fromPrinter) {
    return {
      value: fromPrinter.value,
      source: "printer",
      via: fromPrinter.via || null,
      observedAt,
      overriddenManual:
        manual !== null && !sameValue(manual, fromPrinter.value) ? manual : null,
      catalogHint: null
    };
  }

  if (manual !== null) {
    return {
      value: manual,
      source: "manual",
      via: null,
      observedAt: editedAt,
      overriddenManual: null,
      catalogHint:
        fromCatalog && !sameValue(fromCatalog.value, manual) ? fromCatalog.value : null
    };
  }

  if (fromCatalog) {
    return {
      value: fromCatalog.value,
      source: "catalog",
      via: fromCatalog.via || null,
      observedAt,
      overriddenManual: null,
      catalogHint: null
    };
  }

  return unknownSpec<T>();
}

/**
 * The active slot's material as a plain label, so «материал» resolves against
 * the operator's declared one. Returns undefined when no slot is feeding — the
 * declared value then stands, which is exactly the pre-existing behaviour.
 */
function activeMaterialFact(facts: DiscoveredFacts): Fact<string> | undefined {
  const materials = facts.materials;
  if (!materials) return undefined;

  const active = materials.value.find((entry) => entry.active && entry.material);
  if (!active?.material) return undefined;

  return { value: active.material, source: materials.source, via: materials.via };
}

/** "" is how the record stores "not specified"; here that must read as absent. */
function orNull(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Structural equality for spec values. Only ever compares two values of the same
 * field, so a canonical JSON round-trip is enough — and it keeps `{x,y,z}`
 * build volumes comparable without a per-type comparator.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
