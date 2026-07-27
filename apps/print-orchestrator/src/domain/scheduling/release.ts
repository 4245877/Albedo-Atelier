/**
 * **When is a printer actually available to the next job?** — the farm-wide
 * answer, for the recommendation planner.
 *
 * `domain/operations/planning.projectPrinterRelease` answers this for *one*
 * printer against a single availability snapshot. That is not enough to build a
 * plan, for two reasons:
 *
 *  1. **One operator, one pair of hands, across the whole farm.** Three printers
 *     that each finish at 03:00 do not all release at 08:05. The operator clears
 *     the first at 08:00–08:05, the second at 08:05–08:10, the third at
 *     08:10–08:15. A per-printer projection cannot see that; this module carries
 *     a single shared operator cursor across every printer, which is the
 *     "один оператор не выполняет две операции одновременно" rule.
 *  2. **The operator's availability moves.** An operation deferred past the end
 *     of a shift does not start at the shift's end — it starts when the *next*
 *     window opens. So availability is injected as a function of an instant
 *     ({@link NextOperatorSlot}), not as one snapshot taken at `now`.
 *
 * Everything here is pure and fail-closed. A single unknown — an unresolvable
 * operator schedule, an operation nobody has estimated, a machine that is busy
 * with no remaining time — collapses that printer's `releaseAtMs` to **null**.
 * Null is never rendered as "now" and never substituted with an assumption: the
 * planner leaves the job unplaced with a stable code instead of promising a
 * start that cannot happen. The only thing an unknown may produce is an
 * explicitly-flagged {@link ReleaseSegment} of kind `unknown` for the timeline.
 */

/** Why a printer is (not) available — a stable code for the UI, audit and tests. */
export type ReleaseCode =
  /** Nothing holds it: usable now. */
  | "FREE"
  /** Printing, with a known remaining time. */
  | "PRINTING"
  /** The machine is busy but reported no remaining time — release unknowable. */
  | "MACHINE_BUSY_UNKNOWN"
  /** A blocking operation is waiting for a human who is asleep/away/off-shift. */
  | "AWAITING_OPERATOR"
  /** A blocking operation is being performed right now. */
  | "OPERATION_IN_PROGRESS"
  /** The operator schedule could not be resolved, so no release time exists. */
  | "RELEASE_UNKNOWN_SCHEDULE"
  /** A blocking operation has no estimated duration. */
  | "RELEASE_UNKNOWN_DURATION";

/** One stretch of a printer's near future, for the operator timeline. */
export interface ReleaseSegment {
  kind: "printing" | "operator_wait" | "operation" | "unknown";
  startMs: number;
  /** Null when the stretch has no computable end (an unknown). */
  endMs: number | null;
  label: string;
  operationId?: string;
  operationType?: string;
}

/** What the machine itself is doing, independent of any human. */
export interface MachineOccupancy {
  printerId: string;
  /**
   * When the machine stops working, ms. `null` **while `busy`** means the device
   * gave no remaining time — genuinely unknown, never assumed. Ignored when the
   * machine is not busy.
   */
  busyUntilMs: number | null;
  busy: boolean;
  /** Operator-facing label for the busy stretch ("печатает", "занят запуском"). */
  busyLabel: string;
}

/** One open intervention, flattened to what the projection needs. */
export interface ReleaseOperationInput {
  id: string;
  type: string;
  label: string;
  printerId: string;
  /** True while a human already has their hands on it (starts now, not later). */
  inProgress: boolean;
  /** Only blocking operations hold a printer; the rest are shown, not gating. */
  blocking: boolean;
  /** Hands-on minutes; `null` = nobody estimated it → the release is unknown. */
  minutes: number | null;
  /** Earliest allowed start (`windowStart`), ms; null when unconstrained. */
  windowStartMs: number | null;
  /** Used only to order operations deterministically. */
  createdAtMs: number;
}

/**
 * The earliest instant at or after `fromMs` at which an operator could work.
 * Returns `null` when that is not knowable (no schedule, no window in the
 * horizon) — which is what makes the whole projection fail closed.
 */
export type NextOperatorSlot = (fromMs: number) => number | null;

