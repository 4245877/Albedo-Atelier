/**
 * The join between the two halves of this domain: **when does a required
 * intervention become performable, and when is the printer actually free again?**
 *
 * Both answers are pure functions of (operation, operator availability, now), and
 * both are fail-closed. The brief's worked example is exactly what
 * {@link projectPrinterRelease} computes:
 *
 *   03:00 — печать завершилась          → bed AWAITING_CLEARANCE, op PENDING
 *   03:00–08:00 — стол занят, оператор спит → op stays PENDING, printer busy
 *   08:00 — доступна операция снятия      → op READY (operator available)
 *   08:05 — после подтверждения           → op COMPLETED, bed CLEAR
 *
 * Note what the projection deliberately does *not* do: it never moves a state by
 * itself. It says "this could be performed now" and "the printer is unusable
 * until at least then"; the actual `PENDING → READY` write and the clearance are
 * driven by a service, and the completion always needs a named human.
 */

import type { OperatorAvailability } from "./schedule";
import { DEFAULT_OPERATION_MINUTES } from "./states";
import type { ManualOperation, ManualOperationType } from "./types";

/** Why an operation is not performable yet — a stable code for UI/audit/tests. */
export type NotReadyCode =
  /** The operator schedule could not be resolved at all (fail-closed). */
  | "SCHEDULE_UNKNOWN"
  /** No operator is available right now (asleep, away, off-hours). */
  | "OPERATOR_UNAVAILABLE"
  /** `windowStart` has not been reached. */
  | "WINDOW_NOT_OPEN"
  /** The operation is already finished or cancelled. */
  | "NOT_OPEN";

export interface ReadinessVerdict {
  /** True only when an operator could perform it at `now`. */
  ready: boolean;
  code: NotReadyCode | null;
  /**
   * The earliest instant it could be performed — `now` when ready. Null means
   * "not determinable", which callers must treat as "not soon", never as "now".
   */
  earliestAt: Date | null;
  reason: string;
}

/**
 * Whether `operation` can be performed at `now`.
 *
 * Two independent gates, both required: an operator has to be available, and the
 * operation's allowed window has to have opened. The later of the two is the
 * earliest performable instant — which is what makes a 03:00 finish resolve to
 * an 08:00 intervention rather than an immediate one.
 */
export function resolveReadiness(
  operation: Pick<ManualOperation, "state" | "windowStart">,
  availability: OperatorAvailability,
  now: Date
): ReadinessVerdict {
  if (operation.state === "COMPLETED" || operation.state === "CANCELLED") {
    return {
      ready: false,
      code: "NOT_OPEN",
      earliestAt: null,
      reason: "операция уже завершена"
    };
  }

  const windowStartMs = operation.windowStart ? Date.parse(operation.windowStart) : NaN;
  const windowOpen = !Number.isFinite(windowStartMs) || windowStartMs <= now.getTime();

  if (!availability.resolved) {
    // Fail-closed: an unresolved schedule cannot promise an operator.
    return {
      ready: false,
      code: "SCHEDULE_UNKNOWN",
      earliestAt: null,
      reason: availability.reason
    };
  }

  if (availability.presence !== "AVAILABLE") {
    const next = availability.nextAvailableAt;
    const earliest = laterOf(next, windowOpen ? null : new Date(windowStartMs));
    return {
      ready: false,
      code: "OPERATOR_UNAVAILABLE",
      earliestAt: earliest,
      reason: availability.reason
    };
  }

  if (!windowOpen) {
    return {
      ready: false,
      code: "WINDOW_NOT_OPEN",
      earliestAt: new Date(windowStartMs),
      reason: "окно выполнения операции ещё не открылось"
    };
  }

  return { ready: true, code: null, earliestAt: now, reason: "операция может быть выполнена" };
}

/**
 * The expected duration of an operation — **its own stored estimate, or null**.
 *
 * Deliberately *not* falling back to the type default. The default is stamped
 * onto the row when the operation is opened ({@link defaultMinutesFor} is what
 * does it), so a null here is not a missing lookup: it is a row that was created
 * with the duration explicitly unknown, or migrated in without one. Substituting
 * a plausible number at read time would make the fail-closed branch in
 * {@link projectPrinterRelease} unreachable — the projection would always name a
 * release time, including for work nobody has estimated.
 */
export function operationMinutes(
  operation: Pick<ManualOperation, "type" | "estimatedMinutes">
): number | null {
  const stored = operation.estimatedMinutes;
  return typeof stored === "number" && Number.isFinite(stored) && stored >= 0 ? stored : null;
}

/**
 * The configured default duration for a type, or null when the type is unknown.
 * Applied once, when an operation is opened — never as a read-time fallback.
 */
export function defaultMinutesFor(type: ManualOperationType): number | null {
  const value = DEFAULT_OPERATION_MINUTES[type];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface PrinterReleaseProjection {
  /** True when no blocking operation stands between the printer and its next job. */
  free: boolean;
  /**
   * When the printer is expected to be usable again — the last blocking
   * operation's earliest start plus its duration. **Null means unknown**, which
   * is the fail-closed answer whenever an operator schedule or a duration cannot
   * be resolved, and must never be rendered as "now".
   */
  releaseAt: Date | null;
  /** The blocking operations, in the order they gate the printer. */
  blocking: readonly ManualOperation[];
  /** Whether the hold is waiting on a human rather than on the machine. */
  waitingForOperator: boolean;
  /** Operator-facing summary. */
  reason: string;
}

/**
 * When the printer becomes usable again, given the operations still open on it.
 *
 * Operations are treated as **sequential**, not parallel: one operator, one pair
 * of hands. Two 15-minute interventions on the same machine take half an hour,
 * and pretending otherwise is how a plan promises a start that cannot happen.
 *
 * Any single unknown — an unresolvable schedule, a duration nobody has estimated
 * — collapses the whole projection to `releaseAt: null`. A partially-known
 * release time is not useful and is dangerous: it reads as a promise.
 */
export function projectPrinterRelease(
  operations: readonly ManualOperation[],
  availability: OperatorAvailability,
  now: Date
): PrinterReleaseProjection {
  const blocking = operations.filter((op) => op.blocking && isOpen(op.state));
  if (blocking.length === 0) {
    return {
      free: true,
      releaseAt: now,
      blocking: [],
      waitingForOperator: false,
      reason: "обязательных операций нет"
    };
  }

  let cursor: Date | null = null;
  let unknown = false;
  let waiting = false;

  for (const op of blocking) {
    const readiness = resolveReadiness(op, availability, now);
    if (!readiness.ready) waiting = true;

    // An in-progress operation is already being done: it starts now, not when
    // the operator's next window opens.
    const startsAt: Date | null =
      op.state === "IN_PROGRESS"
        ? laterOf(cursor, now)
        : laterOf(cursor, readiness.ready ? now : readiness.earliestAt);

    const minutes = operationMinutes(op);
    if (startsAt === null || minutes === null) {
      unknown = true;
      continue;
    }
    cursor = new Date(startsAt.getTime() + minutes * 60_000);
  }

  return {
    free: false,
    releaseAt: unknown ? null : cursor,
    blocking,
    waitingForOperator: waiting,
    reason: unknown
      ? "срок освобождения принтера неизвестен (нет расписания оператора или длительности операции)"
      : waiting
        ? "принтер занят до выполнения обязательных операций оператором"
        : "принтер занят выполняемыми операциями"
  };
}

function isOpen(state: ManualOperation["state"]): boolean {
  return state !== "COMPLETED" && state !== "CANCELLED";
}

/** The later of two instants; null when either is unknown (unknown dominates). */
function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
