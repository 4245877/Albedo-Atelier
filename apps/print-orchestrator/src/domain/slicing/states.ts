import type { TransitionMap } from "../print/states";
import type { SliceVariantState } from "./types";

/**
 * SliceVariant lifecycle — the technical job state, shaped like
 * {@link ARTIFACT_ANALYSIS_TRANSITIONS}. A worker picks a `pending` variant up
 * (`running`) then finishes it (`ready`/`failed`), or refuses it before running
 * (`blocked` — no runtime, un-approved set, un-sliceable source). Any terminal may
 * be re-run by returning it to `pending`; `running → pending` is the crash-recovery
 * edge for a variant orphaned by a restart.
 */
export const SLICE_VARIANT_TRANSITIONS: TransitionMap<SliceVariantState> = {
  pending: ["running", "blocked", "failed"],
  running: ["ready", "failed", "blocked", "pending"],
  ready: ["pending"],
  failed: ["pending"],
  blocked: ["pending"]
};
