import type { SliceScale } from "../print/modelScale";
import type { Metadata } from "../print/types";

/**
 * **Where a slice's size came from — kept with the slice, checked at launch.**
 *
 * G-code is millimetres by definition, so the moment an STL is sliced its output
 * *looks* proven: the scheduler read the variant's box as `scaleKnown: true`. But
 * an STL whose unit nobody confirmed is sliced at factor 1 — the honest default
 * (see `resolveSliceScale`) — and those millimetres are only as true as the guess
 * that the file was in millimetres. Slicing laundered an unknown into a fact.
 *
 * So the variant pins the factor it was cut with and why, and admission compares
 * that against what the source says NOW:
 *
 *  - the source's unit still unconfirmed → the size is **not proven** (the same
 *    `MODEL_SCALE_UNKNOWN` an un-sliced STL gets);
 *  - confirmed, and equal to the pinned factor → proven (a "mm" confirmation made
 *    after slicing at 1 legitimately proves the existing slice);
 *  - confirmed, but different from the pinned factor → the slice is the wrong
 *    size. Not a review — a refusal, until it is sliced again.
 */

/** The `slice_variants.metadata` key the pinned scale lives under. */
export const SLICE_SCALE_KEY = "scale";

export interface PinnedSliceScale {
  /** The factor the slicer was (or will be) given. */
  factor: number;
  /** Why that factor — see {@link SliceScale.reason}. */
  reason: SliceScale["reason"];
}

/** The scale a variant was cut with, or null for a variant recorded before pinning. */
export function readPinnedSliceScale(variant: { metadata: Metadata }): PinnedSliceScale | null {
  const raw = variant.metadata?.[SLICE_SCALE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const factor = rec.factor;
  const reason = rec.reason;
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) return null;
  if (
    reason !== "declared_by_file" &&
    reason !== "confirmed_by_operator" &&
    reason !== "unconfirmed" &&
    reason !== "stale_confirmation"
  ) {
    return null;
  }
  return { factor, reason };
}

export interface SliceScaleStatus {
  /** True when the slice's millimetres are proven for the source as it stands. */
  known: boolean;
  /** True when the slice was provably cut at a different scale than the source's confirmed one. */
  mismatch: boolean;
  reason: string | null;
}

const SAME_FACTOR_EPS = 1e-9;

export function evaluateSliceScale(input: {
  pinned: PinnedSliceScale | null;
  /** What the source's scale resolves to now. */
  current: SliceScale;
  /**
   * For a legacy variant (no pinned scale) whose source is now confirmed at a
   * factor other than 1: does the slice's own box match the size that factor
   * implies? `null` when it cannot be compared.
   */
  legacyBoxMatches?: boolean | null;
}): SliceScaleStatus {
  const { current, pinned } = input;
  if (current.reason === "unconfirmed" || current.reason === "stale_confirmation") {
    return {
      known: false,
      mismatch: false,
      reason:
        current.reason === "stale_confirmation"
          ? "подтверждение единиц исходной модели устарело — размеры нарезки не доказаны"
          : "единицы исходной модели не подтверждены — размеры нарезки не доказаны"
    };
  }
  if (pinned) {
    if (Math.abs(pinned.factor - current.factor) > SAME_FACTOR_EPS * Math.max(1, current.factor)) {
      return {
        known: false,
        mismatch: true,
        reason: `модель нарезана в масштабе ×${fmt(pinned.factor)}, а подтверждённые единицы требуют ×${fmt(current.factor)} — нарежьте заново`
      };
    }
    return { known: true, mismatch: false, reason: null };
  }
  // Legacy: no record of the factor used. Factor 1 is what every slice before
  // the scale fix was cut with, and what a declared unit needs — consistent.
  if (Math.abs(current.factor - 1) <= SAME_FACTOR_EPS) return { known: true, mismatch: false, reason: null };
  if (input.legacyBoxMatches === true) return { known: true, mismatch: false, reason: null };
  if (input.legacyBoxMatches === false) {
    return {
      known: false,
      mismatch: true,
      reason: `размер нарезки не соответствует подтверждённым единицам (×${fmt(current.factor)}) — нарежьте заново`
    };
  }
  return {
    known: false,
    mismatch: false,
    reason: "неизвестно, в каком масштабе нарезан этот вариант — проверьте размер или нарежьте заново"
  };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
