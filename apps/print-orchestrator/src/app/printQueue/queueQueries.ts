import { NotFoundError } from "../../core/errors";
import type {
  Artifact,
  ArtifactAnalysis,
  Assignment,
  AuditEvent,
  DispatchAttempt,
  PrintRun,
  PrintTask,
  QueueEntry
} from "../../domain/print/types";
import type { QueueJob } from "../../domain/dashboard/types";
import type { PrintQueueContext } from "./context";
import { toLegacyQueue, type QueueProjectionRow } from "./projection";

/** The full durable chain for one task — what a task-detail API returns. */
export interface TaskDetail {
  task: PrintTask;
  artifact: Artifact | null;
  analyses: ArtifactAnalysis[];
  queueEntry: QueueEntry | null;
  assignments: Assignment[];
  dispatchAttempts: DispatchAttempt[];
  printRuns: PrintRun[];
  audit: AuditEvent[];
}

/**
 * Read side of the print queue: tasks, the open queue (raw and as the legacy
 * dashboard projection), the per-task durable chain, and the audit feed. Pure
 * queries — no writes, no transitions.
 */
export class QueueQueries {
  constructor(private readonly ctx: PrintQueueContext) {}

  listTasks(): PrintTask[] {
    return this.ctx.store.repositories.tasks.list();
  }

  getTask(id: string): PrintTask {
    const task = this.ctx.store.repositories.tasks.getById(id);
    if (!task) throw new NotFoundError(`Задание «${id}»`);
    return task;
  }

  /** The open queue as `{ entry, task, artifact }` rows, ordered by position. */
  listOpenQueue(): QueueProjectionRow[] {
    const repos = this.ctx.store.repositories;
    const entries = repos.queue.listOpen();
    return entries.map((entry) => {
      const task = repos.tasks.getById(entry.taskId);
      if (!task) {
        // A queue_entries row without its task cannot happen (FK ON DELETE
        // CASCADE removes the entry with the task), but narrow defensively.
        throw new NotFoundError(`Задание «${entry.taskId}»`);
      }
      const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
      return { entry, task, artifact };
    });
  }

  /** The open queue projected into the legacy dashboard shape (read-only). */
  projectLegacyQueue(): QueueJob[] {
    return toLegacyQueue(this.listOpenQueue());
  }

  /** The whole durable chain for one task. */
  getTaskDetail(id: string): TaskDetail {
    const repos = this.ctx.store.repositories;
    const task = this.getTask(id);
    return {
      task,
      artifact: task.artifactId ? repos.artifacts.getById(task.artifactId) : null,
      analyses: task.artifactId ? repos.artifactAnalyses.listByArtifact(task.artifactId) : [],
      queueEntry: repos.queue.findByTaskId(id),
      assignments: repos.assignments.listByTask(id),
      dispatchAttempts: repos.assignments
        .listByTask(id)
        .flatMap((a) => repos.dispatchAttempts.listByAssignment(a.id)),
      printRuns: repos.printRuns.listByTask(id),
      audit: repos.audit.listByEntity("print_task", id)
    };
  }

  listAudit(limit?: number): AuditEvent[] {
    return this.ctx.store.repositories.audit.list(limit);
  }
}
