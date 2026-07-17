/**
 * The manual-scheduler placement heuristic.
 *
 * Deliberately a *transparent greedy heuristic*, not a solver (the brief:
 * "используй прозрачную эвристику, а не сложный solver"). Two phases:
 *
 *   1. **Order** the tasks by an explainable urgency score built from the exact
 *      factors the brief lists — pinned bindings, deadline proximity, priority,
 *      task age, and how few printers can take it (scarcer → scheduled earlier).
 *   2. **Place** each task, in that order, on the compatible printer with the
 *      best per-candidate score: soonest free, fewest material/nozzle swaps, and
 *      a bonus for keeping it where the previous (confirmed) plan had it — the
 *      "stability of a confirmed plan" the brief asks for.
 *
 * Every assignment carries its full {@link PlannerAssignment.scoreBreakdown},
 * the runner-up {@link PlannerAssignment.alternatives}, a plain-language
 * {@link PlannerAssignment.reason}, and any {@link PlannerAssignment.warnings}
 * (deadline risk, material/nozzle swap, unknown ETA). Unplaceable tasks come back
 * in {@link PlannerResult.unplaced} with a reason — nothing is silently dropped.
 *
 * The planner never fabricates an ETA: a task whose ETA is unknown is still
 * placed, its `etaSeconds`/`endMs` stay null, a warning is attached, and the
 * printer's free-time is advanced by a disclosed scheduling assumption only.
 */

export interface PlannerTaskInput {
  taskId: string;
  title: string;
  priority: number;
  createdAtMs: number;
  notBeforeMs: number | null;
  deadlineMs: number | null;
  pinnedPrinterId: string | null;
  material: string | null;
  requiredNozzleMm: number | null;
  /** Resolved ETA in seconds, or null when unknown (never fabricated). */
  etaSeconds: number | null;
  /** Printer ids where the task is `compatible` — the only ids it may be placed on. */
  compatiblePrinterIds: string[];
  /** Printer id this task held in the base plan (for stability); null when none. */
  previousPrinterId: string | null;
  /**
   * The task's 0-based position in the operator's manual queue order (front = 0),
   * so a manual reorder actually shifts scheduling urgency (the dashboard promises
   * "порядок = приоритет планирования"). Undefined leaves ordering to the other
   * factors alone.
   */
  queueRank?: number;
}

export interface PlannerPrinterInput {
  printerId: string;
  name: string;
  /** Epoch ms at which the printer becomes free (now if already idle). */
  freeAtMs: number;
  /**
   * True when {@link freeAtMs} is an *estimate* rather than an observed fact —
   * e.g. the printer is currently printing but reported no remaining time, so the
   * free moment was assumed. A task that has to wait on such a printer gets an
   * honest warning instead of a promise the timeline cannot keep.
   */
  freeAtEstimated?: boolean;
  currentMaterial: string | null;
  currentNozzleMm: number | null;
}

export interface PlannerWeights {
  priority: number;
  agePerDay: number;
  deadlineUrgency: number;
  scarcity: number;
  /** Boost for the manual queue order: front-of-queue gets the most, decaying by rank. */
  queueOrder: number;
  waitPerHour: number;
  materialSwap: number;
  nozzleSwap: number;
  stability: number;
  deadlineOk: number;
  deadlineMiss: number;
}

export const DEFAULT_WEIGHTS: PlannerWeights = {
  priority: 10,
  agePerDay: 4,
  deadlineUrgency: 200,
  scarcity: 8,
  queueOrder: 8,
  waitPerHour: 6,
  materialSwap: 20,
  nozzleSwap: 25,
  stability: 12,
  deadlineOk: 6,
  deadlineMiss: 60
};

export interface PlannerConfig {
  nowMs: number;
  /**
   * Scheduling-only assumption (seconds) for advancing a printer's free-time when
   * a task's real ETA is unknown. Never shown as the task's ETA — the assignment's
   * `etaSeconds` stays null and a warning is attached.
   */
  unknownEtaAssumptionS: number;
  weights?: Partial<PlannerWeights>;
}

export interface ScoreComponent {
  label: string;
  value: number;
}

export interface PlannerAssignment {
  taskId: string;
  printerId: string;
  startMs: number;
  /** Projected end, or null when the ETA is unknown. */
  endMs: number | null;
  etaSeconds: number | null;
  score: number;
  scoreBreakdown: ScoreComponent[];
  reason: string;
  alternatives: { printerId: string; score: number }[];
  warnings: string[];
}

