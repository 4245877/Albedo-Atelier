import type { AnalysisFinding } from "../../../domain/print/types";
import type { PlacedItem } from "./threemfPlates";
import { finding } from "./types";

/**
 * **Suspecting** a PrusaSlicer multi-bed project — and going no further.
 *
 * PrusaSlicer does not record plates. Its multi-bed projects are one ordinary
 * `<build>` whose objects have simply been moved onto neighbouring beds, spaced
 * along X by the bed pitch. There is no `<plate>` element, no `plater_id`, no
 * `plate_N.*` entry: nothing in the file says "these are two prints".
 *
 * Which is exactly why this module only raises a *warning*. Splitting such a
 * scene by coordinate would mean inventing plates the file never declared, and
 * the inference is not sound: a wide single print (a 700 mm gantry beam printed
 * in one piece on a large-format machine), a scene with one far-flung stray
 * object, and a genuine two-bed layout all look alike to a clustering rule. The
 * cost of being wrong is not symmetric either — inventing a plate boundary
 * would hand the slicer half a model and call it a print.
 *
 * So the file is reported as *worth a look* and left whole. This is the
 * extension point a real PrusaSlicer multi-bed reader would replace: it already
 * isolates the geometric question, and everything downstream (the merged box is
 * still published, the plate list stays empty) keeps behaving exactly as it did
 * for any other single-plate file.
 */

/**
 * A gap along X at least this wide separates two groups. Bed pitch in a
 * multi-bed layout is the bed's own width, so the empty margin between the
 * outermost parts of neighbouring beds is large — far larger than the few
 * millimetres of clearance a slicer leaves between parts on one bed.
 */
const BED_GAP_MM = 120;

/**
 * Below this total X extent nothing is suspicious: it still fits on one
 * large-format bed, whatever the arrangement.
 */
const SUSPICIOUS_SPAN_MM = 600;

/** Each group must itself be plausible as one bed's contents. */
const MAX_GROUP_SPAN_MM = 450;

/**
 * Returns a warning when the placed items look like several bed regions, or null
 * when they do not. Never splits, never counts plates, never touches geometry.
 */
export function suspectPrusaMultiBed(
  placed: readonly PlacedItem[],
  mmPerUnit: number | null
): AnalysisFinding | null {
  // Without a proven unit a "600 mm span" is not a span at all, just a number.
  if (mmPerUnit === null || placed.length < 2) return null;

  const spans = placed
    .filter((item) => item.bounds.points > 0)
    .map((item) => ({ min: item.bounds.min[0] * mmPerUnit, max: item.bounds.max[0] * mmPerUnit }))
    .sort((a, b) => a.min - b.min);
  if (spans.length < 2) return null;

  const total = spans[spans.length - 1].max - spans[0].min;
  if (total < SUSPICIOUS_SPAN_MM) return null;

  // Merge overlapping/near spans into groups; a group break needs a real gap.
  const groups: { min: number; max: number }[] = [{ ...spans[0] }];
  for (const span of spans.slice(1)) {
    const current = groups[groups.length - 1];
    if (span.min - current.max >= BED_GAP_MM) groups.push({ ...span });
    else current.max = Math.max(current.max, span.max);
  }

  if (groups.length < 2) return null;
  if (groups.some((g) => g.max - g.min > MAX_GROUP_SPAN_MM)) return null;

  return finding(
    "prusa_multi_bed_suspected",
    `Объекты стоят ${groups.length} группами, разнесёнными по X (всего ${Math.round(total)} мм) — похоже на несколько столов PrusaSlicer`,
    "В файле не объявлены пластины, поэтому разделить его автоматически нельзя. " +
      "Проверьте проект и, если это разные печати, сохраните каждый стол отдельным файлом."
  );
}
