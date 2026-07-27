import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import {
  operationMinutes,
  projectPrinterRelease,
  resolveReadiness,
  type PrinterReleaseProjection
} from "../../domain/operations/planning";
import type { OperatorAvailability } from "../../domain/operations/schedule";
import {
  assertOperationTransition,
  BED_CLEARING_TYPES,
  BLOCKING_BY_DEFAULT,
  DEFAULT_OPERATION_MINUTES,
  OPERATION_LABELS
} from "../../domain/operations/states";
import {
  MANUAL_OPERATION_TYPES,
  OPEN_OPERATION_STATES,
  type ManualOperation,
  type ManualOperationOrigin,
  type ManualOperationState,
  type ManualOperationType
} from "../../domain/operations/types";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { assertTransition, BED_CYCLE_TRANSITIONS } from "../../domain/print/states";
import type { AuditEntityType, Metadata } from "../../domain/print/types";
import type { StoreLogger } from "../../shared/logger";
import { recordAuditEvent, type AuditInput } from "../audit";
import type { OperatorScheduleService } from "./operatorScheduleService";

/** What an operator (or the system) is asking to have done. */
export interface OpenOperationInput {
  type: ManualOperationType;
  printerId: string;
  assignmentId?: string | null;
  taskId?: string | null;
  bedCycleId?: string | null;
  /** Overrides the type default; `null` explicitly records "duration unknown". */
  estimatedMinutes?: number | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  /** Overrides {@link BLOCKING_BY_DEFAULT} for this one operation. */
  blocking?: boolean;
  origin?: ManualOperationOrigin;
  reason?: string | null;
}

/** One pending operation joined with its live readiness, for the operator UI. */
export interface PendingOperationView {
  operation: ManualOperation;
  label: string;
  ready: boolean;
  /** Why it is not ready yet (`OPERATOR_UNAVAILABLE`, `SCHEDULE_UNKNOWN`, …). */
  code: string | null;
  reason: string;
  earliestAt: string | null;
  expectedMinutes: number | null;
}

/** How long a printer is held, and by what. */
export interface PrinterHoldView {
  printerId: string;
  free: boolean;
  releaseAt: string | null;
  waitingForOperator: boolean;
  reason: string;
  blocking: ManualOperation[];
  /** Idle minutes already lost waiting for an operator; null when not waiting. */
  forcedIdleMinutes: number | null;
}

/**
 * The manual-operations application service — the one place a physical
 * intervention is opened, becomes performable, is claimed, and is confirmed.
 *
 * Three guarantees it exists to provide:
 *
 *  1. **A printer with an outstanding blocking operation is busy.** Not "busy
 *     unless someone insists" — {@link openBlockingFor} is what the dispatch gate
 *     reads, and the refusal it produces is non-overridable. A finished part on
 *     a plate is a physical fact.
 *  2. **Only a named human confirmation clears a bed.** {@link complete} records
 *     who, when, and how long it actually took. Telemetry going idle confirms
 *     nothing — the printer reporting `idle` after a print is exactly the state
 *     in which the part is still sitting on the plate.
 *  3. **Readiness is derived, never assumed.** {@link refreshReadiness} promotes
 *     `PENDING → READY` only when the operator schedule says somebody is
 *     available and the operation's window has opened, and demotes back when
 *     they go to sleep. An unresolvable schedule leaves everything `PENDING`.
 */
export class ManualOperationService {
  private readonly nowFn: () => Date;
  private readonly actor: string;
  private readonly logger: StoreLogger;

