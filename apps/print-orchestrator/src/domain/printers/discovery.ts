import { isObject } from "../../shared/isObject";
import type { WritableRepository } from "../shared/repository";
import type { PrinterProtocol } from "./config";
import type { AmsKind } from "./modelSpecs";
import type { PrinterTechnology } from "./types";

/**
 * What the farm has **learned from a printer itself** about the hardware it is.
 *
 * This is the third thing the service knows about a printer, deliberately kept
 * apart from the two that already exist:
 *
 *  - {@link PrinterRecord} is what the *operator declared* — typed into the
 *    dashboard, changed only by a human, authoritative about intent;
 *  - {@link PrinterLiveStatus} is what the device is *doing right now* —
 *    temperatures, progress, job — and is thrown away between polls;
 *  - a {@link PrinterDiscoveryRecord} is what the device *is*: model, firmware,
 *    bed size, nozzle, AMS. It changes rarely, so it is persisted (an operator
 *    must be able to read the spec of a printer that is currently offline), but
 *    it is never edited by hand — the next probe overwrites it.
 *
 * Every entry is a {@link Fact}: a value plus where it came from. A fact is
 * ABSENT when the device did not report it; there is no `null`-valued fact and
 * nothing here is ever inferred from a neighbouring field. That absence is what
 * the card renders as «принтер эту характеристику не передаёт», and it is the
 * property that keeps an auto-filled form from looking more certain than it is.
 */

/**
 * Where a fact came from.
 *
 *  - `printer` — the device said it, in this many words;
 *  - `catalog` — derived from the identified model via
 *    {@link file://./modelSpecs.ts the model catalogue}, because the protocol
 *    does not carry it (Bambu build volume, AMS kind).
 */
export type FactSource = "printer" | "catalog";

/** One discovered value with its provenance. */
export interface Fact<T> {
  value: T;
  source: FactSource;
  /**
   * Short, literal provenance shown to the operator — the field on the wire it
   * was read from (`"MQTT print.nozzle_type"`,
   * `"configfile.settings.stepper_x.position_max"`) or `"справочник моделей"`.
   * Prose, not an identifier: its only consumer is a human deciding whether to
   * trust the value.
   */
  via: string;
}

export interface BuildVolumeFacts {
  x: number;
  y: number;
  z: number;
}

/** Multi-material hardware as the device reports it, plus the kind from the catalogue. */
export interface AmsFacts {
  /** Whether a multi-material unit is attached at all. */
  present: boolean;
  /** AMS / AMS Lite / CFS — from the model catalogue; telemetry cannot tell them apart. */
  kind: AmsKind | null;
  /** Number of attached units; null when the device does not enumerate them. */
  units: number | null;
  /** Total addressable slots across units; null when unknown. */
  slots: number | null;
}

/** One loaded filament slot, as the device reports it. */
export interface LoadedMaterialFact {
  /** Global slot index, or null for an external spool with no slot concept. */
  slot: number | null;
  material: string | null;
  color: string | null;
  remainPct: number | null;
  active: boolean;
}

/**
 * The discovered hardware profile. Every key is optional: present means the
 * device (or the catalogue, for a `catalog` fact) actually stated it.
 */
export interface DiscoveredFacts {
  /** Catalogue key of the identified model, when it could be identified. */
  modelCode?: Fact<string>;
  /** Operator-facing model name. */
  model?: Fact<string>;
  firmware?: Fact<string>;
  /** The device's own name for itself (Klipper hostname, Creality device name). */
  deviceName?: Fact<string>;
  technology?: Fact<PrinterTechnology>;
  buildVolume?: Fact<BuildVolumeFacts>;
  nozzleDiameterMm?: Fact<number>;
  nozzleType?: Fact<string>;
  extruderCount?: Fact<number>;
  ams?: Fact<AmsFacts>;
  materials?: Fact<LoadedMaterialFact[]>;
  /** A chamber temperature *sensor* exists. NOT a claim that the chamber is heated. */
  chamberSensor?: Fact<boolean>;
  /** A controllable chamber heater exists. */
  heatedChamber?: Fact<boolean>;
  filamentSensor?: Fact<boolean>;
  /** Klipper kinematics ("corexy", "cartesian", …). */
  kinematics?: Fact<string>;
}

/** Every fact key, for iteration in the resolver, the API and the tests. */
export const DISCOVERED_FACT_KEYS = [
  "modelCode",
  "model",
  "firmware",
  "deviceName",
  "technology",
  "buildVolume",
  "nozzleDiameterMm",
  "nozzleType",
  "extruderCount",
  "ams",
  "materials",
  "chamberSensor",
  "heatedChamber",
  "filamentSensor",
  "kinematics"
] as const satisfies readonly (keyof DiscoveredFacts)[];

