import type { Artifact, ArtifactAnalysis } from "./types";

/**
 * **Which plate of a multi-plate 3MF is the one we are working on.**
 *
 * A project exported from OrcaSlicer / Bambu Studio can hold several build
 * plates, and each is a *separate print*: its own objects, its own size, its own
 * G-code. Nothing in the file says which one the operator meant, and there is no
 * defensible way to infer it — so until a named operator says so, the package
 * has no printable size (the merged box spans plates that will never be on the
 * bed together) and no slice can be started.
 *
 * The record is deliberately the same shape as the model-scale confirmation and
 * the review acknowledgement next door ({@link file://./modelScale.ts},
 * {@link file://./analysisReview.ts}) — same storage (`artifact.metadata`, a
 * column that already exists), same binding to the bytes, same audited service
 * around it. It adds two bindings those two do not need, because a plate choice
 * is the only one of the three that is *executed* rather than merely believed:
 * the **plate count** and the chosen plate's **position**. A newer analyzer
 * reading the *same bytes* can legitimately find a different number of plates,
 * or order the same plates differently — and "plate 2" then means something else
 * than it did. Either way the choice lapses rather than being silently
 * re-pointed at whatever now answers to that number.
 *
 * What it does not do: authorise anything. It answers "which plate", and every
 * other gate — scale, review, compatibility, dispatch — still runs.
 */

/** The `artifact.metadata` key the selection lives under. */
export const PLATE_SELECTION_KEY = "plateSelection";

export interface PlateSelectionConfirmation {
  /** The plate's own number, as the package labels it (`PlateView.index`). */
  plateIndex: number;
  /**
   * The plate's **position** at confirmation time — the `--slice i` the operator's
   * choice actually resolved to.
   *
   * Stored because the identity alone does not determine the outcome. The number
   * an operator picks is a label; what reaches the slicer is a position, and the
   * two are computed from the file by an analyzer that can change. Same bytes,
   * same plate count, a newer analyzer that orders or attributes the plates
   * differently — "plate 2" survives every other check here and quietly means a
   * different print. Recording the position closes that: the choice lapses when
   * the thing it will be executed as has moved. Null only for a record written
   * before this field existed.
   */
  sliceIndex: number | null;
  /** How many plates the analysis saw when this was chosen. */
  plateCount: number;
  /** Artifact content hash at confirmation time; null for a hash-less legacy row. */
  sha256: string | null;
  /** Artifact size at confirmation time — the fallback identity check. */
  sizeBytes: number | null;
  confirmedBy: string;
  confirmedAt: string;
}

/**
 * One plate as the rest of the system reads it back off an analysis. A
 * deliberately *narrow* projection of what the analyzer wrote: the fields any
 * decision depends on, each validated, so a hand-edited or older `data` blob
 * cannot smuggle a shape through. Presentation-only fields (settings, estimate,
 * per-object footprints) stay in `analysis.data` for the UI and are not
 * re-validated here — nothing decides on them.
 */
export interface PlateView {
  index: number;
  /** The 1-based plate number OrcaSlicer's `--slice` takes. */
  sliceIndex: number;
  name: string | null;
  source: "model_settings" | "entries" | "implicit";
  objectCount: number;
  /**
   * True when the package told us what stands on this plate. False means the
   * plate is known to exist (a `plate_N.*` entry) but its contents are not
   * attributable — which is not the same as it being empty.
   */
  objectsKnown: boolean;
  sizeRaw: readonly [number, number, number] | null;
  sizeMm: readonly [number, number, number] | null;
  hasPreview: boolean;
  sliced: boolean;
}

/** A selection read back, resolved against the artifact and analysis as they stand now. */
export interface ResolvedPlateSelection {
  confirmation: PlateSelectionConfirmation;
  /** The plate it names, when that plate is still in the current analysis. */
  plate: PlateView | null;
  /** True when the choice no longer describes the current bytes/analysis. */
  stale: boolean;
  /** Why it lapsed, for the operator; null when it is current. */
  staleReason: string | null;
}

/**
 * The plates an analysis describes, in index order. Empty for anything that is
 * not a plate-bearing 3MF, and empty for a row written by an analyzer that did
 * not publish plates — in which case a multi-plate package simply cannot be
 * chosen from until it is re-analysed, which is the intended fail-closed path.
 */
