import { newBounds, mergeBounds, type BoundsAccumulator, type PlateGeometry } from "./geometry";
import { asArray, parseSafeXml } from "./xml";
import type { SafeZip } from "./zip";

/**
 * Build-plate discovery for a 3MF package.
 *
 * The 3MF core spec has exactly one `<build>` — plates are a slicer extension
 * (OrcaSlicer / BambuStudio), recorded in `Metadata/model_settings.config` and
 * visible indirectly through `plate_N.*` entries. That matters because a project
 * with three plates describes three *separate prints*: a bounding box spanning
 * all of them is the size of nothing anyone will ever print, so the analyzer
 * must know how many plates there are before it publishes a merged box — and,
 * since an operator has to choose one, it must describe each of them well enough
 * to be chosen: name, contents, size, thumbnail, estimate.
 *
 * Everything here is best-effort and fail-safe in the same direction: when the
 * plates cannot be attributed to build items, the count still stands (so the
 * merged box is withheld) and the per-plate contents are simply absent. Nothing
 * is guessed. Vendor metadata is optional by nature — a missing, malformed or
 * unknown key yields `null`/omission, never a failed analysis.
 */

const MODEL_SETTINGS_RE = /Metadata\/model_settings\.config$/i;
/** `Metadata/plate_3.png`, `Metadata/plate_12.gcode` — the conventional naming. */
const PLATE_ENTRY_RE = /plate_(\d+)/i;

/**
 * Caps on what one package may publish in detail. A pathological file (thousands
 * of plates, tens of thousands of instances, a metadata flood) must not turn a
 * `data` JSON column into a memory problem — but truncation is never silent: the
 * *count* stays truthful and the analyzer reports that detail was cut.
 */
export const PLATE_LIMITS = {
  /** Plates described in full; beyond this only the count survives. */
  maxDetailedPlates: 64,
  /** Model instances listed per plate. */
  maxObjectsPerPlate: 512,
  /** Plate-level settings kept per plate. */
  maxSettingsPerPlate: 64,
  /** Bytes a settings value may carry (a config can hold a whole G-code line). */
  maxSettingValueChars: 512
} as const;

/** Where the knowledge of this plate came from — and therefore how far it is trusted. */
export type PlateSource =
  /** `Metadata/model_settings.config` declared it: contents are known. */
  | "model_settings"
  /** Only `plate_N.*` archive entries mention it: it exists, its contents are unknown. */
  | "entries"
  /** Nothing declared any plate; the single implicit plate of a plain model. */
  | "implicit";

/** One model instance standing on a plate, as the slicer's config records it. */
export interface PlateObject {
  objectId: string;
  instanceId: string | null;
  /** The object's declared name (`<object><metadata key="name">`), when present. */
  name: string | null;
  /**
   * The instance's footprint on the bed, in millimetres — null when the object
   * could not be attributed to a build item or the file's unit is unknown. Comes
   * straight off the bounds the scene traversal already computed: no second pass
   * over the mesh.
   */
  footprintMm: { min: [number, number]; max: [number, number] } | null;
}

/** Where a plate's picture lives inside the archive, and what it really is. */
export interface PlatePreviewRef {
  /** `declared` — the config named this entry; `conventional` — found by naming rule. */
  kind: "declared" | "conventional";
  /** The archive entry name, as the archive itself spells it. Never client-supplied. */
  entry: string;
  /** Determined from the file's own signature, never from its extension. */
  contentType: "image/png" | "image/jpeg";
  widthPx: number | null;
  heightPx: number | null;
  bytes: number;
}

/** What an already-sliced plate reports about itself (`Metadata/slice_info.config`). */
export interface PlateEstimate {
  durationS: number | null;
  weightG: number | null;
  supportUsed: boolean | null;
  filaments: {
    id: number;
    type: string | null;
    colorHex: string | null;
    usedG: number | null;
  }[];
}

/** One build plate, described well enough for an operator to choose it. */
export interface PlateRecord {
  /**
   * The plate's number as the package labels it (`plater_id`, or the `N` of
   * `plate_N.*`). The identity the API and the operator address it by — NOT
   * necessarily its position in the file.
   */
  index: number;
  /**
   * The 1-based position OrcaSlicer's `--slice i` selects. Equal to {@link index}
   * for every file a slicer wrote itself (they number plates from 1, in order);
   * they diverge only for a hand-made or zero-based config, and then the
   * *position* is what the CLI can act on. @see file://../../../infra/slicing/orcaCliRunner.ts
   */
  sliceIndex: number;
  /** `plater_name` — the operator's own label for the plate; null when unnamed. */
  name: string | null;
  locked: boolean;
  source: PlateSource;
  objects: PlateObject[];
  /** True when {@link PLATE_LIMITS.maxObjectsPerPlate} cut the list. */
  objectsTruncated: boolean;
  /** This plate's own box — the same shape the merged geometry publishes. */
  geometry: PlateGeometry;
  /** True when the package already carries this plate's G-code. */
  sliced: boolean;
  gcodeEntry: string | null;
  /** Metadata only — the bytes are served from the source blob on demand. */
  preview: PlatePreviewRef | null;
  estimate: PlateEstimate | null;
  /** Every other plate-level `<metadata>`, verbatim (`curr_bed_type`, `print_sequence`, …). */
  settings: Record<string, string>;
}