export interface PlannerResult {
  assignments: PlannerAssignment[];
  unplaced: { taskId: string; reason: string }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function materialFamily(material: string): string {
  return material.toUpperCase().split(/[\s\-_/,|+]+/).filter(Boolean)[0] ?? "";
}

function materialsDiffer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return materialFamily(a) !== materialFamily(b);
}

/** Urgency used only to order tasks before greedy placement (higher = earlier). */
export function urgencyScore(
  task: PlannerTaskInput,
  weights: PlannerWeights,
  nowMs: number
): number {
  let score = 0;
  score += task.priority * weights.priority;
  // Guard every timestamp term against a non-finite value (NaN/±Infinity): a
  // single NaN would poison `score`, and NaN comparisons make the ordering sort
  // non-deterministically. The API never feeds a NaN here (it canonicalises
  // timestamps), but this is a public domain function, so it defends itself.
  const ageMs = Number.isFinite(task.createdAtMs) ? nowMs - task.createdAtMs : 0;
  score += Math.max(0, ageMs / DAY_MS) * weights.agePerDay;
  if (task.deadlineMs !== null && Number.isFinite(task.deadlineMs)) {
    const hoursLeft = Math.max(0.5, (task.deadlineMs - nowMs) / HOUR_MS);
    score += weights.deadlineUrgency / hoursLeft;
  }
  const options = Math.max(1, task.compatiblePrinterIds.length);
  score += weights.scarcity / options;
  if (task.queueRank !== undefined && task.queueRank >= 0) {
    // Manual queue order: decays with rank so moving a task up the queue lifts it
    // in planning (a real effect, not just a tiebreak) without overriding a hard
    // deadline or a pin.
    score += weights.queueOrder / (1 + task.queueRank);
  }
  if (task.pinnedPrinterId) score += 1000; // pinned work is scheduled first
  return score;
}

interface PrinterState {
  printerId: string;
  name: string;
  freeAtMs: number;
  freeAtEstimated: boolean;
  material: string | null;
  nozzleMm: number | null;
}

export function buildPlan(
  tasks: PlannerTaskInput[],
  printers: PlannerPrinterInput[],
  config: PlannerConfig
): PlannerResult {
  const weights = { ...DEFAULT_WEIGHTS, ...(config.weights ?? {}) };
  const now = config.nowMs;

  const state = new Map<string, PrinterState>();
  for (const p of printers) {
    state.set(p.printerId, {
      printerId: p.printerId,
      name: p.name,
      freeAtMs: Math.max(now, p.freeAtMs),
      freeAtEstimated: p.freeAtEstimated === true && p.freeAtMs > now,
      material: p.currentMaterial,
      nozzleMm: p.currentNozzleMm
    });
  }

  const ordered = [...tasks].sort((a, b) => {
    const ua = urgencyScore(a, weights, now);
    const ub = urgencyScore(b, weights, now);
    if (ub !== ua) return ub - ua;
    // `|| 0` keeps the tiebreak total even if a createdAtMs is non-finite (a real
    // epoch is a large positive number, so it is unaffected) — older first on ties.
    return (a.createdAtMs || 0) - (b.createdAtMs || 0);
  });

  const assignments: PlannerAssignment[] = [];
  const unplaced: { taskId: string; reason: string }[] = [];

  for (const task of ordered) {
    let candidateIds = task.compatiblePrinterIds.filter((id) => state.has(id));
    if (task.pinnedPrinterId) {
      candidateIds = candidateIds.filter((id) => id === task.pinnedPrinterId);
      if (candidateIds.length === 0) {
        unplaced.push({
          taskId: task.taskId,
          reason: `Закреплён принтер ${task.pinnedPrinterId}, но он несовместим или отсутствует`
        });
        continue;
      }
    }
    if (candidateIds.length === 0) {
      unplaced.push({ taskId: task.taskId, reason: "Нет совместимых принтеров" });
      continue;
    }

    const scored = candidateIds
      .map((id) => scoreCandidate(task, state.get(id)!, weights, now))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const chosen = state.get(best.printerId)!;

    const start = Math.max(chosen.freeAtMs, task.notBeforeMs ?? now, now);
    const durationS =
      task.etaSeconds !== null ? task.etaSeconds : config.unknownEtaAssumptionS;
    const end = task.etaSeconds !== null ? start + task.etaSeconds * 1000 : null;

    const warnings: string[] = [];
    if (chosen.freeAtEstimated && start > now + 60_000) {
      warnings.push(
        "Освобождение принтера оценено приблизительно — текущая печать без известного остатка времени"
      );
    }
    if (task.etaSeconds === null) {
      warnings.push("ETA неизвестна — время освобождения принтера оценено приблизительно");
    }
    if (materialsDiffer(task.material, chosen.material)) {
      warnings.push(`Смена материала: ${chosen.material} → ${task.material}`);
    }
    if (
      task.requiredNozzleMm !== null &&
      chosen.nozzleMm !== null &&
      Math.abs(task.requiredNozzleMm - chosen.nozzleMm) > 0.001
    ) {
      warnings.push(`Смена сопла: ${chosen.nozzleMm} → ${task.requiredNozzleMm} мм`);
    }
    if (task.deadlineMs !== null && end !== null && end > task.deadlineMs) {
      warnings.push("Прогноз выходит за дедлайн");
    }
    if (start > now + 60_000) {
      warnings.push(`Старт после освобождения принтера (~${Math.round((start - now) / 60000)} мин ожидания)`);
    }

    assignments.push({
      taskId: task.taskId,
      printerId: best.printerId,
      startMs: start,
      endMs: end,
      etaSeconds: task.etaSeconds,
      score: round(best.score),
      scoreBreakdown: best.breakdown,
      reason: buildReason(chosen, best, task, scored.length),
      alternatives: scored.slice(1, 4).map((s) => ({ printerId: s.printerId, score: round(s.score) })),
      warnings
    });

    // Advance the chosen printer's state so the next task sees it occupied. Once
    // any placement rests on an estimate (an estimated free-time, or this task's
    // own unknown ETA), everything scheduled after it on this printer is an
    // estimate too — carry the flag forward so later tasks warn honestly.
    chosen.freeAtMs = start + durationS * 1000;
    chosen.freeAtEstimated = chosen.freeAtEstimated || task.etaSeconds === null;
    if (task.material) chosen.material = task.material;
    if (task.requiredNozzleMm !== null) chosen.nozzleMm = task.requiredNozzleMm;
  }

  return { assignments, unplaced };
}

