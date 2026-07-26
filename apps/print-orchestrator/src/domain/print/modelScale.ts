import {
  isKnownUnit,
  mmPerUnit,
  UNIT_TO_MM,
  type ModelUnits
} from "../shared/units";
import type { Artifact } from "./types";

/**
 * The operator's explicit answer to "what do this model's numbers mean?".
 *
 * An STL stores no unit (and a 3MF may declare one we cannot map), so the
 * analyzer reports the size as *unproven* and the scheduler refuses to treat it
 * as millimetres. This record is the only thing that lifts that refusal: a named
 * operator stating the source unit — and optionally an extra scale factor — for
 * one specific artifact.
 *
 * Two properties make it safe to trust:
 *
 *   - **It is bound to the bytes.** The artifact's `sha256` (or, for a legacy row
 *     without one, its size) is captured at confirmation time. Re-upload
 *     different content under the same artifact and {@link readModelScale}
 *     reports the confirmation as stale, so the size silently reverts to
 *     unproven instead of carrying over to a file nobody looked at.
 *   - **It is audited.** It is written through the artifact service, which
 *     records who confirmed what and when.
 *
 * Stored under `artifact.metadata.modelScale` — a JSON column that already
 * exists, so no schema change is needed and an artifact written before this
 * feature simply has no confirmation.
 */

/** The `artifact.metadata` key the confirmation lives under. */
export const MODEL_SCALE_KEY = "modelScale";

export interface ModelScaleConfirmation {
  /** The unit the operator states the model's numbers are in. */
  units: Exclude<ModelUnits, "unknown">;
  /** An extra multiplier applied on top of the unit (1 = none). */
  scaleFactor: number;
  /** Artifact content hash when this was confirmed; null for a hash-less legacy row. */
  sha256: string | null;
  /** Artifact size when this was confirmed — the fallback identity check. */
  sizeBytes: number | null;
  confirmedBy: string;
  confirmedAt: string;
}

/** A confirmation read back from an artifact, with its validity against the current bytes. */
export interface ResolvedModelScale {
  confirmation: ModelScaleConfirmation;
  /** Millimetres per unit of the model's own numbers, including {@link ModelScaleConfirmation.scaleFactor}. */
  mmPerUnit: number;
  /** False when the artifact's content changed after the confirmation was made. */
  stale: boolean;
}

/** Upper bound on the extra factor — beyond this it is a typo, not a scale. */
const MAX_SCALE_FACTOR = 1e6;

/**
 * Validates operator input into a storable confirmation. Returns null when the
 * unit is not one we can convert or the factor is not a usable positive number —
 * the caller turns that into a 400 rather than storing a scale nothing can apply.
 */
export function makeModelScaleConfirmation(input: {
  units: unknown;
  scaleFactor?: unknown;
  artifact: Pick<Artifact, "sha256" | "sizeBytes">;
  confirmedBy: string;
  confirmedAt: string;
}): ModelScaleConfirmation | null {
  const units = typeof input.units === "string" ? input.units.trim().toLowerCase() : "";
  if (!isKnownUnit(units)) return null;

  const rawFactor = input.scaleFactor;
  const scaleFactor = rawFactor === undefined || rawFactor === null ? 1 : Number(rawFactor);
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || scaleFactor > MAX_SCALE_FACTOR) return null;

  return {
    units,
    scaleFactor,
    sha256: input.artifact.sha256,
    sizeBytes: input.artifact.sizeBytes,
    confirmedBy: input.confirmedBy,
    confirmedAt: input.confirmedAt
  };
}

/**
 * The confirmation stored on an artifact, or null when there is none / it is not
 * a well-formed record. A confirmation whose captured identity no longer matches
 * the artifact is returned with `stale: true` — callers must ignore its scale but
 * may still show the operator that a stale confirmation exists.
 */
export function readModelScale(artifact: Artifact): ResolvedModelScale | null {
  const raw = artifact.metadata?.[MODEL_SCALE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;

  const units = typeof rec.units === "string" ? rec.units.trim().toLowerCase() : "";
  if (!isKnownUnit(units)) return null;

  const scaleFactor = typeof rec.scaleFactor === "number" ? rec.scaleFactor : 1;
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || scaleFactor > MAX_SCALE_FACTOR) return null;

  const confirmation: ModelScaleConfirmation = {
    units,
    scaleFactor,
    sha256: typeof rec.sha256 === "string" ? rec.sha256 : null,
    sizeBytes: typeof rec.sizeBytes === "number" ? rec.sizeBytes : null,
    confirmedBy: typeof rec.confirmedBy === "string" ? rec.confirmedBy : "operator",
    confirmedAt: typeof rec.confirmedAt === "string" ? rec.confirmedAt : ""
  };

  return {
    confirmation,
    mmPerUnit: UNIT_TO_MM[units] * scaleFactor,
    stale: isStale(confirmation, artifact)
  };
}

/**
 * Whether the artifact's bytes changed since the confirmation. A hash is proof;
 * without one (a legacy row) the size is the only identity we have, and a
 * confirmation that captured neither is treated as stale — an unverifiable
 * confirmation must not authorise anything.
 */
function isStale(confirmation: ModelScaleConfirmation, artifact: Artifact): boolean {
  if (confirmation.sha256 !== null && artifact.sha256 !== null) {
    return confirmation.sha256 !== artifact.sha256;
  }
  if (confirmation.sizeBytes !== null && artifact.sizeBytes !== null) {
    return confirmation.sizeBytes !== artifact.sizeBytes;
  }
  return true;
}

/** Millimetres per unit for a stored confirmation (unit factor × operator factor). */
export function scaleMmPerUnit(confirmation: ModelScaleConfirmation): number {
  return (mmPerUnit(confirmation.units) ?? 1) * confirmation.scaleFactor;
}
