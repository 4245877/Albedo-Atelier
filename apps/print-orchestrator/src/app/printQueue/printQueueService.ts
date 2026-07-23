import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Assignment, AuditEvent, PrintTask, QueueEntry } from "../../domain/print/types";
import type { QueueJob } from "../../domain/dashboard/types";
import { PrintQueueContext } from "./context";
import type { QueueProjectionRow } from "./projection";
import { QueueCommands } from "./queueCommands";
import { QueueQueries, type TaskDetail } from "./queueQueries";
import {
  TaskCommands,
  type CreateTaskInput,
  type ManualTaskInput,
  type TaskSchedulingPatch
} from "./taskCommands";

export type { CreateTaskInput, ManualTaskInput, TaskSchedulingPatch } from "./taskCommands";
export type { TaskDetail } from "./queueQueries";

/**
 * The application service for the persistent print queue: the one place that
 * turns operator/dispatcher intents into valid, audited, transactional changes
 * across the entities. A facade over three use-case modules sharing one
 * {@link PrintQueueContext}:
 *
 *   - {@link TaskCommands} — task lifecycle (create/add/promote/hold/release/
 *     cancel, scheduling params, printer pins);
 *   - {@link QueueCommands} — queue shape (reorder) and the manual task→printer
 *     binding (assignment + bed reservation);
 *   - {@link QueueQueries} — reads (tasks, open queue, legacy projection, task
 *     detail, audit feed).
 *
 * Every mutation goes through {@link PrintQueueStore.transaction}, so a change
 * that spans several entities either lands whole or not at all. Every state move
 * is checked against the domain transition maps *before* it is written, and
 * every change appends an `AuditEvent` — the structured successor to the
 * JSON event feed, satisfying "сохрани существующие механизмы … журнал событий".
 *
 * Scope: task/queue authoring and the *manual* task→printer binding
 * ({@link assignTask}, plus the cancel unwind). The physical print lifecycle —
 * dispatch attempts, run start/finish and bed-cycle transitions — is NOT here:
 * it lives in the canonical `DispatchService` (the only path that reaches a
 * printer) and `RunLifecycleService` (poll-driven reconciliation, recovery,
 * completion). Those services own the dispatch/run/bed state machine so there is
 * a single, transactional source of truth for it.
 */
export class PrintQueueService {
  private readonly queries: QueueQueries;
  private readonly tasks: TaskCommands;
  private readonly queue: QueueCommands;

  constructor(
    store: PrintQueueStore,
    options: {
      now?: () => Date;
      actor?: string;
      /** Farm-config check for a printer id; when set, pins to unknown printers are refused. */
      isPrinterConfigured?: (printerId: string) => boolean;
    } = {}
  ) {
    const ctx = new PrintQueueContext(store, options);
    this.queries = new QueueQueries(ctx);
    this.tasks = new TaskCommands(ctx, this.queries);
    this.queue = new QueueCommands(ctx, this.queries);
  }

  // ── Reads (QueueQueries) ─────────────────────────────────────────────────────

  listTasks(): PrintTask[] {
    return this.queries.listTasks();
  }

  getTask(id: string): PrintTask {
    return this.queries.getTask(id);
  }

  listOpenQueue(): QueueProjectionRow[] {
    return this.queries.listOpenQueue();
  }

  projectLegacyQueue(): QueueJob[] {
    return this.queries.projectLegacyQueue();
  }

  getTaskDetail(id: string): TaskDetail {
    return this.queries.getTaskDetail(id);
  }

  listAudit(limit?: number): AuditEvent[] {
    return this.queries.listAudit(limit);
  }

  // ── Task lifecycle (TaskCommands) ────────────────────────────────────────────

  createTask(input: CreateTaskInput, actor?: string): TaskDetail {
    return this.tasks.createTask(input, actor);
  }

  addTask(input: ManualTaskInput, actor?: string): TaskDetail {
    return this.tasks.addTask(input, actor);
  }

  promoteSliceVariant(
    variantId: string,
    input: { onDeviceFile?: string | null } = {},
    actor?: string
  ): TaskDetail {
    return this.tasks.promoteSliceVariant(variantId, input, actor);
  }

  holdTask(id: string, reason?: string, actor?: string): PrintTask {
    return this.tasks.holdTask(id, reason, actor);
  }

  releaseTask(id: string, actor?: string): PrintTask {
    return this.tasks.releaseTask(id, actor);
  }

  cancelTask(id: string, reason?: string, actor?: string): PrintTask {
    return this.tasks.cancelTask(id, reason, actor);
  }

  setTaskScheduling(id: string, patch: TaskSchedulingPatch, actor?: string): PrintTask {
    return this.tasks.setTaskScheduling(id, patch, actor);
  }

  pinPrinter(id: string, printerId: string, actor?: string): PrintTask {
    return this.tasks.pinPrinter(id, printerId, actor);
  }

  unpinPrinter(id: string, actor?: string): PrintTask {
    return this.tasks.unpinPrinter(id, actor);
  }

  // ── Queue shape + manual binding (QueueCommands) ─────────────────────────────

  reorderTask(id: string, newPosition: number, expectedVersion: number, actor?: string): QueueEntry {
    return this.queue.reorderTask(id, newPosition, expectedVersion, actor);
  }

  assignTask(
    taskId: string,
    printerId: string,
    options: { planId?: string } = {},
    actor?: string
  ): Assignment {
    return this.queue.assignTask(taskId, printerId, options, actor);
  }
}