interface CandidateScore {
  printerId: string;
  score: number;
  breakdown: ScoreComponent[];
}

function scoreCandidate(
  task: PlannerTaskInput,
  printer: PrinterState,
  weights: PlannerWeights,
  now: number
): CandidateScore {
  const breakdown: ScoreComponent[] = [];
  const add = (label: string, value: number): void => {
    if (value !== 0) breakdown.push({ label, value: round(value) });
  };

  const start = Math.max(printer.freeAtMs, task.notBeforeMs ?? now, now);
  const waitHours = Math.max(0, (start - now) / HOUR_MS);
  add("ожидание освобождения", -waitHours * weights.waitPerHour);

  if (materialsDiffer(task.material, printer.material)) {
    add("смена материала", -weights.materialSwap);
  }
  if (
    task.requiredNozzleMm !== null &&
    printer.nozzleMm !== null &&
    Math.abs(task.requiredNozzleMm - printer.nozzleMm) > 0.001
  ) {
    add("смена сопла", -weights.nozzleSwap);
  }
  if (task.previousPrinterId === printer.printerId) {
    add("стабильность плана", weights.stability);
  }
  if (task.pinnedPrinterId === printer.printerId) {
    add("закреплён", 500);
  }
  if (task.deadlineMs !== null && Number.isFinite(task.deadlineMs) && task.etaSeconds !== null) {
    // A non-finite deadline must be neutral, not scored as a miss: `end <= NaN` is
    // false, which would otherwise charge every candidate the deadline-miss penalty.
    const end = start + task.etaSeconds * 1000;
    if (end <= task.deadlineMs) add("успевает к дедлайну", weights.deadlineOk);
    else add("не успевает к дедлайну", -weights.deadlineMiss);
  }

  const score = breakdown.reduce((sum, c) => sum + c.value, 0);
  return { printerId: printer.printerId, score, breakdown };
}

function buildReason(
  printer: PrinterState,
  best: CandidateScore,
  task: PlannerTaskInput,
  candidateCount: number
): string {
  const parts: string[] = [];
  if (task.pinnedPrinterId === printer.printerId) parts.push("закреплён оператором");
  if (task.previousPrinterId === printer.printerId) parts.push("сохранение прежнего плана");
  const wait = best.breakdown.find((c) => c.label === "ожидание освобождения");
  if (!wait || wait.value === 0) parts.push("свободен сейчас");
  else parts.push("освободится раньше остальных");
  if (candidateCount > 1) parts.push(`выбран из ${candidateCount} совместимых`);
  return parts.join("; ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
