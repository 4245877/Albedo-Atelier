import type { Artifact, PrintTask } from "../../domain/print/types";
import {
  hardBlockers,
  type EligibilityReason,
  type EligibilityResult
} from "../../domain/dispatch/reasons";
import type { DispatchEligibility, DispatchMode } from "../../domain/dispatch/eligibility";

/**
 * Adapters between the authoritative
 * {@link file://../../domain/dispatch/eligibility.ts DispatchEligibility} and the
 * legacy blocker-list shape the dashboard night section and existing callers
 * consume.
 *
 * This file used to carry a *second, independent* implementation of the admission
 * rules, which is exactly the divergence the brief calls out: it never checked
 * nozzle, build volume, G-code flavor, target printer or the confirmed plan, and
 * its night-window arithmetic disagreed with the scheduler's. All rules now live
 * in the domain component; what remains here is projection only — no decisions.
 */

/** One hard reason a dispatch must not happen; `code` is stable for tests/UI. */
export interface DispatchBlocker {
  code: string;
  message: string;
}

/** The blocking reasons of an eligibility result, in the legacy flat shape. */
export function blockersOf(result: EligibilityResult): DispatchBlocker[] {
  return result.reasons
    .filter((r) => r.severity === "blocker")
    .map((r) => ({ code: r.code, message: r.message }));
}

/** The non-blocking reasons — what an audited operator override may clear. */
export function warningsOf(result: EligibilityResult): DispatchBlocker[] {
  return result.reasons
    .filter((r) => r.severity === "warning")
    .map((r) => ({ code: r.code, message: r.message }));
}

/**
 * Whether `result` may be started once `overriddenCodes` are waved through by an
 * operator. Hard rules (see `NON_OVERRIDABLE`) are never clearable, so a start
 * over an occupied bed, a wrong-target file or a busy printer stays refused no
 * matter what the operator ticks.
 */
export function remainingBlockers(
  result: EligibilityResult,
  overriddenCodes: readonly string[] = []
): EligibilityReason[] {
  const overridden = new Set(overriddenCodes);
  const hard = new Set(hardBlockers(result).map((r) => r.code));
  return result.reasons.filter(
    (r) => r.severity === "blocker" && (hard.has(r.code) || !overridden.has(r.code))
  );
}

/** The on-device file a dispatch would start: the task's file hint first, then the artifact locator. */
export function resolveDispatchFile(task: PrintTask, artifact: Artifact | null): string | null {
  // The task's `metadata.file` is the on-device path in every flow (legacy add,
  // import, scheduler); an artifact's `source` doubles as the on-device path
  // only for legacy name-only artifacts (content-addressed blobs use keys).
  const metaFile = task.metadata.file;
  if (typeof metaFile === "string" && metaFile.trim()) return metaFile.trim();
  if (artifact && artifact.sha256 === null && artifact.source) return artifact.source;
  return null;
}

export type { DispatchMode, DispatchEligibility };
