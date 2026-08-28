import type { PrinterLiveStatus } from "../infra/printers/status";

/**
 * The single shared classification of "how did this print end", used by every
 * observer of a finished device (the poller's transition tracking, the filament
 * consumption posting, and the canonical run reconciler). Each used to keep its
 * own copy of the `complete|finish|done` / `cancel|abort|stop` heuristics, which
 * could drift.
 *
 *  - `disconnected` — the device is offline; the status says nothing about the print.
 *  - `failed`       — the device reports an explicit error state.
 *  - `cancelled`    — the device state text names a cancel/abort/stop.
 *  - `completed`    — the device state text names a completion.
 *  - `unknown`      — none of the above; the ending needs operator judgement.
 *
 * ## Why progress is not evidence of success
 *
 * `progressPct >= 99` used to be a fallback that returned `completed`. It is the
 * one inference in this chain that can invent a success out of nothing, and a
 * success is terminal: it completes the task, releases the assignment, deducts
 * filament and opens a bed clearance. A print that lost power, ran out of
 * filament, or was stopped on the machine's own screen at 99.5 % reports exactly
 * what the heuristic was reading — high progress and no longer printing — and
 * became `SUCCEEDED` with a part that was never finished.
 *
 * Nothing is lost by removing it. Both implemented adapters state the ending
 * explicitly: Bambu holds `gcode_state: FINISH` (and `FAILED`), Moonraker holds
 * `print_stats.state: complete` (and `cancelled`, `error`). An ending that
 * matches neither is genuinely ambiguous, and `unknown` is what the run
 * lifecycle already handles — it parks the run for an operator instead of
 * guessing. `progressPct` still travels in the verdict, because "it stopped at
 * 99.5 %" is exactly what that operator needs to read; it simply never decides.
 *
 * Priority is fixed and unchanged: an explicit cancellation or error always wins
 * over anything else. Deliberately says nothing about filament deduction —
 * whether material is deducted depends on whether real consumption data exists,
 * not on the outcome (a cancelled print that measurably consumed filament is
 * still deducted).
 */
export type PrintOutcome = "completed" | "cancelled" | "failed" | "unknown" | "disconnected";

/** What a verdict rests on — so a caller can tell a statement from a silence. */
export type PrintOutcomeEvidence =
  /** The device named the ending in its own state field. */
  | "device_state"
  /** The device reported an error state. */
  | "device_error"
  /** The device is not reachable; it said nothing about the print. */
  | "offline"
  /** The device stopped printing and named nothing. */
  | "none";

export interface PrintOutcomeVerdict {
  outcome: PrintOutcome;
  evidence: PrintOutcomeEvidence;
  /**
   * Progress at the ending, 0–100, or null. **Context, never a verdict** — see
   * the note above. Carried so a refusal or a review prompt can say how far the
   * print got.
   */
  progressPct: number | null;
  /** The device's own words, for the operator's review. */
  stateText: string | null;
}

const COMPLETE_RE = /complete|finish|done/i;
const CANCEL_RE = /cancel|abort|stop/i;

/**
 * How far a print got, when that is worth telling an operator. Not a threshold
 * anything branches on — only wording.
 */
export const NEARLY_DONE_PCT = 99;

export function classifyPrintOutcome(status: PrinterLiveStatus): PrintOutcomeVerdict {
  const progressPct = typeof status.progressPct === "number" ? status.progressPct : null;
  const stateText = status.stateText ?? null;
  const base = { progressPct, stateText };

  if (!status.online) return { ...base, outcome: "disconnected", evidence: "offline" };
  if (status.status === "error") return { ...base, outcome: "failed", evidence: "device_error" };
  if (stateText && CANCEL_RE.test(stateText)) {
    return { ...base, outcome: "cancelled", evidence: "device_state" };
  }
  if (stateText && COMPLETE_RE.test(stateText)) {
    return { ...base, outcome: "completed", evidence: "device_state" };
  }
  return { ...base, outcome: "unknown", evidence: "none" };
}

/**
 * A sentence describing an ambiguous ending, for the operator who has to resolve
 * it. Names the progress precisely *because* it is not being acted on: "почти
 * закончилась" is the case most likely to be waved through, and the one where a
 * wrong guess costs a reprint.
 */
export function describeAmbiguousEnding(verdict: PrintOutcomeVerdict): string {
  const progress =
    verdict.progressPct === null
      ? "прогресс неизвестен"
      : `остановилась на ${verdict.progressPct.toFixed(1)} %`;
  const said = verdict.stateText ? `принтер сообщает «${verdict.stateText}»` : "принтер ничего не сообщил";
  return `печать завершилась без явного признака успеха или отмены (${progress}, ${said}) — требуется проверка`;
}