// ── model_settings.config ────────────────────────────────────────────────────

/** One `<plate>` element, read but not yet reconciled with the rest of the package. */
export interface PlateConfigEntry {
  /** `plater_id` as declared, when it is a usable non-negative integer. */
  declaredIndex: number | null;
  /** 1-based position of this `<plate>` in the document. */
  ordinal: number;
  settings: Record<string, string>;
  instances: { objectId: string; instanceId: string | null }[];
  instancesTruncated: boolean;
}

export interface PlateConfig {
  /** The plates read in full — at most {@link PLATE_LIMITS.maxDetailedPlates}. */
  plates: PlateConfigEntry[];
  /** How many `<plate>` elements the config actually declared, cap or no cap. */
  declaredCount: number;
  /** Object id → its declared name, for naming what stands on a plate. */
  objectNames: Map<string, string>;
  /** True when a limit cut the plate list itself. */
  truncated: boolean;
}

/**
 * Reads the plate → object assignment a slicer project records in
 * `Metadata/model_settings.config`, with every plate-level setting it carries.
 *
 * The `object_id` values there refer to the build items — depending on the
 * writer, either by the object's `id` attribute or by its 1-based position — so
 * both readings are tried in {@link resolvePlates}. Anything unreadable yields
 * `null`: the plates stay unattributed, which is reported, not guessed around.
 *
 * Read through the same {@link SafeZip} + {@link parseSafeXml} guards as the
 * model itself, so it is subject to every ZIP-bomb / XXE limit.
 */
export async function readPlateConfig(
  zip: SafeZip,
  entryNames: string[],
  maxBytes: number
): Promise<PlateConfig | null> {
  const name = entryNames.find((n) => MODEL_SETTINGS_RE.test(n));
  if (!name) return null;
  try {
    const xml = (await zip.read(name, maxBytes)).toString("utf8");
    const config = asRecord(asRecord(parseSafeXml(xml, maxBytes)).config);

    const objectNames = new Map<string, string>();
    for (const object of asArray(config.object as unknown)) {
      const rec = asRecord(object);
      const id = String(rec["@_id"] ?? "").trim();
      const label = metadataValue(asArray(rec.metadata as unknown), "name");
      if (id && label) objectNames.set(id, label.slice(0, PLATE_LIMITS.maxSettingValueChars));
    }

    const raw = asArray(config.plate as unknown);
    const truncated = raw.length > PLATE_LIMITS.maxDetailedPlates;
    const plates = raw.slice(0, PLATE_LIMITS.maxDetailedPlates).map(readPlateEntry);
    return plates.length > 0 || objectNames.size > 0
      ? { plates, declaredCount: raw.length, objectNames, truncated }
      : null;
  } catch {
    return null;
  }
}

function readPlateEntry(plate: unknown, i: number): PlateConfigEntry {
  const rec = asRecord(plate);
  const settings = collectMetadata(asArray(rec.metadata as unknown));

  const rawInstances = asArray(rec.model_instance as unknown);
  const instances: PlateConfigEntry["instances"] = [];
  for (const instance of rawInstances.slice(0, PLATE_LIMITS.maxObjectsPerPlate)) {
    const meta = collectMetadata(asArray(asRecord(instance).metadata as unknown));
    const objectId = meta.object_id;
    if (!objectId) continue;
    instances.push({ objectId, instanceId: meta.instance_id ?? null });
  }

  return {
    declaredIndex: parseIndex(settings.plater_id),
    ordinal: i + 1,
    settings,
    instances,
    instancesTruncated: rawInstances.length > PLATE_LIMITS.maxObjectsPerPlate
  };
}

/** `plate_N` entries (thumbnails, per-plate G-code) — the fallback plate signal. */
export function countPlateEntries(entryNames: string[]): number {
  return plateEntryIndices(entryNames).size;
}

/** The distinct `N`s of every `plate_N.*` entry in the archive. */
export function plateEntryIndices(entryNames: string[]): Set<number> {
  const out = new Set<number>();
  for (const name of entryNames) {
    const m = PLATE_ENTRY_RE.exec(name);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isInteger(n) && n >= 0 && n <= 100_000) out.add(n);
  }
  return out;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/** One build item, resolved against the resource objects, with its own bounds. */
