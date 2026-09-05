import { sameJobFile } from "../infra/printers/files/jobIdentity";
import type { PrintRunState } from "../domain/print/types";
import type { PrinterLiveStatus } from "../infra/printers/status/types";

/**
 * **Can this orchestrator be restarted right now without losing anything the
 * database cannot give back?**
 *
 * The question a redeploy actually needs answered, asked once and answered in
 * one place. It used to be asked as "is any printer busy?", which is a
 * different — and much cruder — question: the printers keep printing across a
 * container recreate either way, and since
 * {@link file://./printerPoller.ts PrinterPoller.hydrateRunFromCanonical} the
 * poller rebuilds a mid-flight print's identity from the canonical
 * {@link PrintRun} in SQLite. A print dispatched through the queue therefore
 * survives a restart with its run id (so the deduction idempotency key holds),
 * its start time (so the duration metric holds) and its AMS baseline (so the
 * filament auto-deduction holds).
 *
 * What does NOT survive is narrow and specific, and this module names each case
 * rather than collapsing them into a headcount:
 *
 *  - a print with no canonical run — started on the printer itself, not
 *    dispatched — has no identity to re-adopt, so its completion lands in
 *    `consumeForPrint` with `run === undefined` and becomes a manual debt;
 *  - a canonical run the device does not confirm (a different file on the
 *    plate, or a run still PENDING/UNKNOWN) is not adoptable either — `adoptRun`
 *    only returns RUNNING/PAUSED rows, and only the matching file is ours;
 *  - a Bambu run whose AMS baseline was never persisted adopts a baseline taken
 *    mid-print, which under-deducts;
 *  - a completion that lands inside the restart window is observed by neither
 *    the old process nor the new one, so
 *    {@link file://./dispatch/runLifecycle.ts RunLifecycleService.reconcile}
 *    correctly refuses to guess and parks the run in `UNKNOWN` for an operator.
 *
 * Two costs are accepted rather than guarded, because they are bounded and
 * cosmetic next to what the guards above protect: a restart forfeits at most one
 * poll interval of accrued printing-time per printer (`accruePrintingTime` skips
 * the first interval, having no anchor to measure from), and the "changed at"
 * label a card shows resets. Neither is recoverable state; neither is worth
 * holding a deploy for.
 *
 * Everything here is a pure function of the inputs — no store, no clock beyond
 * the injected `now` — so the rules are unit-testable and the HTTP layer only
 * has to gather the facts.
 */

/** Why a restart would cost something for one printer. */
export type RestartRisk =
  /** Busy, but nothing in the database claims the print — an external start. */
  | "untracked-print"
  /** The canonical runs could not be read at all (store closed): fail closed. */
  | "runs-unavailable"
  /** A run exists but is not RUNNING/PAUSED, so `adoptRun` would decline it. */
  | "run-not-attached"
  /** The device is printing a different file than the run claims. */
  | "identity-mismatch"
  /** The run carries no start time, so the duration metric cannot be rebuilt. */
  | "no-start-time"
  /** Bambu run with no persisted AMS baseline — the deduction would under-count. */
  | "no-ams-baseline"
  /** The print is likely to finish inside the restart window. */
  | "finishing-soon"
  /** Neither remaining time nor progress is known, so the above cannot be ruled out. */
  | "progress-unknown";

/** What a restart would do to one printer's accounting. */
export type RestartVerdict =
  /** Not printing — a restart cannot disturb it. */
  | "idle"
  /** Printing, and everything needed to re-adopt it is durable. */
  | "recoverable"
  /** Printing, and a restart would lose something only a human can restore. */
  | "at-risk";

/** The canonical run holding a printer, reduced to what this decision needs. */
export interface CanonicalRunFacts {
  id: string;
  state: PrintRunState;
  file: string | null;
  startedAt: string | null;
  /** Whether an AMS baseline was persisted onto the run at start. */
  hasAmsBaseline: boolean;
}

