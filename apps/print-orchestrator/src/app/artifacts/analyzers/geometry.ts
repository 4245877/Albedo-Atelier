import type { AnalysisFinding } from "../../../domain/print/types";
import { mmPerUnit as mmPerKnownUnit, type ModelUnits, type ResolvedUnits } from "../../../domain/shared/units";
import { finding } from "./types";

/**
 * The one place model geometry becomes a *normalized* result — shared by the STL
 * and 3MF analyzers so both report sizes the same way and both are guarded the
 * same way.
 *
 * The rule the whole scheduling chain rests on: **a size is millimetres only
 * when the file proved it is.** So the normalized payload carries two boxes —
 * `…Raw` (the file's own numbers, whatever they mean) and `…Mm` (the same box
 * converted, present *only* when the unit is known). A consumer that wants a
 * real dimension reads `sizeMm`; when it is `null` the honest answer is "size
 * unknown", never "assume millimetres". An STL therefore always arrives with
 * `sizeMm === null` and `scaleKnown === false` until an operator confirms the
 * unit; a 3MF arrives converted from whatever `<model unit="…">` declared.
 *
 * The guards below refuse geometry that cannot be real rather than passing a
 * plausible-looking box downstream: NaN/±∞ coordinates, an empty model, a
 * zero-extent axis, and coordinates/extents beyond any physical plausibility.
 * Finding codes are namespaced by the analyzer (`stl_…` / `threemf_…`) so the
 * existing per-format contract is preserved.
 */

export type Vec3 = [number, number, number];

/** An axis-aligned bounding box in one coordinate system. */
export interface Box {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

export const GEOMETRY_LIMITS = {
  /**
   * Any single coordinate whose magnitude exceeds this is not geometry, it is
   * corruption — no exporter emits ±10⁹ in any unit for a printable part.
   */
  maxAbsCoord: 1e9,
  /** No printable object is 100 m across; a box this large means broken data or a broken unit. */
  maxSizeMm: 100_000,
  /** Above this the model is *probably* mis-scaled — a warning, not a refusal. */
  suspiciousLargeMm: 1000,
  /** Below this likewise (a 0.5 mm part is far more often a unit mistake than a real part). */
  suspiciousSmallMm: 1
} as const;

// ── Bounds accumulation ──────────────────────────────────────────────────────

/**
 * A streaming min/max accumulator that also *counts* what it had to reject, so
 * "the box came out fine" can never hide "and 4000 vertices were NaN".
 */
export interface BoundsAccumulator {
  min: Vec3;
  max: Vec3;
  /** Finite, in-range points folded into the box. */
  points: number;
  /** Points rejected for a NaN/±∞ coordinate. */
  nonFinite: number;
  /** Points rejected for a coordinate beyond {@link GEOMETRY_LIMITS.maxAbsCoord}. */
  outOfRange: number;
}

export function newBounds(): BoundsAccumulator {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    points: 0,
    nonFinite: 0,
    outOfRange: 0
  };
}

/** Folds one point in, or counts it as rejected. Never throws. */
export function addPoint(b: BoundsAccumulator, x: number, y: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    b.nonFinite++;
    return;
  }
  const limit = GEOMETRY_LIMITS.maxAbsCoord;
  if (Math.abs(x) > limit || Math.abs(y) > limit || Math.abs(z) > limit) {
    b.outOfRange++;
    return;
  }
  b.points++;
  if (x < b.min[0]) b.min[0] = x;
  if (y < b.min[1]) b.min[1] = y;
  if (z < b.min[2]) b.min[2] = z;
  if (x > b.max[0]) b.max[0] = x;
  if (y > b.max[1]) b.max[1] = y;
  if (z > b.max[2]) b.max[2] = z;
}

/** Folds `source`'s box and its rejection counters into `target`. */
export function mergeBounds(target: BoundsAccumulator, source: BoundsAccumulator): void {
  target.nonFinite += source.nonFinite;
  target.outOfRange += source.outOfRange;
  if (source.points === 0) return;
  target.points += source.points;
  for (let i = 0; i < 3; i++) {
    if (source.min[i] < target.min[i]) target.min[i] = source.min[i];
    if (source.max[i] > target.max[i]) target.max[i] = source.max[i];
  }
}

