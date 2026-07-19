import type { PrinterLiveStatus } from "../infra/printers/status";

/**
 * The single shared classification of "how did this print end", used by both
 * observers of a finished device (the poller's transition tracking and the
 * canonical run reconciler). Previously each kept its own copy of the
 * `complete|finish|done` / `cancel|abort|stop` heuristics, which could drift.
 *
 *  - `disconnected` — the device is offline; the status says nothing about the print.
 *  - `failed`       — the device reports an explicit error state.
 *  - `cancelled`    — the device state text names a cancel/abort/stop.
 *  - `completed`    — the device state text names a completion, or — only as a
 *                     fallback heuristic — progress reached ≥ 99 %.
 *  - `unknown`      — none of the above; the ending needs operator judgement.
 *
 * Priority is fixed: explicit cancellation and error ALWAYS win over the
 * progress heuristic — a print cancelled at 99.5 % must classify as cancelled.
 * Deliberately says nothing about filament deduction: whether material is
 * deducted depends on whether real consumption data exists, not on the outcome
 * (a cancelled print that measurably consumed filament is still deducted).
 */
export type PrintOutcome = "completed" | "cancelled" | "failed" | "unknown" | "disconnected";

const COMPLETE_RE = /complete|finish|done/i;
const CANCEL_RE = /cancel|abort|stop/i;
/** Progress used only as the last-resort completion heuristic. */
const COMPLETE_PROGRESS_PCT = 99;

export function classifyPrintOutcome(status: PrinterLiveStatus): PrintOutcome {
  if (!status.online) return "disconnected";
  if (status.status === "error") return "failed";
  if (status.stateText && CANCEL_RE.test(status.stateText)) return "cancelled";
  if (status.stateText && COMPLETE_RE.test(status.stateText)) return "completed";
  if (status.progressPct !== null && status.progressPct >= COMPLETE_PROGRESS_PCT) {
    return "completed";
  }
  return "unknown";
}