export interface PlacedItem {
  /** 1-based position in `<build>`, the id OrcaSlicer's plate config often uses. */
  position: number;
  objectId: string;
  bounds: BoundsAccumulator;
}

export interface ResolvedPlates {
  /** How many plates the package describes — never under-counted, never truncated. */
  count: number;
  /** Legacy per-plate boxes, unchanged: `geometry.plates`. */
  scoped: { index: number; objectCount: number; bounds: BoundsAccumulator }[];
  /** The full description of each plate, in index order. */
  records: PlateRecord[];
  /** True when {@link PLATE_LIMITS.maxDetailedPlates} cut the described list. */
  truncated: boolean;
}

/**
 * How many plates the package describes, and everything known about each.
 *
 * The count is the union of the independent signals (declared assignment,
 * `plate_N` entries, "there is a build") rather than the largest of them: a
 * package that declares plate 1 and also carries a `plate_2.png` holds two
 * plates, and taking a maximum would have reported one. Under-counting merges
 * separate prints into one box — exactly what must not happen.
 */
export function resolvePlates(input: {
  placed: readonly PlacedItem[];
  config: PlateConfig | null;
  entryIndices: ReadonlySet<number>;
  entryNames: readonly string[];
  /** Millimetres per source unit, or null when the file's unit is unproven. */
  mmPerUnit: number | null;
}): ResolvedPlates {
  const { placed, config, entryIndices } = input;
  const declared = config?.plates ?? [];

  // Index → the config entry that claims it. A declared index wins over the
  // ordinal fallback, and a duplicate never overwrites the first claimant.
  const byIndex = new Map<number, PlateConfigEntry>();
  for (const entry of declared) {
    const index = entry.declaredIndex ?? entry.ordinal;
    if (!byIndex.has(index)) byIndex.set(index, entry);
  }
  for (const n of entryIndices) if (!byIndex.has(n)) byIndex.set(n, EMPTY_ENTRY);

  const implicit = byIndex.size === 0 && placed.length > 0;
  if (implicit) byIndex.set(1, EMPTY_ENTRY);

  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  // The count must survive every cap: it is what withholds the merged bounding
  // box and what a stored plate choice is validated against, so a truncated
  // *list* may never become a truncated *count*.
  const count = Math.max(indices.length, config?.declaredCount ?? 0);
  const detailed = indices.slice(0, PLATE_LIMITS.maxDetailedPlates);

  const records: PlateRecord[] = [];
  const scoped: ResolvedPlates["scoped"] = [];

  for (const index of detailed) {
    const entry = byIndex.get(index) as PlateConfigEntry;
    const attributed = entry !== EMPTY_ENTRY;
    const source: PlateSource = attributed ? "model_settings" : implicit ? "implicit" : "entries";

    const bounds = newBounds();
    const objects: PlateObject[] = [];
    for (const instance of entry.instances) {
      const item = placed.find(
        (p) => p.objectId === instance.objectId || String(p.position) === instance.objectId
      );
      if (item) mergeBounds(bounds, item.bounds);
      objects.push({
        objectId: instance.objectId,
        instanceId: instance.instanceId,
        name: config?.objectNames.get(instance.objectId) ?? null,
        footprintMm: footprintOf(item?.bounds ?? null, input.mmPerUnit)
      });
    }

    // A single implicit plate IS the whole scene: with no config to attribute by,
    // everything the build places stands on it. Listing those items is what keeps
    // an ordinary one-plate model from reading as an *empty* plate — which is a
    // refusal, and would be exactly wrong here. Anything else stays unattributed.
    if (implicit) {
      for (const item of placed.slice(0, PLATE_LIMITS.maxObjectsPerPlate)) {
        mergeBounds(bounds, item.bounds);
        objects.push({
          objectId: item.objectId,
          instanceId: null,
          name: config?.objectNames.get(item.objectId) ?? null,
          footprintMm: footprintOf(item.bounds, input.mmPerUnit)
        });
      }
      for (const item of placed.slice(PLATE_LIMITS.maxObjectsPerPlate)) mergeBounds(bounds, item.bounds);
    }

    if (attributed) scoped.push({ index, objectCount: objects.length, bounds });

    records.push({
      index,
      sliceIndex: attributed ? entry.ordinal : index >= 1 ? index : 1,
      name: entry.settings.plater_name ?? null,
      locked: entry.settings.locked === "true" || entry.settings.locked === "1",
      source,
      objects,
      objectsTruncated:
        entry.instancesTruncated || (implicit && placed.length > PLATE_LIMITS.maxObjectsPerPlate),
      geometry: plateGeometry(index, objects.length, bounds, input.mmPerUnit),
      sliced: false,
      gcodeEntry: gcodeEntryFor(entry, index, input.entryNames),
      preview: null,
      estimate: null,
      settings: entry.settings
    });
  }

  for (const record of records) record.sliced = record.gcodeEntry !== null;

  return {
    count,
    // Legacy shape: only ever populated when the assignment was readable, so a
    // package whose plates cannot be attributed keeps reporting nothing here.
    scoped: config && declared.length > 0 ? scoped : [],
    records,
    truncated: count > records.length || config?.truncated === true
  };
}