/** The accumulated box, or null when nothing usable was folded in. */
export function boxOf(b: BoundsAccumulator): Box | null {
  if (b.points === 0) return null;
  const min: Vec3 = [b.min[0], b.min[1], b.min[2]];
  const max: Vec3 = [b.max[0], b.max[1], b.max[2]];
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Scales a box by a constant factor (unit conversion). */
export function scaleBox(box: Box, factor: number): Box {
  const scale = (v: Vec3): Vec3 => [v[0] * factor, v[1] * factor, v[2] * factor];
  return { min: scale(box.min), max: scale(box.max), size: scale(box.size) };
}

// ── Normalized result ────────────────────────────────────────────────────────

/** One build plate's own geometry, kept separate so plates are never merged silently. */
export interface PlateGeometry {
  /** Plate number as the package labels it (1-based). */
  index: number;
  /** Build items attributed to this plate. */
  objectCount: number;
  sizeRaw: Vec3 | null;
  minMm: Vec3 | null;
  maxMm: Vec3 | null;
  sizeMm: Vec3 | null;
}

/**
 * The normalized geometry payload stored at `analysis.data.geometry`. Every
 * model analyzer emits exactly this shape, and {@link file://../../scheduling/evidence.ts
 * EvidenceResolver} reads only this (falling back to the legacy `bbox`/`units`
 * pair for rows analysed before it existed).
 */
export interface NormalizedGeometry {
  /** The printable scene's box in the file's own numbers; null when unreadable. */
  minRaw: Vec3 | null;
  maxRaw: Vec3 | null;
  sizeRaw: Vec3 | null;
  /**
   * The same box in millimetres — **null whenever the unit is not proven**, so a
   * consumer can never mistake un-scaled numbers for a real dimension.
   */
  minMm: Vec3 | null;
  maxMm: Vec3 | null;
  sizeMm: Vec3 | null;
  /** The unit the file declared, resolved; `unknown` when it declared none or one we cannot convert. */
  sourceUnits: ModelUnits;
  /** The unit token exactly as written in the file; null when nothing was declared. */
  declaredUnits: string | null;
  /** Millimetres per source unit; null when unknown. */
  mmPerUnit: number | null;
  /** True only when {@link sizeMm} is a proven millimetre measurement. */
  scaleKnown: boolean;
  objectCount: number;
  /** Build plates the package describes; 1 for a plain single-plate model, 0 when nothing is placed. */
  plateCount: number;
  /** Per-plate boxes, when the package let us attribute objects to plates. */
  plates: PlateGeometry[];
  /**
   * The union across *all* plates. Equal to the main box for a single-plate
   * scene; for a multi-plate package the main box is withheld (null) and this is
   * the only merged figure — explicitly labelled as spanning several plates.
   */
  sceneSizeRaw: Vec3 | null;
  sceneSizeMm: Vec3 | null;
  /** True when several plates are present and no single plate was selected. */
  multiPlate: boolean;
  /** Vertices/points folded into the box. */
  pointCount: number;
  /** True when a vertex cap stopped the traversal early (box is a partial answer). */
  truncated: boolean;
}

export interface GeometryInput {
  /** Namespace for the emitted finding codes: `stl` or `threemf`. */
  prefix: string;
  /** The accumulated scene bounds (all plates merged). */
  bounds: BoundsAccumulator;
  units: ResolvedUnits;
  objectCount: number;
  plateCount: number;
  /** Per-plate bounds, when the package let us attribute build items to plates. */
  plates?: { index: number; objectCount: number; bounds: BoundsAccumulator }[];
  truncated?: boolean;
}

export interface GeometryResult {
  geometry: NormalizedGeometry;
  warnings: AnalysisFinding[];
  blockers: AnalysisFinding[];
}

/**
 * Turns accumulated bounds + a resolved unit into the normalized payload and the
 * findings that go with it.
 *
 * Two structural decisions live here:
 *
 *   - **Unknown unit ⇒ no millimetres.** `…Mm` stays null and `scaleKnown` is
 *     false. Nothing downstream may substitute a guess.
 *   - **Several plates ⇒ no merged box.** A package holding three plates
 *     describes three separate prints; a box spanning all of them is not the
 *     size of anything that will ever be printed. The main box is withheld, each
 *     plate keeps its own, and the union survives only under the explicitly
 *     named `scene…` fields.
 */
export function normalizeGeometry(input: GeometryInput): GeometryResult {
  const warnings: AnalysisFinding[] = [];
  const blockers: AnalysisFinding[] = [];
  const code = (suffix: string): string => `${input.prefix}_${suffix}`;

  const factor = input.units.mmPerUnit;
  const scaleKnown = factor !== null;
  const sceneBox = boxOf(input.bounds);
  const sceneBoxMm = sceneBox && factor !== null ? scaleBox(sceneBox, factor) : null;

  // ── Rejected input ────────────────────────────────────────────────────────
  if (input.bounds.nonFinite > 0) {
    blockers.push(
      finding(
        code("non_finite"),
        `Модель содержит нечисловые или бесконечные координаты (${input.bounds.nonFinite})`
      )
    );
  }
  if (input.bounds.outOfRange > 0) {
    blockers.push(
      finding(
        code("out_of_range"),
        `Координаты выходят за физически возможные пределы (${input.bounds.outOfRange} точек)`
      )
    );
  }

  // ── Unit ──────────────────────────────────────────────────────────────────
  if (input.units.unrecognized) {
    warnings.push(
      finding(
        code("units_unrecognized"),
        `Единицы измерения «${input.units.declared}» не распознаны — размеры нельзя привести к миллиметрам`
      )
    );
  } else if (!scaleKnown) {
    warnings.push(
      finding(code("units_unknown"), "Формат не хранит единицы измерения — масштаб требует подтверждения")
    );
  }

  // ── Box shape ─────────────────────────────────────────────────────────────
  const plates = (input.plates ?? []).map((p) => toPlateGeometry(p, factor));
  const multiPlate = input.plateCount > 1;

  if (sceneBox) {
    // A zero-extent axis is not a thin part, it is a flat/degenerate mesh: it has
    // no printable height on that axis and no slicer will produce anything from it.
    const flat = sceneBox.size.findIndex((s) => !(s > 0));
    if (flat >= 0) {
      blockers.push(
        finding(
          code("degenerate"),
          `Нулевой габарит по оси ${"XYZ"[flat]} — модель вырождена и не может быть напечатана`
        )
      );
    }
    const measured = sceneBoxMm ?? sceneBox;
    const maxDim = Math.max(...measured.size);
    if (sceneBoxMm && maxDim > GEOMETRY_LIMITS.maxSizeMm) {
      blockers.push(
        finding(
          code("out_of_range"),
          `Габарит ${Math.round(maxDim)} мм превышает физически возможный размер модели`
        )
      );
    } else if (maxDim > GEOMETRY_LIMITS.suspiciousLargeMm) {
      warnings.push(finding(code("suspicious_scale"), suspiciousMessage("большая", scaleKnown)));
    } else if (maxDim > 0 && maxDim < GEOMETRY_LIMITS.suspiciousSmallMm) {
      warnings.push(finding(code("suspicious_scale"), suspiciousMessage("маленькая", scaleKnown)));
    }
  }

  if (multiPlate) {
    warnings.push(
      finding(
        code("multi_plate"),
        `В файле ${input.plateCount} пластин — общий габарит не является размером одной печати, выберите пластину явно`
      )
    );
  }
  if (input.truncated) {
    warnings.push(
      finding(code("bbox_truncated"), "Модель очень плотная — габариты рассчитаны частично")
    );
  }

  // A multi-plate scene exposes no merged box: see the doc comment above.
  const printable = multiPlate ? null : sceneBox;
  const printableMm = multiPlate ? null : sceneBoxMm;

  return {
    geometry: {
      minRaw: printable?.min ?? null,
      maxRaw: printable?.max ?? null,
      sizeRaw: printable?.size ?? null,
      minMm: printableMm?.min ?? null,
      maxMm: printableMm?.max ?? null,
      sizeMm: printableMm?.size ?? null,
      sourceUnits: input.units.units,
      declaredUnits: input.units.declared,
      mmPerUnit: factor,
      scaleKnown,
      objectCount: input.objectCount,
      plateCount: input.plateCount,
      plates,
      sceneSizeRaw: sceneBox?.size ?? null,
      sceneSizeMm: sceneBoxMm?.size ?? null,
      multiPlate,
      pointCount: input.bounds.points,
      truncated: input.truncated === true
    },
    warnings,
    blockers
  };
}

function toPlateGeometry(
  plate: { index: number; objectCount: number; bounds: BoundsAccumulator },
  factor: number | null
): PlateGeometry {
  const box = boxOf(plate.bounds);
  const mm = box && factor !== null ? scaleBox(box, factor) : null;
  return {
    index: plate.index,
    objectCount: plate.objectCount,
    sizeRaw: box?.size ?? null,
    minMm: mm?.min ?? null,
    maxMm: mm?.max ?? null,
    sizeMm: mm?.size ?? null
  };
}

function suspiciousMessage(adjective: string, scaleKnown: boolean): string {
  return scaleKnown
    ? `Подозрительно ${adjective} модель — проверьте масштаб`
    : `Подозрительно ${adjective} модель (единицы измерения неизвестны)`;
}

/** Millimetres per unit for an already-resolved {@link ModelUnits}. */
export { mmPerKnownUnit as mmPerUnit };