/** One printer's inputs: what it is, what it reports, what the database holds. */
export interface RestartSafetyInput {
  id: string;
  name: string;
  protocol: string;
  status: PrinterLiveStatus | null | undefined;
  /**
   * The canonical active run, `null` when there is none — and `undefined` when
   * the store could not be consulted, which is emphatically not the same thing
   * and is reported as `runs-unavailable`.
   */
  run: CanonicalRunFacts | null | undefined;
}

export interface PrinterRestartAssessment {
  printerId: string;
  name: string;
  verdict: RestartVerdict;
  risks: RestartRisk[];
  /** Whether the device is printing or paused right now. */
  busy: boolean;
  online: boolean;
  runId: string | null;
  progressPct: number | null;
  /** Minutes left, as reported or as estimated from progress + elapsed time. */
  remainingMinutes: number | null;
  /** True when `remainingMinutes` was derived rather than reported. */
  remainingEstimated: boolean;
  currentFile: string | null;
}

export interface RestartSafetyAssessment {
  generatedAt: string;
  /** The outage this assessment was made against, in seconds. */
  restartWindowSeconds: number;
  /** Printers currently printing or paused. */
  activePrints: number;
  /** Of those, the ones a restart would fully recover. */
  recoverable: number;
  /** Of those, the ones a restart would cost something. */
  atRisk: number;
  /**
   * The single answer a deploy needs: may the orchestrator be recreated now
   * without losing state a human would have to reconstruct?
   */
  safeToRestart: boolean;
  printers: PrinterRestartAssessment[];
}

/**
 * How long the orchestrator is assumed to be blind across a recreate: container
 * stop, image swap, start, and the first poll landing. The healthcheck alone
 * allows 60 s of start period, and a cold Bambu MQTT connect is the slow part,
 * so three minutes is the conservative reading — this number only ever makes
 * the gate stricter.
 */
export const DEFAULT_RESTART_WINDOW_SECONDS = 180;

const BUSY_STATES = new Set<PrinterLiveStatus["status"]>(["printing", "paused"]);
const ADOPTABLE_RUN_STATES = new Set<PrintRunState>(["RUNNING", "PAUSED"]);

/**
 * Minutes left on this print, preferring what the device says and falling back
 * to what progress and elapsed time imply.
 *
 * The fallback is deliberate rather than decorative: a device that publishes
 * progress but no ETA (every Bambu pause, most Creality states) would otherwise
 * be `progress-unknown` and block every deploy. `elapsed * (1 - p) / p` assumes
 * a constant rate, which is wrong in detail and right in direction — it is used
 * only to ask "could this finish in the next few minutes", and it errs toward
 * "yes" for prints that have barely started.
 */
function remainingMinutesFor(
  status: PrinterLiveStatus,
  run: CanonicalRunFacts | null | undefined,
  nowMs: number
): { minutes: number | null; estimated: boolean } {
  if (typeof status.remainingMinutes === "number" && Number.isFinite(status.remainingMinutes)) {
    return { minutes: Math.max(0, status.remainingMinutes), estimated: false };
  }
  const pct = status.progressPct;
  const startedAtMs = run?.startedAt ? Date.parse(run.startedAt) : NaN;
  if (
    typeof pct === "number" &&
    Number.isFinite(pct) &&
    pct > 0 &&
    pct < 100 &&
    Number.isFinite(startedAtMs)
  ) {
    const elapsedMs = nowMs - startedAtMs;
    if (elapsedMs > 0) {
      const fraction = pct / 100;
      const remainingMs = (elapsedMs * (1 - fraction)) / fraction;
      return { minutes: Math.max(0, remainingMs / 60_000), estimated: true };
    }
  }
  // A print the device reports as complete-but-still-busy is finishing by
  // definition; say so rather than calling it unknown.
  if (typeof pct === "number" && pct >= 100) return { minutes: 0, estimated: true };
  return { minutes: null, estimated: false };
}

