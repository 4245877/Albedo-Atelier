import type { ArtifactAnalysis } from "../../domain/print/types";
import type { Dimensions } from "../../domain/scheduling/compatibility";

/**
 * The source model's geometry as the checks read it: whether the file declared
 * its own unit, and its raw box.
 *
 * Deliberately reads the same `geometry` block the scheduler's evidence resolver
 * does, so "the size that was checked" and "the size that was sliced" come from
 * one statement about the file rather than two readings of it. Shared by the
 * slice pipeline and the admission check (which verifies a slice's scale
 * provenance against the source it was cut from).
 */
export function readSourceGeometry(analysis: ArtifactAnalysis | null): {
  fileDeclaresUnit: boolean;
  sizeRaw: Dimensions | null;
  /** How many plates the package holds; 1 for an ordinary model, 0 when unknown. */
  plateCount: number;
} {
  const geometry = analysis?.data?.geometry;
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) {
    return { fileDeclaresUnit: false, sizeRaw: null, plateCount: 0 };
  }
  const record = geometry as Record<string, unknown>;
  const plateCount = typeof record.plateCount === "number" ? record.plateCount : 0;
  return {
    plateCount: record.multiPlate === true ? Math.max(plateCount, 2) : plateCount,
    fileDeclaresUnit: record.scaleKnown === true,
    // When the file declared its unit the analyzer already produced millimetres,
    // and that is the box the checks use; otherwise the raw numbers are what the
    // confirmed factor multiplies.
    sizeRaw: dimensionsOf(record.scaleKnown === true ? record.sizeMm : record.sizeRaw)
  };
}

/** `[x,y,z]` (or `{x,y,z}`) of positive finite numbers, else null. */
export function dimensionsOf(value: unknown): Dimensions | null {
  const triple = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [(value as Record<string, unknown>).x, (value as Record<string, unknown>).y, (value as Record<string, unknown>).z]
      : null;
  if (!triple || triple.length < 3) return null;
  const [x, y, z] = triple;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return x > 0 && y > 0 && z > 0 ? { x, y, z } : null;
}