export function readPlates(analysis: ArtifactAnalysis | null): PlateView[] {
  const raw = analysis?.data?.plates;
  if (!Array.isArray(raw)) return [];
  const out: PlateView[] = [];
  for (const entry of raw) {
    const plate = toPlateView(entry);
    if (plate) out.push(plate);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** How many plates the analysis says the package holds; 0 when it does not say. */
export function readPlateCount(analysis: ArtifactAnalysis | null): number {
  const geometry = analysis?.data?.geometry;
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) return 0;
  const count = (geometry as Record<string, unknown>).plateCount;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
}

/**
 * Whether this artifact needs an explicit plate choice before anything can be
 * done with it. One rule, on the server, for the card, the slicer and the
 * scheduler alike — see {@link file://../../app/artifacts/nextAction.ts}.
 */
export function plateSelectionRequired(analysis: ArtifactAnalysis | null): boolean {
  return analysis?.state === "ready" && readPlateCount(analysis) > 1 && readPlates(analysis).length > 0;
}

/**
 * A package that *has* several plates but whose analysis cannot name any of
 * them: a row written before the analyzer described plates. Nothing can be
 * chosen from it, so the honest next step is a re-analysis, not a picker with
 * nothing in it. Distinguished from "no choice made yet" because the two call
 * for completely different actions.
 */
export function plateListUnavailable(analysis: ArtifactAnalysis | null): boolean {
  return analysis?.state === "ready" && readPlateCount(analysis) > 1 && readPlates(analysis).length === 0;
}

/**
 * A plate that cannot be printed, and why — or null when it can be chosen.
 *
 * Two refusals, and the distinction between them is the point. "Empty" is only
 * ever said about a plate the package *described* and described as holding
 * nothing; a plate known only from a `plate_N.*` entry is not empty, it is
 * *unknown*, and it is refused for the opposite reason — not because there is
 * demonstrably nothing to print, but because there is nothing to decide on.
 * Both are shown in the picker with their reason, so the operator sees what the
 * file is missing rather than a greyed-out control.
 */
export function plateUnselectableReason(plate: PlateView): string | null {
  if (plate.objectsKnown && plate.objectCount === 0) {
    return "на этой пластине нет ни одной модели — печатать нечего";
  }
  // A plate the package never described: known to exist only because some
  // `plate_N` entry mentions it. Nothing is known about it — not its contents,
  // not its size, and not reliably its position — so choosing it would authorise
  // a slice with every check downstream reduced to nothing: no size to compare
  // against the bed, no expected box to verify the output against, and a
  // `--slice` number inferred rather than read. Shown, so the operator can see
  // the package is inconsistent; not selectable, because there is nothing here
  // to make a decision *about*. @see file://../../app/artifacts/analyzers/threemfPlates.ts
  if (!plate.objectsKnown) {
    return "состав пластины не разобран — файл не описывает, что на ней стоит";
  }
  return null;
}

/**
 * Validates operator input into a storable selection, or null when the plate is
 * not one this analysis offers or cannot be printed. The caller turns null into
 * a 400 rather than storing a choice nothing can act on.
 */
export function makePlateSelectionConfirmation(input: {
  plateIndex: unknown;
  plates: readonly PlateView[];
  plateCount: number;
  artifact: Pick<Artifact, "sha256" | "sizeBytes">;
  confirmedBy: string;
  confirmedAt: string;
}): { confirmation: PlateSelectionConfirmation; plate: PlateView } | { error: string } {
  const index = Number(input.plateIndex);
  if (!Number.isInteger(index)) return { error: "Номер пластины должен быть целым числом" };

  const plate = input.plates.find((p) => p.index === index);
  if (!plate) {
    const available = input.plates.map((p) => p.index).join(", ");
    return {
      error: available
        ? `В файле нет пластины №${index} — доступны: ${available}`
        : `В файле нет пластины №${index}`
    };
  }
  const unprintable = plateUnselectableReason(plate);
  if (unprintable) return { error: `Пластину №${index} выбрать нельзя: ${unprintable}` };

  return {
    plate,
    confirmation: {
      plateIndex: plate.index,
      sliceIndex: plate.sliceIndex,
      plateCount: input.plateCount,
      sha256: input.artifact.sha256,
      sizeBytes: input.artifact.sizeBytes,
      confirmedBy: input.confirmedBy,
      confirmedAt: input.confirmedAt
    }
  };
}

/**
 * The selection stored on an artifact, or null when there is none / it is not a
 * well-formed record. A selection that no longer matches is returned with
 * `stale: true` and a reason: callers must not act on it, but the operator is
 * told it lapsed rather than finding their choice silently gone.
 */
export function readPlateSelection(
  artifact: Artifact,
  analysis: ArtifactAnalysis | null
): ResolvedPlateSelection | null {
  const raw = artifact.metadata?.[PLATE_SELECTION_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;

  const plateIndex = rec.plateIndex;
  if (typeof plateIndex !== "number" || !Number.isInteger(plateIndex)) return null;

  const confirmation: PlateSelectionConfirmation = {
    plateIndex,
    sliceIndex:
      typeof rec.sliceIndex === "number" && Number.isInteger(rec.sliceIndex) && rec.sliceIndex >= 1
        ? rec.sliceIndex
        : null,
    plateCount: typeof rec.plateCount === "number" ? rec.plateCount : 0,
    sha256: typeof rec.sha256 === "string" ? rec.sha256 : null,
    sizeBytes: typeof rec.sizeBytes === "number" ? rec.sizeBytes : null,
    confirmedBy: typeof rec.confirmedBy === "string" ? rec.confirmedBy : "operator",
    confirmedAt: typeof rec.confirmedAt === "string" ? rec.confirmedAt : ""
  };

  const plate = readPlates(analysis).find((p) => p.index === plateIndex) ?? null;
  const staleReason = staleness(confirmation, plate, artifact, analysis);
  return { confirmation, plate, stale: staleReason !== null, staleReason };
}

/**
 * Why a stored selection no longer holds, in the order the operator would ask.
 *
 * The bytes come first (a replaced file is a different project entirely), then
 * the plate count (the same bytes read by a newer analyzer may hold a different
 * number of plates, and "plate 2" then names something else), then the plate
 * itself. A selection that captured neither hash nor size is unverifiable, and
 * an unverifiable choice must not authorise a slice.
 */
function staleness(
  confirmation: PlateSelectionConfirmation,
  plate: PlateView | null,
  artifact: Artifact,
  analysis: ArtifactAnalysis | null
): string | null {
  if (confirmation.sha256 !== null && artifact.sha256 !== null) {
    if (confirmation.sha256 !== artifact.sha256) return "файл был заменён";
  } else if (confirmation.sizeBytes !== null && artifact.sizeBytes !== null) {
    if (confirmation.sizeBytes !== artifact.sizeBytes) return "файл был заменён";
  } else {
    return "выбор нельзя сверить с содержимым файла";
  }

  const count = readPlateCount(analysis);
  if (count !== confirmation.plateCount) {
    return `файл переанализирован: пластин теперь ${count}, а не ${confirmation.plateCount}`;
  }
  if (!plate) return `пластины №${confirmation.plateIndex} больше нет в файле`;
  // The identity survived; the position it resolves to did not. Same bytes and
  // the same number of plates, so nothing above caught it — but the slice this
  // choice authorises is now a different print. @see PlateSelectionConfirmation
  if (confirmation.sliceIndex !== null && confirmation.sliceIndex !== plate.sliceIndex) {
    return `файл переанализирован: пластина №${confirmation.plateIndex} теперь стоит на другом месте в проекте`;
  }
  const unprintable = plateUnselectableReason(plate);
  if (unprintable) return `пластина №${confirmation.plateIndex} больше не пригодна: ${unprintable}`;
  return null;
}

/** The plate a *valid* selection names, or null (no choice, or a lapsed one). */
export function selectedPlate(
  artifact: Artifact,
  analysis: ArtifactAnalysis | null
): PlateView | null {
  const resolved = readPlateSelection(artifact, analysis);
  return resolved && !resolved.stale ? resolved.plate : null;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function toPlateView(raw: unknown): PlateView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const index = rec.index;
  if (typeof index !== "number" || !Number.isInteger(index)) return null;

  const source = rec.source;
  const geometry =
    rec.geometry && typeof rec.geometry === "object" && !Array.isArray(rec.geometry)
      ? (rec.geometry as Record<string, unknown>)
      : {};

  const objects = Array.isArray(rec.objects) ? rec.objects : [];
  return {
    index,
    sliceIndex:
      typeof rec.sliceIndex === "number" && Number.isInteger(rec.sliceIndex) && rec.sliceIndex >= 1
        ? rec.sliceIndex
        : index >= 1
          ? index
          : 1,
    name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : null,
    source: source === "model_settings" || source === "entries" || source === "implicit" ? source : "entries",
    // The analyzer's own count, which its display caps may leave above the length
    // of the listed detail. A plate cut short by a cap is not an empty plate.
    objectCount:
      typeof rec.objectCount === "number" && Number.isInteger(rec.objectCount) && rec.objectCount >= 0
        ? rec.objectCount
        : objects.length,
    objectsKnown: source === "model_settings" || source === "implicit",
    sizeRaw: triple(geometry.sizeRaw),
    sizeMm: triple(geometry.sizeMm),
    hasPreview: rec.preview !== null && typeof rec.preview === "object",
    sliced: rec.sliced === true
  };
}

function triple(value: unknown): readonly [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}
