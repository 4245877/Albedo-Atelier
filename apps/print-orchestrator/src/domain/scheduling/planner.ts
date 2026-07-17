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
}

export interface PlannerPrinterInput {
  printerId: string;
  name: string;
  /** Epoch ms at which the printer becomes free (now if already idle). */
  freeAtMs: number;
  currentMaterial: string | null;
  currentNozzleMm: number | null;
}

export interface PlannerWeights {
  priority: number;
  agePerDay: number;
  deadlineUrgency: number;
  scarcity: number;
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
  score += Math.max(0, (nowMs - task.createdAtMs) / DAY_MS) * weights.agePerDay;
  if (task.deadlineMs !== null) {
    const hoursLeft = Math.max(0.5, (task.deadlineMs - nowMs) / HOUR_MS);
    score += weights.deadlineUrgency / hoursLeft;
  }
  const options = Math.max(1, task.compatiblePrinterIds.length);
  score += weights.scarcity / options;
  if (task.pinnedPrinterId) score += 1000; // pinned work is scheduled first
  return score;
}

interface PrinterState {
  printerId: string;
  name: string;
  freeAtMs: number;
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
      material: p.currentMaterial,
      nozzleMm: p.currentNozzleMm
    });
  }

  const ordered = [...tasks].sort((a, b) => {
    const ua = urgencyScore(a, weights, now);
    const ub = urgencyScore(b, weights, now);
    if (ub !== ua) return ub - ua;
    return a.createdAtMs - b.createdAtMs; // older first on ties
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

    // Advance the chosen printer's state so the next task sees it occupied.
    chosen.freeAtMs = start + durationS * 1000;
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
  if (task.deadlineMs !== null && task.etaSeconds !== null) {
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
