import {
  plateListUnavailable,
  plateUnselectableReason,
  readPlateSelection,
  type PlateView
} from "../../domain/print/plateSelection";
import type { Artifact, ArtifactAnalysis } from "../../domain/print/types";
import type { Dimensions } from "../../domain/scheduling/compatibility";

/**
 * Which build plate a slice is for.
 *
 * Split out of {@link file://./sliceService.ts SliceService} because it is one
 * self-contained question with one fail-closed answer, and because the answer is
 * needed twice: at creation time, where the plate becomes part of the slice's
 * cache key, and again in the worker, where the dependencies are re-checked
 * because they may have moved since.
 */

/**
 * Which plate this slice is for — or the refusal that stops it, in the operator's
 * words.
 *
 * Four outcomes, and only the first two exist for an ordinary file:
 *
 *   - a single-plate package needs no choice at all (`plate: null`, `--slice 0`
 *     unchanged — the whole point of not disturbing the common path);
 *   - a chosen, still-valid plate is sliced;
 *   - no choice, or one that has lapsed, is a **missing decision**: refused with
 *     the action that resolves it, never as "unsupported format";
 *   - a chosen plate with nothing on it is refused too — `--slice` would produce
 *     an empty print, and an empty print is a wasted machine hour, not a result.
 */
export function resolvePlateForSlice(
  artifact: Artifact,
  analysis: ArtifactAnalysis | null,
  plateCount: number
): { plate: PlateView | null } | { blocked: { code: string; message: string } } {
  if (plateCount <= 1) return { plate: null };

  // An analysis that predates the plate list cannot say which plate is which,
  // so there is no choice to honour and no plate to name to the CLI.
  if (plateListUnavailable(analysis)) {
    return {
      blocked: {
        code: "plate_list_unavailable",
        message:
          `В файле ${plateCount} пластин, но их состав разобран старой версией анализатора. ` +
          "Перезапустите анализ файла, затем выберите пластину и повторите."
      }
    };
  }

  const selection = readPlateSelection(artifact, analysis);
  if (!selection) {
    return {
      blocked: {
        code: "plate_not_selected",
        message:
          `В файле ${plateCount} пластин — это несколько разных печатей. ` +
          "Выберите на карточке файла пластину, которую нужно нарезать, и повторите."
      }
    };
  }
  if (selection.stale || !selection.plate) {
    return {
      blocked: {
        code: "plate_selection_stale",
        message:
          `Выбор пластины устарел (${selection.staleReason ?? "файл изменился"}) — ` +
          "выберите пластину заново на карточке файла и повторите."
      }
    };
  }
  const unprintable = plateUnselectableReason(selection.plate);
  if (unprintable) {
    return {
      blocked: {
        code: "plate_empty",
        message: `Выбрана пластина №${selection.plate.index}, но ${unprintable}. Выберите другую пластину.`
      }
    };
  }
  return { plate: selection.plate };
}

/** The plate the current selection names, when it is valid; else null. */
export function selectedPlateFor(
  artifact: Artifact,
  analysis: ArtifactAnalysis | null
): PlateView | null {
  const selection = readPlateSelection(artifact, analysis);
  return selection && !selection.stale ? selection.plate : null;
}

/**
 * The plate's box in the numbers the scale factor will be applied to — the
 * millimetre box when the file proved its unit (the factor is then 1), the raw
 * one otherwise. Mirrors {@link readSourceGeometry} exactly, for the plate.
 */
export function plateSizeRaw(plate: PlateView, fileDeclaresUnit: boolean): Dimensions | null {
  const size = fileDeclaresUnit ? plate.sizeMm : plate.sizeRaw;
  if (!size) return null;
  const [x, y, z] = size;
  return x > 0 && y > 0 && z > 0 ? { x, y, z } : null;
}
