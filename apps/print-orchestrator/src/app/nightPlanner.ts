import type { NightCandidate, QueueJob } from "../domain/dashboard/types";
import { parseLocalTimeWindow } from "../shared/time";
import type { PrinterConfig } from "../infra/printers/config";

/**
 * The canonical night-readiness decision for one queue job — the SINGLE source
 * of night blockers, computed against the SQLite task/artifact/analysis + live
 * printer status by {@link FarmStore.nightGateInfo}, which delegates to the
 * `evaluateDispatchGate(mode: "night")` chokepoint that the *physical* start
 * (`POST /api/queue/night/start`) enforces inside its reserve transaction.
 *
 * There is deliberately no second, projection-side heuristic: the dashboard's
 * night section shows exactly the reasons the dispatch gate will refuse, so the
 * display can never disagree with enforcement (they are the same rule set).
 */
export interface NightGateDecision {
  /** Hard reasons the job cannot launch tonight; empty → startable. */
  blockers: string[];
  /** Immutable preview identity the operator confirms with night-start. */
  taskId: string;
  taskVersion: number | null;
  artifactSha256: string | null;
}

/**
 * One night-print candidate with the reasoning behind it. `candidate` is the
 * dashboard-facing projection; `blockers` are the concrete, hard reasons the job
 * cannot actually be launched tonight (empty → it is startable). This keeps the
 * suggestion honest: the UI can show a recommendation while startNight refuses
 * anything with blockers instead of pretending to run it.
 */
export interface NightPlanEntry {
  candidate: NightCandidate;
  job: QueueJob;
  printer: PrinterConfig | undefined;
  blockers: string[];
}

export interface NightPlanContext {
  window: string;
  /** Resolves a job's printer to its config — for the candidate's display name only. */
  resolvePrinter: (job: QueueJob) => PrinterConfig | undefined;
  /**
   * The canonical night-readiness decision (see {@link NightGateDecision}). It is
   * REQUIRED: the night plan carries no independent rules of its own — every
   * blocker it shows comes from here, so it always matches what the dispatch gate
   * enforces. `null` is only returned when the task cannot be found at all.
   */
  nightGate: (job: QueueJob) => NightGateDecision | null;
}

/** Minutes of a "HH:MM – HH:MM" window, wrapping across midnight. */
export function windowLengthMinutes(window: string): number | null {
  const parsed = parseLocalTimeWindow(window);
  if (!parsed) return null;
  const { startMinutes, endMinutes } = parsed;
  if (startMinutes === endMinutes) return 24 * 60;
  return startMinutes < endMinutes ? endMinutes - startMinutes : 24 * 60 - startMinutes + endMinutes;
}

/**
 * Parses a human ETA like "2ч", "2 ч 30 м", "90 м", "1h30" into minutes.
 * Returns null when nothing recognisable is present (unknown, not zero).
 */
export function parseEtaMinutes(text: string): number | null {
  if (!text) return null;
  const hours = /(\d+(?:[.,]\d+)?)\s*(?:ч|час|h)/i.exec(text);
  const minutes = /(\d+)\s*(?:м|мин|m(?!ч))/i.exec(text);
  let total = 0;
  let matched = false;
  if (hours) {
    total += Math.round(parseFloat(hours[1].replace(",", ".")) * 60);
    matched = true;
  }
  if (minutes) {
    total += Number(minutes[1]);
    matched = true;
  }
  return matched ? total : null;
}

function riskLabel(risk: number): string {
  if (risk < 35) return "низкий риск";
  if (risk < 65) return "умеренный риск";
  return "высокий риск";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** "неизвестно" material values that cannot be compared. */
function isUnknownMaterial(value: string): boolean {
  const material = value.trim();
  return !material || material === "—";
}

/**
 * Whether a job's declared material contradicts what the printer is declared
 * to hold. The loaded value may list alternatives ("PLA / PETG / TPU"), so it
 * is tokenized and the job's material must match one token (case-insensitive).
 * Unknown on either side ("", "—") is NOT a mismatch — there is nothing to
 * contradict; only a concrete disagreement reports true.
 */
export function materialsIncompatible(needed: string, loaded: string): boolean {
  if (isUnknownMaterial(needed) || isUnknownMaterial(loaded)) return false;
  const wanted = needed.trim().toLowerCase();
  return !loaded
    .split(/[/,;+]/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted);
}

/**
 * Presentation-only risk for ranking + the `risk-meter` — NOT a rule. A startable
 * job (no blockers) reads low; each hard blocker raises it steeply so "safest
 * first" always surfaces the blocker-free candidate; a longer (but fitting) print
 * nudges it up a little. It never decides startability — `blockers` does.
 */
function riskFrom(blockerCount: number, etaMinutes: number | null, windowMinutes: number | null): number {
  let risk = 12 + blockerCount * 22;
  if (etaMinutes !== null && windowMinutes) {
    risk += Math.min(30, (etaMinutes / windowMinutes) * 30);
  }
  return clamp(risk, 5, 96);
}

/**
 * Projects one queue job into a night candidate. It holds NO night rules of its
 * own: every blocker is the canonical {@link NightPlanContext.nightGate} decision
 * — the very reasons `evaluateDispatchGate(mode: "night")` will refuse the
 * physical start — so the dashboard can never claim a job startable that the
 * server would refuse (or vice versa). The printer name and risk are display-only.
 */
function evaluate(job: QueueJob, ctx: NightPlanContext, windowMinutes: number | null): NightPlanEntry {
  const printer = ctx.resolvePrinter(job);
  const gate = ctx.nightGate(job);
  // A null gate means the task vanished between projection and lookup — treat it
  // as un-verifiable rather than silently startable.
  const blockers = gate
    ? [...gate.blockers]
    : ["готовность задания не удалось проверить — обновите очередь"];

  const finalRisk = riskFrom(blockers.length, parseEtaMinutes(job.eta), windowMinutes);
  return {
    job,
    printer,
    blockers,
    candidate: {
      title: job.title,
      printer: printer?.name ?? job.printer,
      eta: job.eta,
      risk: finalRisk,
      riskLabel: riskLabel(finalRisk),
      // The dashboard shows exactly these reasons and disables the start button,
      // instead of claiming the job "fits the window" while the gate would refuse.
      blockers: [...blockers],
      taskId: gate?.taskId ?? job.id,
      taskVersion: gate?.taskVersion ?? null,
      artifactSha256: gate?.artifactSha256 ?? null
    }
  };
}

/**
 * Builds ranked night-print candidates from the queue. Only jobs ready to run
 * are considered; when any are explicitly flagged `night`, the selection is
 * restricted to those, otherwise every ready job is a candidate. Sorted safest
 * first, so pick 0 is always the lowest-risk recommendation.
 */
export function buildNightPlan(queue: QueueJob[], ctx: NightPlanContext): NightPlanEntry[] {
  const ready = queue.filter((job) => job.status === "ready");
  const nightFlagged = ready.filter((job) => job.night === true);
  const pool = nightFlagged.length > 0 ? nightFlagged : ready;

  const windowMinutes = windowLengthMinutes(ctx.window);
  return pool
    .map((job) => evaluate(job, ctx, windowMinutes))
    .sort((a, b) => a.candidate.risk - b.candidate.risk);
}
