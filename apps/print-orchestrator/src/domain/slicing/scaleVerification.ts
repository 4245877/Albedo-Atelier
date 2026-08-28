import type { Dimensions } from "../scheduling/compatibility";

/**
 * **Did the slicer produce the size we checked?**
 *
 * The divergence this exists to make impossible: the scheduler sized an STL as
 * `sizeRaw × mmPerUnit` (the operator's confirmation that "these numbers are
 * inches"), while the slicer was handed the file untouched. A 2-inch cube was
 * therefore *checked* as 50.8 mm — against the bed, against the build volume,
 * against the plan — and *printed* as 2 mm. Neither layer was wrong on its own
 * terms, and nothing compared them, so the only way to discover it was to look
 * at the finished part.
 *
 * Passing the factor to the CLI fixes the cause; this checks the effect. That
 * distinction matters, because the transform now depends on an external
 * program's argument handling: a slicer build that quietly ignored `--scale`
 * would put the divergence straight back, and would look exactly like success.
 * So the sliced output's own bounding box is compared against what the source
 * geometry says it should be, and a mismatch blocks the variant instead of
 * shipping it.
 *
 * The comparison is deliberately loose. A slicer's box is not the model's box:
 * it is the extrusion outline, inflated by half a line width on each side,
 * possibly with a brim, and rounded to the G-code's own precision. It must
 * therefore catch a *unit* error (25.4×, 10×, 1000×) and never a legitimate
 * millimetre or two — which is exactly what a proportional tolerance with a
 * floor does.
 */

/** Fraction of the expected extent that may differ before it counts as a mismatch. */
const RELATIVE_TOLERANCE = 0.15;
/** Absolute floor, in mm, so a small model is not judged by a percentage of nothing. */
const ABSOLUTE_TOLERANCE_MM = 3;

export interface ScaleVerification {
  ok: boolean;
  /** Operator-facing explanation when `ok` is false. */
  reason: string | null;
}

/**
 * Compares the sliced output's box against the expected one.
 *
 * `ok` when they agree, when the axes cannot be compared at all (either box
 * missing or degenerate — other rules refuse an unknown size on their own
 * terms), and when the difference is within tolerance. Never invents a verdict
 * from half a comparison.
 */
export function verifySlicedScale(
  /** The source model's size in millimetres, as the checks understand it. */
  expectedMm: Dimensions | null,
  /** The sliced file's own bounding box, from its analysis. */
  producedMm: Dimensions | null
): ScaleVerification {
  if (!isUsable(expectedMm) || !isUsable(producedMm)) return { ok: true, reason: null };

  const axes: [keyof Dimensions, number, number][] = [
    ["x", expectedMm.x, producedMm.x],
    ["y", expectedMm.y, producedMm.y],
    ["z", expectedMm.z, producedMm.z]
  ];

  for (const [axis, expected, produced] of axes) {
    const allowed = Math.max(expected * RELATIVE_TOLERANCE, ABSOLUTE_TOLERANCE_MM);
    if (Math.abs(produced - expected) <= allowed) continue;
    const ratio = produced / expected;
    return {
      ok: false,
      reason:
        `нарезанный файл не того размера: по оси ${axis.toUpperCase()} ожидалось ` +
        `${expected.toFixed(1)} мм, получено ${produced.toFixed(1)} мм ` +
        `(в ${ratio.toFixed(2)} раза) — масштаб модели не был применён при нарезке`
    };
  }

  return { ok: true, reason: null };
}

function isUsable(d: Dimensions | null): d is Dimensions {
  return (
    d !== null &&
    Number.isFinite(d.x) &&
    Number.isFinite(d.y) &&
    Number.isFinite(d.z) &&
    d.x > 0 &&
    d.y > 0 &&
    d.z > 0
  );
}
