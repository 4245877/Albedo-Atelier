import { newBounds, mergeBounds, type BoundsAccumulator } from "./geometry";
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
 * must know how many plates there are before it publishes a merged box.
 *
 * Everything here is best-effort and fail-safe in the same direction: when the
 * plates cannot be attributed to build items, the count still stands (so the
 * merged box is withheld) and the per-plate boxes are simply absent. Nothing is
 * guessed.
 */

const MODEL_SETTINGS_RE = /Metadata\/model_settings\.config$/i;

/** Plate → the build items it holds, as `Metadata/model_settings.config` records them. */
export interface PlateAssignment {
  plates: { index: number; ids: Set<string> }[];
}

/** One build item, resolved against the resource objects, with its own bounds. */
export interface PlacedItem {
  /** 1-based position in `<build>`, the id OrcaSlicer's plate config often uses. */
  position: number;
  objectId: string;
  bounds: BoundsAccumulator;
}

/**
 * Reads the plate → object assignment a slicer project records in
 * `Metadata/model_settings.config`. The `object_id` values there refer to the
 * build items — depending on the writer, either by the object's `id` attribute
 * or by its 1-based position — so both readings are tried in
 * {@link resolvePlates}. Anything unreadable yields `null`: the plates stay
 * unattributed, which is reported, not guessed around.
 *
 * Read through the same {@link SafeZip} + {@link parseSafeXml} guards as the
 * model itself, so it is subject to every ZIP-bomb / XXE limit.
 */
export async function readPlateAssignment(
  zip: SafeZip,
  entryNames: string[],
  maxBytes: number
): Promise<PlateAssignment | null> {
  const name = entryNames.find((n) => MODEL_SETTINGS_RE.test(n));
  if (!name) return null;
  try {
    const xml = (await zip.read(name, maxBytes)).toString("utf8");
    const config = asRecord(asRecord(parseSafeXml(xml, maxBytes)).config);
    const rawPlates = asArray(config.plate as unknown);
    const plates = rawPlates.map((plate, i) => {
      const rec = asRecord(plate);
      const index = Number(metadataValue(asArray(rec.metadata as unknown), "plater_id"));
      const ids = new Set<string>();
      for (const instance of asArray(rec.model_instance as unknown)) {
        const objectId = metadataValue(asArray(asRecord(instance).metadata as unknown), "object_id");
        if (objectId) ids.add(objectId);
      }
      return { index: Number.isFinite(index) && index > 0 ? index : i + 1, ids };
    });
    return plates.length > 0 ? { plates } : null;
  } catch {
    return null;
  }
}

/** `plate_N` entries (thumbnails, per-plate G-code) — the fallback plate count. */
export function countPlateEntries(entryNames: string[]): number {
  const plates = new Set<string>();
  for (const name of entryNames) {
    const m = name.match(/plate_(\d+)/i);
    if (m) plates.add(m[1]);
  }
  return plates.size;
}

/**
 * How many plates the package describes, and each plate's own bounds when the
 * build items could be attributed. The count is the largest of the three
 * independent signals (recorded assignment, `plate_N` entries, "there is a
 * build") so a plate is never lost — under-counting would merge separate prints
 * into one box, exactly what must not happen.
 */
export function resolvePlates(
  placed: readonly PlacedItem[],
  assignment: PlateAssignment | null,
  entryPlateCount: number
): { count: number; scoped: { index: number; objectCount: number; bounds: BoundsAccumulator }[] } {
  const implicit = placed.length > 0 ? 1 : 0;
  const count = Math.max(assignment?.plates.length ?? 0, entryPlateCount, implicit);

  if (!assignment) {
    // No recorded assignment: attribute nothing. With a single plate the scene
    // box IS that plate's box, so scoping adds nothing; with several, the plates
    // stay unattributed and the merged box is withheld by `normalizeGeometry`.
    return { count, scoped: [] };
  }

  const scoped = assignment.plates.map((plate) => {
    const bounds = newBounds();
    let objectCount = 0;
    for (const item of placed) {
      if (!plate.ids.has(item.objectId) && !plate.ids.has(String(item.position))) continue;
      mergeBounds(bounds, item.bounds);
      objectCount++;
    }
    return { index: plate.index, objectCount, bounds };
  });
  return { count, scoped };
}

/** The `value` of the first `<metadata key="…">` with this key. */
function metadataValue(entries: unknown[], key: string): string | null {
  for (const entry of entries) {
    const rec = asRecord(entry);
    if (String(rec["@_key"] ?? "").toLowerCase() === key) {
      const value = rec["@_value"];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