/** Classifies one printer. Pure; `now` is injected so tests own the clock. */
export function assessPrinterRestart(
  input: RestartSafetyInput,
  options: { restartWindowSeconds?: number; now?: () => Date } = {}
): PrinterRestartAssessment {
  const windowSeconds = options.restartWindowSeconds ?? DEFAULT_RESTART_WINDOW_SECONDS;
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const status = input.status ?? null;
  const run = input.run;
  const online = status?.online ?? false;
  const busy = status !== null && BUSY_STATES.has(status.status);

  const base = {
    printerId: input.id,
    name: input.name,
    busy,
    online,
    runId: run?.id ?? null,
    progressPct: status?.progressPct ?? null,
    currentFile: status?.currentFile ?? null
  };

  // An active canonical run outlives the device that stopped answering, which is
  // exactly why it is tracked in SQLite — a printer that dropped off the network
  // mid-print is still a print in flight, and a restart still has to be able to
  // re-adopt it when it comes back.
  const runIsActive = run !== undefined && run !== null && ADOPTABLE_RUN_STATES.has(run.state);
  const held = busy || (runIsActive && !online);

  if (!held) {
    return {
      ...base,
      verdict: "idle",
      risks: [],
      remainingMinutes: null,
      remainingEstimated: false
    };
  }

  const risks: RestartRisk[] = [];

  if (run === undefined) {
    // The store could not be consulted. Not "there is no run" — unknowable, and
    // unknowable about a running print fails closed.
    risks.push("runs-unavailable");
  } else if (run === null) {
    risks.push("untracked-print");
  } else {
    if (!ADOPTABLE_RUN_STATES.has(run.state)) risks.push("run-not-attached");
    // Identity is only checkable while the device is naming a file. An offline
    // printer names nothing, and silence is not a mismatch.
    if (busy && status?.currentFile && !sameJobFile(status.currentFile, run.file)) {
      risks.push("identity-mismatch");
    }
    if (!run.startedAt || Number.isNaN(Date.parse(run.startedAt))) risks.push("no-start-time");
    if (input.protocol === "bambu" && !run.hasAmsBaseline) risks.push("no-ams-baseline");
  }

  // Timing only matters while the device is actually observable: a completion on
  // an offline printer is unobserved with or without a restart, so a restart
  // costs nothing extra there and the window check would be pure noise.
  let remaining: { minutes: number | null; estimated: boolean } = {
    minutes: null,
    estimated: false
  };
  if (busy && status) {
    remaining = remainingMinutesFor(status, run ?? null, nowMs);
    if (remaining.minutes === null) {
      risks.push("progress-unknown");
    } else if (remaining.minutes * 60 <= windowSeconds) {
      risks.push("finishing-soon");
    }
  }

  return {
    ...base,
    verdict: risks.length === 0 ? "recoverable" : "at-risk",
    risks,
    remainingMinutes: remaining.minutes,
    remainingEstimated: remaining.estimated
  };
}

/** Classifies the whole farm and answers the one question a deploy asks. */
export function assessRestartSafety(
  printers: readonly RestartSafetyInput[],
  options: { restartWindowSeconds?: number; now?: () => Date } = {}
): RestartSafetyAssessment {
  const windowSeconds = options.restartWindowSeconds ?? DEFAULT_RESTART_WINDOW_SECONDS;
  const now = options.now ?? (() => new Date());
  const assessed = printers.map((printer) =>
    assessPrinterRestart(printer, { restartWindowSeconds: windowSeconds, now })
  );
  const active = assessed.filter((p) => p.verdict !== "idle");
  const atRisk = active.filter((p) => p.verdict === "at-risk");
  return {
    generatedAt: now().toISOString(),
    restartWindowSeconds: windowSeconds,
    activePrints: active.length,
    recoverable: active.length - atRisk.length,
    atRisk: atRisk.length,
    safeToRestart: atRisk.length === 0,
    printers: assessed
  };
}
