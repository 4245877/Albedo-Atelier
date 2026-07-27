/**
 * The manual-scheduler placement heuristic — **a recommender, not an executor**.
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
 * (deadline risk, material/nozzle swap). Unplaceable tasks come back in
 * {@link PlannerResult.unplaced} with a **stable machine code** — nothing is
 * silently dropped and nothing is explained only in prose.
 *
 * ## Nothing is guessed into an executable plan
 *
 * Two inputs are allowed to be unknown, and neither is ever substituted:
 *
 *  - **the printer's release time** (`freeAtMs: null`) — a printer whose release
 *    depends on an unestimated intervention or an unresolvable operator schedule
 *    is not a printer anything can be planned onto;
 *  - **the task's ETA** (`etaSeconds: null`) — a placement with no duration is a
 *    start time for the next job that does not exist.
 *
 * Either one leaves the task in {@link PlannerResult.unplaced}. What the planner
 * *may* return in that case is an {@link ApproximateHint}: an explicitly-flagged,
 * non-executable estimate for the operator's eye only. It is never a start time,
 * never advances a printer's free-time, and never reaches an assignment.
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
  /**
   * Epoch ms at which the printer becomes free — the **real** release, machine
   * plus the manual interventions and the operator schedule behind them (see
   * `domain/scheduling/release`). **Null means unknown**, and unknown is not a
   * synonym for "now": nothing may be planned onto such a printer at all.
   */
  freeAtMs: number | null;
  /** Stable code behind {@link freeAtMs} (`FREE`, `AWAITING_OPERATOR`, …). */
  releaseCode: string;
  /** Operator-facing explanation of the release, quoted verbatim in reasons. */
  releaseReason: string;
  currentMaterial: string | null;
  currentNozzleMm: number | null;
  /**
   * False when the adapter cannot start a print remotely — the plan is still a
   * valid recommendation, but it carries the honest warning that a human has to
   * press start on the machine.
   */
  remoteStartSupported?: boolean;
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
   * Seconds used **only** to build an {@link ApproximateHint} for a task whose ETA
   * is unknown. It never advances a printer's free-time and never becomes an
   * assignment: the task stays unplaced. Present so the operator sees roughly how
   * much of the day such work would eat, clearly labelled as a guess.
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
  /** Projected end. Always known: a task with no ETA is never placed. */
  endMs: number;
  etaSeconds: number;
  score: number;
  scoreBreakdown: ScoreComponent[];
  reason: string;
  alternatives: { printerId: string; score: number }[];
  warnings: string[];
}

/** Stable reason codes for a task the planner refused to place. */
export type UnplacedCode =
  /** No printer answered `compatible` for it. */
  | "NO_COMPATIBLE_PRINTER"
  /** The pinned printer is missing, incompatible, or has an unknown release. */
  | "PINNED_PRINTER_UNAVAILABLE"
  /** Every compatible printer's release time is unknown (operator/duration). */
  | "PRINTER_RELEASE_UNKNOWN"
  /** The task's own print duration is unknown, so a start time would be fiction. */
  | "ETA_UNKNOWN";

/**
 * A deliberately non-executable estimate attached to an unplaced task. It exists
 * so the timeline can show a ghost block ("this would be about here, about this
 * long") without any part of the system mistaking it for a plan: it carries
 * `approximate: true`, and neither the planner nor the plan writes it into an
 * assignment.
 */
export interface ApproximateHint {
  approximate: true;
  printerId: string;
  startMs: number;
  endMs: number;
  note: string;
}

export interface UnplacedTask {
  taskId: string;
  code: UnplacedCode;
  reason: string;
  /** An explicitly-marked visual estimate, when one can be offered at all. */
  hint: ApproximateHint | null;
}