  constructor(
    private readonly store: PrintQueueStore,
    private readonly schedule: OperatorScheduleService,
    options: { now?: () => Date; actor?: string; logger?: StoreLogger } = {}
  ) {
    this.nowFn = options.now ?? (() => new Date());
    this.actor = options.actor ?? "operator";
    this.logger = options.logger ?? {};
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** Every still-open operation across the farm, oldest first. */
  listOpen(): ManualOperation[] {
    return this.store.repositories.manualOperations.listOpen();
  }

  listByPrinter(printerId: string, states?: readonly ManualOperationState[]): ManualOperation[] {
    return this.store.repositories.manualOperations.listByPrinter(printerId, states);
  }

  getOperation(id: string): ManualOperation {
    const operation = this.store.repositories.manualOperations.getById(id);
    if (!operation) throw new NotFoundError(`Ручная операция «${id}»`);
    return operation;
  }

  /**
   * The **blocking** open operations on a printer — the list the dispatch gate
   * turns into a refusal and the scheduler turns into "this printer is busy".
   */
  openBlockingFor(printerId: string): ManualOperation[] {
    return this.store.repositories.manualOperations
      .listByPrinter(printerId, OPEN_OPERATION_STATES)
      .filter((op) => op.blocking);
  }

  /** Every open operation on a printer, blocking or not. */
  openFor(printerId: string): ManualOperation[] {
    return this.store.repositories.manualOperations.listByPrinter(printerId, OPEN_OPERATION_STATES);
  }

  /**
   * The still-open bed-clearance operations on a printer — what a direct
   * `clearBed` confirmation has to close so the operator queue and the bed state
   * cannot drift apart.
   */
  openClearanceOperations(printerId: string): ManualOperation[] {
    return this.openFor(printerId).filter((op) => BED_CLEARING_TYPES.has(op.type));
  }

  /** The pending-work queue with live readiness — what the operator UI lists. */
  pending(now?: Date): PendingOperationView[] {
    const at = now ?? this.nowFn();
    const availability = this.schedule.availability(at);
    return this.listOpen().map((operation) => {
      const verdict = resolveReadiness(operation, availability, at);
      return {
        operation,
        label: OPERATION_LABELS[operation.type],
        ready: verdict.ready || operation.state === "IN_PROGRESS",
        code: verdict.code,
        reason: verdict.reason,
        earliestAt: verdict.earliestAt?.toISOString() ?? null,
        expectedMinutes: operationMinutes(operation)
      };
    });
  }

  /** When a printer becomes usable again, and what is holding it. */
  printerHold(printerId: string, now?: Date): PrinterHoldView {
    const at = now ?? this.nowFn();
    const availability = this.schedule.availability(at);
    const projection = this.projectionFor(printerId, availability, at);
    return {
      printerId,
      free: projection.free,
      releaseAt: projection.releaseAt?.toISOString() ?? null,
      waitingForOperator: projection.waitingForOperator,
      reason: projection.reason,
      blocking: [...projection.blocking],
      forcedIdleMinutes: forcedIdleMinutes(projection, at)
    };
  }

  /** The release projection for one printer (pure domain, live rows). */
  projectionFor(
    printerId: string,
    availability: OperatorAvailability,
    now: Date
  ): PrinterReleaseProjection {
    return projectPrinterRelease(this.openFor(printerId), availability, now);
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Opens a required intervention. It starts `PENDING` and is immediately
   * evaluated for readiness, so an operation opened while the operator is at the
   * bench is `READY` at once, and one opened at 03:00 stays `PENDING` until
   * morning — the brief's worked example, with no scheduled job in between.
   */
  open(input: OpenOperationInput, actor?: string): ManualOperation {
    const type = input.type;
    if (!MANUAL_OPERATION_TYPES.includes(type)) {
      throw new ValidationError(
        `Неизвестный тип операции «${String(type)}». Допустимые: ${MANUAL_OPERATION_TYPES.join(", ")}`
      );
    }
    const printerId = (input.printerId ?? "").trim();
    if (!printerId) throw new ValidationError("Поле «printerId» обязательно");

    return this.store.transaction(() => {
      const iso = this.nowIso();
      const operation: ManualOperation = {
        id: newId(ID_PREFIX.manualOperation),
        type,
        state: "PENDING",
        printerId,
        assignmentId: input.assignmentId ?? null,
        taskId: input.taskId ?? null,
        bedCycleId: input.bedCycleId ?? null,
        estimatedMinutes:
          input.estimatedMinutes === undefined
            ? DEFAULT_OPERATION_MINUTES[type]
            : normalizeMinutes(input.estimatedMinutes),
        windowStart: input.windowStart ?? null,
        windowEnd: input.windowEnd ?? null,
        blocking: input.blocking ?? BLOCKING_BY_DEFAULT[type],
        origin: input.origin ?? "operator",
        reason: input.reason?.trim() || null,
        assignedOperatorId: null,
        confirmedBy: null,
        startedAt: null,
        completedAt: null,
        actualMinutes: null,
        readyAt: null,
        note: null,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        metadata: {}
      };
      this.store.repositories.manualOperations.insert(operation);
      this.audit("manual_operation", operation.id, "opened", {
        to: "PENDING",
        actor,
        detail: {
          type,
          printerId,
          assignmentId: operation.assignmentId,
          blocking: operation.blocking,
          origin: operation.origin,
          reason: operation.reason
        }
      });
      return this.evaluateReadiness(operation, actor) ?? operation;
    });
  }

  /**
   * Opens the bed-clearance operation a finished print leaves behind — the
   * automatic half of "03:00 печать завершилась → стол занят".
   *
   * Idempotent per bed cycle: a second call (a re-observed completion, a restart
   * replaying the edge) returns the existing operation rather than stacking a
   * second removal onto the same plate.
   */
  openClearanceFor(input: {
    printerId: string;
    bedCycleId: string;
    assignmentId?: string | null;
    taskId?: string | null;
    reason?: string;
  }): ManualOperation {
    const existing = this.store.repositories.manualOperations
      .listByPrinter(input.printerId, OPEN_OPERATION_STATES)
      .find((op) => op.bedCycleId === input.bedCycleId && BED_CLEARING_TYPES.has(op.type));
    if (existing) return existing;

    return this.open(
      {
        type: "PART_REMOVAL",
        printerId: input.printerId,
        assignmentId: input.assignmentId ?? null,
        taskId: input.taskId ?? null,
        bedCycleId: input.bedCycleId,
        origin: "print_finished",
        reason: input.reason ?? "печать завершена — снимите модель и подтвердите очистку стола"
      },
      "system"
    );
  }

  /**
   * Re-derives `PENDING ⇄ READY` for every open operation against the current
   * operator availability. Called on a schedule change, after a restart, and
   * before any read that must not show a stale readiness.
   *
   * Bidirectional on purpose: availability expires. An operation that was
   * performable at 22:55 is not performable at 23:05, and leaving it `READY`
   * would tell the operator queue a human is standing by when nobody is.
   */
  refreshReadiness(now?: Date): { promoted: number; demoted: number } {
    const at = now ?? this.nowFn();
    const availability = this.schedule.availability(at);
    let promoted = 0;
    let demoted = 0;

    for (const operation of this.store.repositories.manualOperations.listByStates([
      "PENDING",
      "READY"
    ])) {
      const moved = this.store.transaction(() =>
        this.evaluateReadiness(operation, "system", availability, at)
      );
      if (!moved) continue;
      if (moved.state === "READY" && operation.state === "PENDING") promoted += 1;
      if (moved.state === "PENDING" && operation.state === "READY") demoted += 1;
    }
    return { promoted, demoted };
  }

  /**
   * An operator claims an operation (`→ IN_PROGRESS`).
   *
   * Refused when that operator already has one in flight: one person cannot
   * change a nozzle and clear another bed at the same time, and a model that
   * pretends otherwise produces morning plans nobody can execute. The partial
   * unique index in migration 011 is the storage-level backstop for the same rule.
   */
  claim(operationId: string, operatorId: string, actor?: string): ManualOperation {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const operation = this.getOperation(operationId);
      if (operation.state === "IN_PROGRESS" && operation.assignedOperatorId === operatorId) {
        return operation; // idempotent re-claim by the same operator
      }
      const operator = repos.operators.getById(operatorId);
      if (!operator) throw new NotFoundError(`Оператор «${operatorId}»`);

      const busy = repos.manualOperations.findInProgressByOperator(operatorId);
      if (busy && busy.id !== operationId) {
        throw new JobError(
          `Оператор «${operator.name}» уже выполняет операцию ${busy.id} (${OPERATION_LABELS[busy.type]}) — завершите её сначала`
        );
      }

      const iso = this.nowIso();
      assertOperationTransition(operation.state, "IN_PROGRESS");
      const saved = repos.manualOperations.update({
        ...operation,
        state: "IN_PROGRESS",
        assignedOperatorId: operatorId,
        startedAt: iso,
        updatedAt: iso
      });
      this.audit("manual_operation", operation.id, "claimed", {
        from: operation.state,
        to: "IN_PROGRESS",
        actor: actor ?? operator.name,
        detail: { operatorId, printerId: operation.printerId, type: operation.type }
      });
      return saved;
    });
  }

