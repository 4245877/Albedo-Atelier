import { isTimeoutError } from "../shared/fetchWithTimeout";
import { PrinterCommandError, type PrinterLiveStatus } from "../infra/printers/status";
import type { StartGuard } from "../domain/print/types";
import type { StartGuardRepository } from "../domain/print/repositories";

/** The port the command service depends on — the SQLite repo or an in-memory fake. */
export type StartGuardStore = StartGuardRepository;

/**
 * The outcome of trying to hand a start command to a device, from the point of
 * view of "could this have physically started a print?".
 *
 *   - `rejected` — the device provably never began: a definitive rejection
 *     (file-not-found) or the request never reached it (connection refused,
 *     DNS failure). Safe to clear the guard and let a retry through.
 *   - `unknown`  — the response was lost/timed out, or the device answered
 *     ambiguously (5xx, reset mid-exchange). The print may or may not be
 *     running; the guard must be **held**, never auto-retried.
 *
 * Fail-closed: anything not clearly a `rejected` is treated as `unknown`.
 */
export type DispatchOutcome = "rejected" | "unknown";

/** Node system error codes that mean the request never reached the device. */
const NEVER_REACHED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"]);

/**
 * Classifies a failed `sendPrinterStart`. A timeout is the dangerous case —
 * the command left the orchestrator and the response was lost, so the print
 * may well be running: `unknown`. A driver-reported definitive rejection
 * (Moonraker 404 for a missing file) is `rejected`. A pre-connection network
 * error (refused/DNS) never reached the device: `rejected`. Everything else
 * (HTTP 5xx, mid-exchange reset) is `unknown`.
 */
export function classifyDispatchError(error: unknown): DispatchOutcome {
  if (isTimeoutError(error)) return "unknown";
  if (error instanceof PrinterCommandError) {
    return error.definitivelyRejected ? "rejected" : "unknown";
  }
  const code =
    (error as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code ??
    (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && NEVER_REACHED_CODES.has(code)) return "rejected";
  return "unknown";
}

/**
 * What to do when a durable guard already exists for a printer and a fresh
 * device status has just been read, before dispatching a new start.
 *
 *   - `already-running` — the device is printing the guarded/target file: the
 *     earlier start took. Do not dispatch again; the caller treats the job as
 *     started.
 *   - `busy-other`      — the device is printing a *different* file: our guarded
 *     start never ran, but the printer is busy now. Refuse as busy; the guard
 *     is stale and cleared.
 *   - `held`            — the outcome cannot be confirmed (idle after an
 *     unconfirmed/accepted start, or the device is offline/errored/unknown).
 *     Fail-closed: refuse and require operator reconciliation. Never dispatch.
 */
export type GuardDecision = "already-running" | "busy-other" | "held";

/** Loose filename match — the device may report a path while the guard holds a basename. */
function sameFile(a: string | null, b: string): boolean {
  if (!a) return false;
  if (a === b) return true;
  const baseA = a.split(/[\\/]/).pop() ?? a;
  const baseB = b.split(/[\\/]/).pop() ?? b;
  return baseA === baseB;
}

/**
 * Decides, from an existing guard and a freshly-read device status, whether a
 * new start for `targetFile` may proceed. Pure and total — the single place the
 * "reconcile before re-dispatch" rule lives, so it can be exhaustively tested.
 */
export function reconcileStartGuard(
  guard: StartGuard,
  status: PrinterLiveStatus,
  targetFile: string
): GuardDecision {
  const busy = status.status === "printing" || status.status === "paused";
  if (busy) {
    if (sameFile(status.currentFile, guard.file) || sameFile(status.currentFile, targetFile)) {
      return "already-running";
    }
    return "busy-other";
  }
  // Not busy: idle / unknown / offline / error. Even an ACKED start that is now
  // idle is not safe to re-dispatch — it may already have printed and finished,
  // and a second dispatch would be exactly the double print we must prevent. We
  // only ever conclude "started" from a *positive* printing observation above.
  return "held";
}
