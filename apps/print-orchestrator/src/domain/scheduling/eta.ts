/**
 * Print-time (ETA) resolution for the manual scheduler.
 *
 * The brief fixes a strict priority order and forbids fabricating a time when no
 * real data exists:
 *   1. the **verified** ETA of a ready {@link SliceVariant} (OrcaSlicer's own
 *      predicted print time, stored verbatim — never a synthesised percentile);
 *   2. the ETA extracted from **G-code analysis** (the `;TIME:`/estimated print
 *      time an analyzer read out of a sliced file);
 *   3. **unknown** — `seconds: null`. Nothing invents a number here.
 *
 * Because the farm has no historical P90 yet, every produced estimate is flagged
 * {@link EtaEstimate.preliminary}: it is the source ETA (optionally with a safety
 * buffer for night planning), explicitly labelled as provisional.
 */

/** Where a resolved ETA came from, in the brief's priority order. */
export type EtaSource = "slice_variant" | "gcode_analysis" | "unknown";

export interface EtaEstimate {
  /** Estimated print time in seconds, or null when genuinely unknown. */
  seconds: number | null;
  source: EtaSource;
  /**
   * True whenever the estimate rests on the source ETA rather than a historical
   * P90 (which the farm does not have yet). Always true today — surfaced so the
   * dashboard can mark night recommendations as provisional.
   */
  preliminary: boolean;
}

export interface EtaInputs {
  /** OrcaSlicer's verified ETA from a ready SliceVariant (seconds); null/absent when none. */
  sliceEtaS?: number | null;
  /** ETA read from G-code analysis (seconds); null/absent when none. */
  gcodeEtaS?: number | null;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Resolves a task's ETA following the strict source priority; never fabricates one. */
export function resolveEta(inputs: EtaInputs): EtaEstimate {
  const slice = positive(inputs.sliceEtaS);
  if (slice !== null) {
    return { seconds: Math.round(slice), source: "slice_variant", preliminary: true };
  }
  const gcode = positive(inputs.gcodeEtaS);
  if (gcode !== null) {
    return { seconds: Math.round(gcode), source: "gcode_analysis", preliminary: true };
  }
  return { seconds: null, source: "unknown", preliminary: true };
}

/**
 * Applies a night-planning safety buffer to a known ETA (e.g. 0.2 → +20%). The
 * buffer is a scheduling margin, not a better estimate — the caller still reports
 * the result as {@link EtaEstimate.preliminary}. A non-positive ratio is a no-op.
 */
export function applySafetyBuffer(seconds: number, bufferRatio: number): number {
  // A non-finite ratio (NaN/±Infinity) collapses to no buffer rather than
  // producing a NaN duration — `Math.max(0, NaN)` is NaN, not 0, so it must be
  // screened explicitly before it reaches the multiply.
  const ratio = Number.isFinite(bufferRatio) ? Math.max(0, bufferRatio) : 0;
  return Math.round(seconds * (1 + ratio));
}