/** One printer's stored discovery result. Keyed by the printer id — one row per printer. */
export interface PrinterDiscoveryRecord {
  /** The printer's id; this table is a 1:1 extension of `printers`. */
  id: string;
  protocol: PrinterProtocol;
  facts: DiscoveredFacts;
  /** When the last probe ran, successful or not. */
  probedAt: string;
  /**
   * Whether that probe reached the device. `false` keeps the previously learned
   * facts visible (a printer that is briefly offline has not changed its bed
   * size) while telling the operator the data is not fresh.
   */
  succeeded: boolean;
  error: string | null;
  version: number;
}

/**
 * Storage port for discovery results. The service layer depends on this only;
 * the SQLite adapter lives in `infra/db/repositories`.
 */
export interface PrinterDiscoveryRepository
  extends WritableRepository<PrinterDiscoveryRecord> {
  /** Every stored discovery result, in no particular order. */
  list(): PrinterDiscoveryRecord[];
  /** Drops a printer's discovery result (also cascaded by the FK on delete). */
  delete(id: string): void;
}

// ── Schema-on-read ───────────────────────────────────────────────────────────

/**
 * Parses a stored `facts` blob back into {@link DiscoveredFacts}.
 *
 * Deliberately total: a malformed or half-understood entry is dropped, never
 * thrown on. The column holds JSON written by an older build of this service, so
 * a shape change must degrade to "that fact is unknown" rather than take the
 * printer card down — the same stance `parseMetadata` takes for metadata columns.
 */
export function parseDiscoveredFacts(value: unknown): DiscoveredFacts {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!isObject(raw)) return {};

  const facts: DiscoveredFacts = {};
  assign(facts, raw, "modelCode", readString);
  assign(facts, raw, "model", readString);
  assign(facts, raw, "firmware", readString);
  assign(facts, raw, "deviceName", readString);
  assign(facts, raw, "technology", readTechnology);
  assign(facts, raw, "buildVolume", readBuildVolume);
  assign(facts, raw, "nozzleDiameterMm", readPositiveNumber);
  assign(facts, raw, "nozzleType", readString);
  assign(facts, raw, "extruderCount", readPositiveNumber);
  assign(facts, raw, "ams", readAms);
  assign(facts, raw, "materials", readMaterials);
  assign(facts, raw, "chamberSensor", readBoolean);
  assign(facts, raw, "heatedChamber", readBoolean);
  assign(facts, raw, "filamentSensor", readBoolean);
  assign(facts, raw, "kinematics", readString);
  return facts;
}

/**
 * A stable string for "are these the same facts?", used to skip a pointless
 * write on every probe. Keys are sorted so JSON key order — which is insertion
 * order, and differs between adapters — cannot masquerade as a change.
 */
export function canonicalFactsJson(facts: DiscoveredFacts): string {
  return JSON.stringify(sortDeep(facts));
}

function safeJson(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function assign<K extends keyof DiscoveredFacts>(
  target: DiscoveredFacts,
  raw: Record<string, unknown>,
  key: K,
  read: (value: unknown) => unknown
): void {
  const entry = raw[key];
  if (!isObject(entry)) return;

  const value = read(entry.value);
  if (value === undefined) return;

  const source = entry.source === "catalog" ? "catalog" : entry.source === "printer" ? "printer" : null;
  if (source === null) return;

  target[key] = { value, source, via: typeof entry.via === "string" ? entry.via : "" } as
    DiscoveredFacts[K];
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readTechnology(value: unknown): PrinterTechnology | undefined {
  return value === "FDM" || value === "Resin" ? value : undefined;
}

function readBuildVolume(value: unknown): BuildVolumeFacts | undefined {
  if (!isObject(value)) return undefined;
  const x = readPositiveNumber(value.x);
  const y = readPositiveNumber(value.y);
  const z = readPositiveNumber(value.z);
  // Same all-or-nothing rule the stored config uses: a half-written volume is
  // not a volume.
  return x !== undefined && y !== undefined && z !== undefined ? { x, y, z } : undefined;
}

function readAms(value: unknown): AmsFacts | undefined {
  if (!isObject(value)) return undefined;
  const present = readBoolean(value.present);
  if (present === undefined) return undefined;
  const kind = value.kind;
  return {
    present,
    kind: kind === "AMS" || kind === "AMS Lite" || kind === "CFS" ? kind : null,
    units: readPositiveNumber(value.units) ?? null,
    slots: readPositiveNumber(value.slots) ?? null
  };
}

function readMaterials(value: unknown): LoadedMaterialFact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const materials = value.flatMap((entry): LoadedMaterialFact[] => {
    if (!isObject(entry)) return [];
    const slot = typeof entry.slot === "number" && Number.isFinite(entry.slot) ? entry.slot : null;
    const remain =
      typeof entry.remainPct === "number" && Number.isFinite(entry.remainPct)
        ? entry.remainPct
        : null;
    return [
      {
        slot,
        material: readString(entry.material) ?? null,
        color: readString(entry.color) ?? null,
        remainPct: remain,
        active: entry.active === true
      }
    ];
  });
  return materials.length > 0 ? materials : undefined;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortDeep(value[key]);
  }
  return sorted;
}