export interface PlannerResult {
  assignments: PlannerAssignment[];
  unplaced: UnplacedTask[];
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

/**
 * The task's effective earliest-start (ms): its `notBeforeMs` when finite, else
 * `now`. `?? now` only substitutes for null — a NaN would slip through into the
 * `Math.max(...)` and turn the whole start/score arithmetic into NaN, poisoning
 * placement and (via NaN comparisons) the candidate ordering. This is the same
 * defensive finite-guard the createdAt/deadline terms already apply, kept in one
 * place so scoring and placement compute an identical start.
 */
function effectiveNotBefore(notBeforeMs: number | null, now: number): number {
  return notBeforeMs !== null && Number.isFinite(notBeforeMs) ? notBeforeMs : now;
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
  /** Null = release unknown; such a printer never receives a placement. */
  freeAtMs: number | null;
  releaseCode: string;
  releaseReason: string;
  remoteStartSupported: boolean;
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
      freeAtMs: p.freeAtMs === null ? null : Math.max(now, p.freeAtMs),
      releaseCode: p.releaseCode,
      releaseReason: p.releaseReason,
      remoteStartSupported: p.remoteStartSupported !== false,
      material: p.currentMaterial,
      nozzleMm: p.currentNozzleMm
    });
  }

  // Precompute each task's urgency once (not twice per comparison) and sort on a
  // *total*, input-order-independent order: urgency desc, then older first, then
  // taskId. Without the final taskId tiebreak a stable sort would leave exact ties
  // in input-array order, so the same tasks in a different order could plan onto
  // different printers — the planner must be deterministic regardless of input order.
  const ordered = tasks
    .map((task) => ({ task, urgency: urgencyScore(task, weights, now) }))
    .sort((a, b) => {
      if (b.urgency !== a.urgency) return b.urgency - a.urgency;
      // `createdAtMs` may be non-finite here (a public domain input); a real epoch is
      // a large positive number, so guarding to 0 leaves normal ordering untouched.
      const ca = Number.isFinite(a.task.createdAtMs) ? a.task.createdAtMs : 0;
      const cb = Number.isFinite(b.task.createdAtMs) ? b.task.createdAtMs : 0;
      if (ca !== cb) return ca - cb;
      return a.task.taskId < b.task.taskId ? -1 : a.task.taskId > b.task.taskId ? 1 : 0;
    })
    .map((entry) => entry.task);

  const assignments: PlannerAssignment[] = [];
  const unplaced: UnplacedTask[] = [];

  for (const task of ordered) {
    let candidateIds = task.compatiblePrinterIds.filter((id) => state.has(id));
    if (task.pinnedPrinterId) {
      candidateIds = candidateIds.filter((id) => id === task.pinnedPrinterId);
      if (candidateIds.length === 0) {
        unplaced.push({
          taskId: task.taskId,
          code: "PINNED_PRINTER_UNAVAILABLE",
          reason: `Закреплён принтер ${task.pinnedPrinterId}, но он несовместим или отсутствует`,
          hint: null
        });
        continue;
      }
    }
    if (candidateIds.length === 0) {
      unplaced.push({
        taskId: task.taskId,
        code: "NO_COMPATIBLE_PRINTER",
        reason: "Нет совместимых принтеров",
        hint: null
      });
      continue;
    }

    // A printer whose release is unknown is not a candidate: placing here would
    // mean inventing the moment a human takes a part off a plate.
    const usable = candidateIds.filter((id) => state.get(id)!.freeAtMs !== null);
    if (usable.length === 0) {
      const detail = candidateIds
        .map((id) => `${state.get(id)!.name}: ${state.get(id)!.releaseReason}`)
        .join("; ");
      unplaced.push({
        taskId: task.taskId,
        code: task.pinnedPrinterId ? "PINNED_PRINTER_UNAVAILABLE" : "PRINTER_RELEASE_UNKNOWN",
        reason: `Время освобождения принтера неизвестно — ${detail}`,
        hint: null
      });
      continue;
    }

    const scored = usable
      .map((id) => scoreCandidate(task, state.get(id)!, weights, now))
      // Best score first; ties broken by printerId so the choice among equally-good
      // printers never depends on the order the candidate ids arrive in.
      .sort((a, b) =>
        b.score !== a.score
          ? b.score - a.score
          : a.printerId < b.printerId
            ? -1
            : a.printerId > b.printerId
              ? 1
              : 0
      );
    const best = scored[0];
    const chosen = state.get(best.printerId)!;
    const start = Math.max(chosen.freeAtMs as number, effectiveNotBefore(task.notBeforeMs, now), now);

    // An unknown ETA is the second thing that is never invented. The task stays
    // unplaced with a stable code; the operator still gets a ghost block so the
    // day's shape is visible, explicitly marked as a guess.
    if (task.etaSeconds === null) {
      unplaced.push({
        taskId: task.taskId,
        code: "ETA_UNKNOWN",
        reason: "Длительность печати неизвестна — точный план построить нельзя",
        hint: {
          approximate: true,
          printerId: best.printerId,
          startMs: start,
          endMs: start + config.unknownEtaAssumptionS * 1000,
          note: `приблизительная оценка (${Math.round(config.unknownEtaAssumptionS / 3600)} ч, допущение планировщика) — не план`
        }
      });
      continue;
    }

    const end = start + task.etaSeconds * 1000;

    const warnings: string[] = [];
    if (!chosen.remoteStartSupported) {
      warnings.push("Удалённый запуск не поддержан — старт подтверждает и выполняет оператор вручную");
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
    if (task.deadlineMs !== null && end > task.deadlineMs) {
      warnings.push("Прогноз выходит за дедлайн");
    }
    if (start > now + 60_000) {
      warnings.push(
        `Старт после освобождения принтера (~${Math.round((start - now) / 60000)} мин ожидания: ${chosen.releaseReason})`
      );
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

    // Advance the chosen printer's state so the next task sees it occupied. Both
    // terms are known quantities now — an unknown release or ETA never reaches
    // here — so the projected free-time carries no hidden assumption.
    chosen.freeAtMs = end;
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

  // Only ever called for a usable printer, so `freeAtMs` is a number here.
  const start = Math.max(printer.freeAtMs as number, effectiveNotBefore(task.notBeforeMs, now), now);
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
  else parts.push(`освободится раньше остальных (${printer.releaseReason})`);
  if (candidateCount > 1) parts.push(`выбран из ${candidateCount} совместимых`);
  return parts.join("; ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