export interface PrinterRelease {
  printerId: string;
  /** When the printer is usable again; **null = unknown**, never "now". */
  releaseAtMs: number | null;
  code: ReleaseCode;
  reason: string;
  /** True when the hold is waiting on a human rather than on the machine. */
  waitingForOperator: boolean;
  /** Ids of the blocking operations gating it, in the order they are performed. */
  blockingOperationIds: string[];
  /** The timeline stretches: printing → waiting for operator → each operation. */
  segments: ReleaseSegment[];
}

export interface FarmReleaseInput {
  nowMs: number;
  machines: readonly MachineOccupancy[];
  operations: readonly ReleaseOperationInput[];
  nextOperatorSlot: NextOperatorSlot;
}

const MINUTE_MS = 60_000;

/**
 * Projects every printer's release in one pass, sharing a single operator.
 *
 * Ordering is the whole point and is deliberately *not* input order: operations
 * are sequenced by when they could first be performed (machine free + window
 * open), then by age, then by id — so the projection is deterministic and a
 * different array order cannot move the 08:00 slot from one printer to another.
 */
export function projectFarmRelease(input: FarmReleaseInput): Map<string, PrinterRelease> {
  const { nowMs, nextOperatorSlot } = input;

  const machineFreeAt = new Map<string, number | null>();
  const out = new Map<string, PrinterRelease>();

  for (const machine of input.machines) {
    const freeAt = machine.busy ? machine.busyUntilMs : nowMs;
    machineFreeAt.set(machine.printerId, machine.busy ? freeAt : nowMs);
    const segments: ReleaseSegment[] = [];
    if (machine.busy) {
      segments.push({
        kind: machine.busyUntilMs === null ? "unknown" : "printing",
        startMs: nowMs,
        endMs: machine.busyUntilMs,
        label: machine.busyLabel
      });
    }
    out.set(machine.printerId, {
      printerId: machine.printerId,
      releaseAtMs: machine.busy ? machine.busyUntilMs : nowMs,
      code: machine.busy ? (machine.busyUntilMs === null ? "MACHINE_BUSY_UNKNOWN" : "PRINTING") : "FREE",
      reason: machine.busy
        ? machine.busyUntilMs === null
          ? "принтер занят, устройство не сообщает остаток времени"
          : machine.busyLabel
        : "принтер свободен",
      waitingForOperator: false,
      blockingOperationIds: [],
      segments
    });
  }

  // Only blocking operations on known printers gate anything. Non-blocking work
  // (a visual inspection) is real work an operator will still have to do, but it
  // does not hold the machine and must not push a release time out.
  const gating = input.operations.filter((op) => op.blocking && out.has(op.printerId));

  // Deterministic sequencing key: the earliest instant this operation could
  // *possibly* start if the operator were free — machine-free and window-open.
  // Ties fall back to age, then id, so the order never depends on the array.
  const earliestPossible = (op: ReleaseOperationInput): number => {
    if (op.inProgress) return nowMs;
    const machineAt = machineFreeAt.get(op.printerId);
    return Math.max(nowMs, machineAt ?? nowMs, op.windowStartMs ?? nowMs);
  };

  const ordered = [...gating].sort((a, b) => {
    // In-progress work is already occupying the operator, so it sequences first.
    if (a.inProgress !== b.inProgress) return a.inProgress ? -1 : 1;
    const ea = earliestPossible(a);
    const eb = earliestPossible(b);
    if (ea !== eb) return ea - eb;
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  /**
   * The single pair of hands: when the operator finishes what they are doing.
   * `null` means "unknowable from here on" — once one operation's end cannot be
   * computed, no later operation's start can be either, farm-wide. That is the
   * fail-closed consequence of modelling one operator honestly.
   */
  let operatorCursor: number | null = nowMs;
  /** Printers whose release is already unknown; a later operation cannot repair it. */
  const poisoned = new Set<string>();

  for (const op of ordered) {
    const printer = out.get(op.printerId) as PrinterRelease;
    printer.blockingOperationIds.push(op.id);

    const machineAt = op.inProgress ? nowMs : (machineFreeAt.get(op.printerId) ?? null);
    const notBefore = maxOrNull(machineAt, op.windowStartMs === null ? nowMs : op.windowStartMs);

    if (operatorCursor === null) {
      // A previous operation's end is unknown, so this one's start is too.
      markUnknown(printer, op, notBefore, "chain", nowMs, poisoned);
      continue;
    }
    if (notBefore === null) {
      // The machine is busy with no reported remaining time: the operation cannot
      // even be given an earliest start.
      markUnknown(printer, op, null, "machine", nowMs, poisoned);
      operatorCursor = null;
      continue;
    }

    // An in-progress operation is already being performed: it does not wait for
    // the next operator window, it is happening now.
    const readyAt: number | null = op.inProgress
      ? Math.max(operatorCursor, nowMs)
      : nextOperatorSlot(Math.max(notBefore, operatorCursor));

    if (readyAt === null) {
      markUnknown(printer, op, notBefore, "schedule", nowMs, poisoned);
      operatorCursor = null;
      continue;
    }
    if (op.minutes === null) {
      markUnknown(printer, op, readyAt, "duration", nowMs, poisoned);
      operatorCursor = null;
      continue;
    }

    // The forced idle: the machine was free at `notBefore` but nobody was there
    // until `readyAt`. This is the 03:00–08:00 stretch, shown as its own segment
    // rather than folded silently into the operation.
    const idleFrom = notBefore ?? nowMs;
    if (readyAt > idleFrom) {
      printer.segments.push({
        kind: "operator_wait",
        startMs: idleFrom,
        endMs: readyAt,
        label: "ожидание оператора"
      });
      printer.waitingForOperator = true;
    }

    const endsAt: number = readyAt + op.minutes * MINUTE_MS;
    printer.segments.push({
      kind: "operation",
      startMs: readyAt,
      endMs: endsAt,
      label: op.label,
      operationId: op.id,
      operationType: op.type
    });

    machineFreeAt.set(op.printerId, endsAt);
    operatorCursor = endsAt;
    if (poisoned.has(op.printerId)) continue; // release already unknown — do not repair it
    printer.releaseAtMs = endsAt;
    printer.code = op.inProgress ? "OPERATION_IN_PROGRESS" : "AWAITING_OPERATOR";
    printer.reason = op.inProgress
      ? `выполняется: ${op.label}`
      : `принтер занят до выполнения операции «${op.label}» оператором`;
  }

  return out;
}

/** Why a release time could not be computed. */
type UnknownCause =
  /** The operator schedule yielded no window for it. */
  | "schedule"
  /** Nobody estimated how long the operation takes. */
  | "duration"
  /** The machine is busy with no reported remaining time. */
  | "machine"
  /** An earlier operation's end is unknown, so this one's start is too. */
  | "chain";

const UNKNOWN_CODE: Record<UnknownCause, ReleaseCode> = {
  schedule: "RELEASE_UNKNOWN_SCHEDULE",
  duration: "RELEASE_UNKNOWN_DURATION",
  machine: "MACHINE_BUSY_UNKNOWN",
  chain: "RELEASE_UNKNOWN_SCHEDULE"
};

/**
 * Records an operation whose start or duration cannot be resolved. The printer's
 * release becomes `null` permanently (a later, computable operation on the same
 * printer must not "repair" it — the unknown one still has to happen first).
 */
function markUnknown(
  printer: PrinterRelease,
  op: ReleaseOperationInput,
  fromMs: number | null,
  cause: UnknownCause,
  nowMs: number,
  poisoned: Set<string>
): void {
  poisoned.add(printer.printerId);
  printer.releaseAtMs = null;
  printer.code = UNKNOWN_CODE[cause];
  printer.reason =
    cause === "schedule"
      ? `срок освобождения неизвестен: нет расписания оператора для операции «${op.label}»`
      : cause === "duration"
        ? `срок освобождения неизвестен: не задана длительность операции «${op.label}»`
        : cause === "machine"
          ? `срок освобождения неизвестен: принтер занят без известного остатка времени, а затем требуется «${op.label}»`
          : `срок освобождения неизвестен: оператор занят предыдущей операцией с неизвестным сроком (далее «${op.label}»)`;
  printer.waitingForOperator = cause !== "machine";
  printer.segments.push({
    kind: "unknown",
    startMs: fromMs ?? nowMs,
    endMs: null,
    label: `${op.label} — срок неизвестен`,
    operationId: op.id,
    operationType: op.type
  });
}

/** The later of two instants; `null` (unknown) dominates. */
function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return Math.max(a, b);
}
