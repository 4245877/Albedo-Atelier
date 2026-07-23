import { ValidationError } from "../../core/errors";
import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  ASSIGNMENT_TRANSITIONS,
  assertTransition,
  BED_CYCLE_TRANSITIONS,
  PRINT_TASK_TRANSITIONS,
  QUEUE_ENTRY_TRANSITIONS
} from "../../domain/print/states";
import type { Assignment, BedCycle, PrintTask, QueueEntry } from "../../domain/print/types";
import { recordAuditEvent, type AuditInput } from "../audit";

/** How a queue reservation is positioned relative to the current tail. */
export const POSITION_STEP = 10;

/**
 * Shared collaborator state and cross-cutting helpers for the print-queue use
 * cases (task commands, queue commands, queries). Owns the audited state
 * transitions so every module moves entities through the same domain-checked,
 * audit-appending path. Not exported outside `app/printQueue`.
 */
export class PrintQueueContext {
  readonly now: () => Date;
  readonly defaultActor: string;
  private readonly isPrinterConfiguredFn: ((printerId: string) => boolean) | null;

  constructor(
    readonly store: PrintQueueStore,
    options: {
      now?: () => Date;
      actor?: string;
      isPrinterConfigured?: (printerId: string) => boolean;
    } = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.defaultActor = options.actor ?? "operator";
    this.isPrinterConfiguredFn = options.isPrinterConfigured ?? null;
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  recordAudit(input: AuditInput): void {
    recordAuditEvent(this.store, () => this.nowIso(), this.defaultActor, input);
  }

  /** Refuses a pin to a printer the farm does not know (when a config check is wired). */
  assertPrinterConfigured(printerId: string): void {
    if (this.isPrinterConfiguredFn && !this.isPrinterConfiguredFn(printerId)) {
      throw new ValidationError(`Принтер «${printerId}» отсутствует в конфигурации фермы`);
    }
  }

  nextPosition(): number {
    const max = this.store.repositories.queue.maxPosition();
    return (max ?? 0) + POSITION_STEP;
  }

  // ── Audited state transitions ────────────────────────────────────────────────

  transitionTask(
    task: PrintTask,
    to: PrintTask["state"],
    patch: Partial<Pick<PrintTask, "reason" | "targetPrinter">>,
    action: string,
    actor?: string
  ): PrintTask {
    assertTransition("задание", PRINT_TASK_TRANSITIONS, task.state, to);
    const saved = this.store.repositories.tasks.update({
      ...task,
      ...patch,
      state: to,
      updatedAt: this.nowIso()
    });
    this.recordAudit({
      entityType: "print_task",
      entityId: task.id,
      action,
      from: task.state,
      to,
      actor
    });
    return saved;
  }

  transitionEntry(entry: QueueEntry, to: QueueEntry["state"], actor?: string): QueueEntry {
    assertTransition("запись очереди", QUEUE_ENTRY_TRANSITIONS, entry.state, to);
    const saved = this.store.repositories.queue.update({
      ...entry,
      state: to,
      updatedAt: this.nowIso()
    });
    this.recordAudit({
      entityType: "queue_entry",
      entityId: entry.id,
      action: "transition",
      from: entry.state,
      to,
      actor
    });
    return saved;
  }

  transitionAssignment(assignment: Assignment, to: Assignment["state"], actor?: string): Assignment {
    assertTransition("назначение", ASSIGNMENT_TRANSITIONS, assignment.state, to);
    const saved = this.store.repositories.assignments.update({
      ...assignment,
      state: to,
      updatedAt: this.nowIso()
    });
    this.recordAudit({
      entityType: "assignment",
      entityId: assignment.id,
      action: "transition",
      from: assignment.state,
      to,
      actor
    });
    return saved;
  }

  transitionBed(bed: BedCycle, to: BedCycle["state"], actor?: string): BedCycle {
    assertTransition("цикл стола", BED_CYCLE_TRANSITIONS, bed.state, to);
    const saved = this.store.repositories.bedCycles.update({
      ...bed,
      state: to,
      clearedAt: to === "CLEAR" ? this.nowIso() : bed.clearedAt,
      updatedAt: this.nowIso()
    });
    this.recordAudit({
      entityType: "bed_cycle",
      entityId: bed.id,
      action: "transition",
      from: bed.state,
      to,
      actor
    });
    return saved;
  }

  /** Cancels/releases an assignment and returns its bed to a safe state. */
  unwindAssignment(assignment: Assignment, to: "CANCELLED" | "RELEASED", actor?: string): void {
    const repos = this.store.repositories;
    // Cancel any live run first so the run's own terminal invariant holds.
    for (const run of repos.printRuns.listByTask(assignment.taskId)) {
      if (run.assignmentId === assignment.id && (run.state === "RUNNING" || run.state === "PAUSED")) {
        const saved = repos.printRuns.update({
          ...run,
          state: "CANCELLED",
          endedAt: this.nowIso(),
          updatedAt: this.nowIso()
        });
        this.recordAudit({
          entityType: "print_run",
          entityId: saved.id,
          action: "cancelled",
          from: run.state,
          to: "CANCELLED",
          actor
        });
      }
    }
    this.transitionAssignment(assignment, to, actor);
    if (assignment.bedCycleId) {
      const bed = repos.bedCycles.getById(assignment.bedCycleId);
      if (bed) {
        // A reserved bed had nothing printed → back to CLEAR; a running/awaiting
        // bed may hold a part → AWAITING_CLEARANCE for the operator.
        if (bed.state === "RESERVED") this.transitionBed(bed, "CLEAR", actor);
        else if (bed.state === "RUNNING") this.transitionBed(bed, "AWAITING_CLEARANCE", actor);
      }
    }
  }

  holdEntryFor(taskId: string, actor?: string): void {
    const entry = this.store.repositories.queue.findByTaskId(taskId);
    if (entry && entry.state === "WAITING") {
      this.transitionEntry(entry, "HELD", actor);
    }
  }
}

export function isTaskTerminal(state: PrintTask["state"]): boolean {
  return state === "COMPLETED" || state === "FAILED" || state === "CANCELLED";
}