/** A `<plate>` nobody declared — the shared stand-in for an entries-only plate. */
const EMPTY_ENTRY: PlateConfigEntry = Object.freeze({
  declaredIndex: null,
  ordinal: 0,
  settings: {},
  instances: [],
  instancesTruncated: false
});

/**
 * The plate's G-code payload: the entry the config names, else the conventional
 * `plate_<n>.gcode`. A `.gcode.md5` sidecar is deliberately not one — a lone
 * checksum used to make a project look sliced.
 */
function gcodeEntryFor(
  entry: PlateConfigEntry,
  index: number,
  entryNames: readonly string[]
): string | null {
  const declared = entry.settings.gcode_file;
  if (declared) {
    const found = matchEntry(entryNames, declared);
    if (found) return found;
  }
  const conventional = new RegExp(`(^|/)plate_${index}\\.gcode$`, "i");
  return entryNames.find((n) => conventional.test(n)) ?? null;
}

/**
 * Resolves a path a config declared against the archive's real entry list.
 *
 * The returned name is always one the archive actually contains — every entry
 * having already passed {@link SafeZip}'s traversal/symlink/duplicate guards —
 * so a declared path can name an existing part or nothing at all, and can never
 * denote a location outside the package.
 */
export function matchEntry(entryNames: readonly string[], declared: string): string | null {
  const wanted = declared.trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (!wanted || wanted.includes("..")) return null;
  return entryNames.find((n) => n.toLowerCase() === wanted) ?? null;
}

function plateGeometry(
  index: number,
  objectCount: number,
  bounds: BoundsAccumulator,
  mmPerUnit: number | null
): PlateGeometry {
  if (bounds.points === 0) {
    return { index, objectCount, sizeRaw: null, minMm: null, maxMm: null, sizeMm: null };
  }
  const size: [number, number, number] = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  ];
  if (mmPerUnit === null) {
    return { index, objectCount, sizeRaw: size, minMm: null, maxMm: null, sizeMm: null };
  }
  const scale = (v: readonly number[]): [number, number, number] => [
    v[0] * mmPerUnit,
    v[1] * mmPerUnit,
    v[2] * mmPerUnit
  ];
  return {
    index,
    objectCount,
    sizeRaw: size,
    minMm: scale(bounds.min),
    maxMm: scale(bounds.max),
    sizeMm: scale(size)
  };
}

/** The instance's XY extent in millimetres — the fallback layout drawing's input. */
function footprintOf(
  bounds: BoundsAccumulator | null,
  mmPerUnit: number | null
): PlateObject["footprintMm"] {
  if (!bounds || bounds.points === 0 || mmPerUnit === null) return null;
  return {
    min: [bounds.min[0] * mmPerUnit, bounds.min[1] * mmPerUnit],
    max: [bounds.max[0] * mmPerUnit, bounds.max[1] * mmPerUnit]
  };
}

// ── Metadata helpers ─────────────────────────────────────────────────────────

/** Every `<metadata key="…" value="…"/>` as a flat record, bounded and trimmed. */
function collectMetadata(entries: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  let kept = 0;
  for (const entry of entries) {
    if (kept >= PLATE_LIMITS.maxSettingsPerPlate) break;
    const rec = asRecord(entry);
    const key = String(rec["@_key"] ?? "").trim().toLowerCase();
    const value = rec["@_value"];
    if (!key || typeof value !== "string") continue;
    if (key in out) continue;
    out[key] = value.trim().slice(0, PLATE_LIMITS.maxSettingValueChars);
    kept++;
  }
  return out;
}

/** The `value` of the first `<metadata key="…">` with this key. */
function metadataValue(entries: unknown[], key: string): string | null {
  const value = collectMetadata(entries)[key];
  return value ? value : null;
}

/**
 * A declared plate number, or null. Non-negative integers only — `plater_id="0"`
 * is honoured as an index (some writers are zero-based) rather than silently
 * rewritten to 1, which would have made two plates share one number.
 */
function parseIndex(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