  /**
   * The confirmation: an operator states the intervention is done.
   *
   * **Idempotent.** A repeat on an already-`COMPLETED` operation returns the
   * stored record untouched — no second bed transition, no second audit row, no
   * duplicated actual-duration. Operators double-click, and a confirmation that
   * fired twice must not be able to clear a bed that has since been re-reserved.
   *
   * For `PART_REMOVAL`/`PLATE_SERVICE` this is *also* the bed clearance: the bed
   * cycle moves `AWAITING_CLEARANCE → CLEAR` in the same transaction, so "the
   * operator confirmed" and "the bed is free" can never disagree.
   */
  complete(
    operationId: string,
    options: { actor?: string; actualMinutes?: number | null; note?: string | null } = {}
  ): ManualOperation {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const operation = this.getOperation(operationId);
      if (operation.state === "COMPLETED") return operation;
      if (operation.state === "CANCELLED") {
        throw new JobError(
          `Операция ${operationId} отменена — подтвердить выполнение отменённой операции нельзя`
        );
      }

      const iso = this.nowIso();
      const confirmedBy = options.actor?.trim() || this.actor;
      const actualMinutes =
        options.actualMinutes === undefined || options.actualMinutes === null
          ? elapsedMinutes(operation.startedAt, this.nowFn())
          : normalizeMinutes(options.actualMinutes);

      assertOperationTransition(operation.state, "COMPLETED");
      const saved = repos.manualOperations.update({
        ...operation,
        state: "COMPLETED",
        confirmedBy,
        completedAt: iso,
        actualMinutes,
        note: options.note?.trim() || operation.note,
        updatedAt: iso
      });
      this.audit("manual_operation", operation.id, "completed", {
        from: operation.state,
        to: "COMPLETED",
        actor: confirmedBy,
        detail: {
          type: operation.type,
          printerId: operation.printerId,
          assignmentId: operation.assignmentId,
          estimatedMinutes: operationMinutes(operation),
          actualMinutes,
          ...(options.note ? { note: options.note.trim() } : {})
        }
      });

      if (BED_CLEARING_TYPES.has(operation.type)) {
        this.clearBedFor(saved, confirmedBy);
      }
      return saved;
    });
  }

  /**
   * The intervention was attempted and did not work. The operation stays
   * **blocking** — a nozzle that is still clogged is not a printer that is ready
   * — and can be retried (`FAILED → PENDING/READY/IN_PROGRESS`).
   */
  fail(operationId: string, options: { actor?: string; note?: string } = {}): ManualOperation {
    return this.store.transaction(() => {
      const operation = this.getOperation(operationId);
      if (operation.state === "FAILED") return operation;
      const iso = this.nowIso();
      assertOperationTransition(operation.state, "FAILED");
      const saved = this.store.repositories.manualOperations.update({
        ...operation,
        state: "FAILED",
        note: options.note?.trim() || operation.note,
        completedAt: iso,
        updatedAt: iso
      });
      this.audit("manual_operation", operation.id, "failed", {
        from: operation.state,
        to: "FAILED",
        actor: options.actor,
        detail: { type: operation.type, printerId: operation.printerId, note: options.note ?? null }
      });
      return saved;
    });
  }

  /** The operation is no longer needed (its work was withdrawn). Idempotent. */
  cancel(operationId: string, reason: string, actor?: string): ManualOperation {
    return this.store.transaction(() => {
      const operation = this.getOperation(operationId);
      if (operation.state === "CANCELLED") return operation;
      if (operation.state === "COMPLETED") {
        throw new JobError(`Операция ${operationId} уже выполнена — отменять нечего`);
      }
      return this.cancelInternal(operation, reason, actor);
    });
  }

  /**
   * Cancels every unfinished operation opened for an assignment — the cascade a
   * cancelled/withdrawn assignment must trigger, so a machine is not held for
   * work nobody is going to do.
   *
   * A clearance operation is **kept**: the assignment being cancelled does not
   * take the part off the plate. Cancelling that one too is precisely the bug
   * this whole model exists to prevent, so it is filtered out explicitly rather
   * than left to a caller to remember.
   */
  cancelForAssignment(assignmentId: string, reason: string, actor?: string): ManualOperation[] {
    return this.store.transaction(() => {
      const cancelled: ManualOperation[] = [];
      for (const operation of this.store.repositories.manualOperations.listByAssignment(assignmentId)) {
        if (operation.state === "COMPLETED" || operation.state === "CANCELLED") continue;
        if (BED_CLEARING_TYPES.has(operation.type) && operation.bedCycleId) continue;
        cancelled.push(this.cancelInternal(operation, reason, actor));
      }
      return cancelled;
    });
  }

  /**
   * Boot-time recovery. The rows themselves are durable (SQLite), so nothing has
   * to be reconstructed; what must be re-derived is **readiness**, which depends
   * on the clock and the schedule and is therefore stale after any downtime.
   *
   * An `IN_PROGRESS` operation orphaned by a restart is deliberately left alone:
   * a human may well still be holding the nozzle. It is reported, not reset.
   */
  recover(): { open: number; inProgress: number; promoted: number; demoted: number } {
    const operations = this.listOpen();
    const inProgress = operations.filter((op) => op.state === "IN_PROGRESS").length;
    const { promoted, demoted } = this.refreshReadiness();
    if (operations.length > 0) {
      this.logger.warn?.(
        { open: operations.length, inProgress, promoted, demoted },
        "manual operations recovered after restart — printers stay held until they are confirmed"
      );
    }
    return { open: operations.length, inProgress, promoted, demoted };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Moves one operation between `PENDING` and `READY` to match the current
   * availability. Returns the saved row when it moved, else `null`.
   */
  private evaluateReadiness(
    operation: ManualOperation,
    actor?: string,
    availability?: OperatorAvailability,
    now?: Date
  ): ManualOperation | null {
    if (operation.state !== "PENDING" && operation.state !== "READY") return null;
    const at = now ?? this.nowFn();
    const resolved = availability ?? this.schedule.availability(at);
    const verdict = resolveReadiness(operation, resolved, at);
    const target: ManualOperationState = verdict.ready ? "READY" : "PENDING";
    if (target === operation.state) return null;

    const iso = at.toISOString();
    assertOperationTransition(operation.state, target);
    const saved = this.store.repositories.manualOperations.update({
      ...operation,
      state: target,
      readyAt: target === "READY" ? (operation.readyAt ?? iso) : operation.readyAt,
      updatedAt: iso
    });
    this.audit("manual_operation", operation.id, target === "READY" ? "ready" : "deferred", {
      from: operation.state,
      to: target,
      actor,
      detail: {
        printerId: operation.printerId,
        type: operation.type,
        presence: resolved.presence,
        reason: verdict.reason
      }
    });
    return saved;
  }

  private cancelInternal(operation: ManualOperation, reason: string, actor?: string): ManualOperation {
    const iso = this.nowIso();
    assertOperationTransition(operation.state, "CANCELLED");
    const saved = this.store.repositories.manualOperations.update({
      ...operation,
      state: "CANCELLED",
      note: reason,
      completedAt: iso,
      updatedAt: iso
    });
    this.audit("manual_operation", operation.id, "cancelled", {
      from: operation.state,
      to: "CANCELLED",
      actor,
      detail: { type: operation.type, printerId: operation.printerId, reason }
    });
    return saved;
  }

  /**
   * The bed half of a confirmed clearance. Only `AWAITING_CLEARANCE` moves — a
   * `RUNNING`/`RESERVED` bed means the operation is stale (a new print already
   * started), and silently clearing that would free a plate that is in use.
   */
  private clearBedFor(operation: ManualOperation, actor: string): void {
    if (!operation.bedCycleId) return;
    const repos = this.store.repositories;
    const bed = repos.bedCycles.getById(operation.bedCycleId);
    if (!bed) return;
    if (bed.state !== "AWAITING_CLEARANCE" && bed.state !== "UNKNOWN") return;

    const iso = this.nowIso();
    assertTransition("цикл стола", BED_CYCLE_TRANSITIONS, bed.state, "CLEAR");
    repos.bedCycles.update({
      ...bed,
      state: "CLEAR",
      clearedAt: iso,
      updatedAt: iso,
      metadata: {
        ...bed.metadata,
        clearance: operation.type === "PLATE_SERVICE" ? "plate_swapped" : "part_removed",
        clearedBy: actor,
        clearedByOperationId: operation.id
      }
    });
    this.audit("bed_cycle", bed.id, "cleared", {
      from: bed.state,
      to: "CLEAR",
      actor,
      detail: {
        printerId: operation.printerId,
        operationId: operation.id,
        confirmation: operation.type === "PLATE_SERVICE" ? "plate_swapped" : "part_removed"
      }
    });
  }

  private audit(
    entityType: AuditEntityType,
    entityId: string,
    action: string,
    extra: { from?: string; to?: string; actor?: string; detail?: Metadata } = {}
  ): void {
    const input: AuditInput = {
      entityType,
      entityId,
      action,
      ...(extra.from ? { from: extra.from } : {}),
      ...(extra.to ? { to: extra.to } : {}),
      ...(extra.actor ? { actor: extra.actor } : {}),
      detail: extra.detail ?? {}
    };
    recordAuditEvent(this.store, () => this.nowIso(), this.actor, input);
  }

  private nowIso(): string {
    return this.nowFn().toISOString();
  }
}

/** A finite, non-negative duration, or null — never NaN, never negative. */
function normalizeMinutes(value: number | null): number | null {
  if (value === null) return null;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function elapsedMinutes(startedAt: string | null, now: Date): number | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  return Math.max(0, Math.round((now.getTime() - started) / 60_000));
}

/**
 * Minutes a printer has already sat idle waiting for a human — the figure the
 * dashboard shows as "вынужденный простой". Measured from the moment the oldest
 * blocking operation was opened, and only while it is actually waiting for an
 * operator (time spent with an operator's hands on the machine is work, not idle).
 */
function forcedIdleMinutes(projection: PrinterReleaseProjection, now: Date): number | null {
  if (projection.free || !projection.waitingForOperator) return null;
  const opened = projection.blocking
    .map((op) => Date.parse(op.createdAt))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b)[0];
  if (opened === undefined) return null;
  return Math.max(0, Math.round((now.getTime() - opened) / 60_000));
}
