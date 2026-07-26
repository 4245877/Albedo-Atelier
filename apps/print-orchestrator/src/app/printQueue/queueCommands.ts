import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { newId, ID_PREFIX } from "../../domain/print/ids";
import type { Assignment, QueueEntry } from "../../domain/print/types";
import { resolveTaskBinding } from "../dispatch/binding";
import { POSITION_STEP, type PrintQueueContext } from "./context";
import type { QueueQueries } from "./queueQueries";

/**
 * Queue-shape commands: reordering the open queue and the manual task→printer
 * binding (assignment + bed reservation). Task-lifecycle commands live in
 * `TaskCommands`; reads in `QueueQueries`.
 */
export class QueueCommands {
  constructor(
    private readonly ctx: PrintQueueContext,
    private readonly queries: QueueQueries
  ) {}

  private get store() {
    return this.ctx.store;
  }

  /**
   * Moves a task's queue entry to a new position with optimistic concurrency:
   * the caller passes the `expectedVersion` it read, and a racing reorder makes
   * this throw `VersionConflictError` instead of silently reordering stale data.
   */
  reorderTask(id: string, newPosition: number, expectedVersion: number, actor?: string): QueueEntry {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const entry = repos.queue.findByTaskId(id);
      if (!entry) throw new NotFoundError(`Запись очереди для задания «${id}»`);

      // Re-space the whole open queue onto POSITION_STEP multiples, with `entry`
      // slotted at `newPosition`. Renumbering on every move is what keeps ↑/↓
      // working: the dashboard moves a task by asking for `neighbour.position ± 1`,
      // which only lands in a clean gap while adjacent positions differ by ≥ 2.
      // Without this the gaps collapse after enough reorders, equal positions fall
      // back to enqueue time, and the arrows silently stop moving anything.
      const ordered = repos.queue
        .listOpen()
        .map((e) => (e.id === entry.id ? { entry: e, sortPos: newPosition } : { entry: e, sortPos: e.position }))
        .sort((a, b) =>
          a.sortPos !== b.sortPos
            ? a.sortPos - b.sortPos
            : a.entry.enqueuedAt !== b.entry.enqueuedAt
              ? a.entry.enqueuedAt < b.entry.enqueuedAt
                ? -1
                : 1
              : a.entry.id < b.entry.id
                ? -1
                : 1
        );

      // Each entry is updated at most once: the moved one under the caller's
      // optimistic guard (a racing reorder throws VersionConflictError, rolling the
      // whole transaction back so no audit is written), the rest only when their
      // normalised position actually changes.
      let moved: QueueEntry | null = null;
      for (let index = 0; index < ordered.length; index++) {
        const e = ordered[index].entry;
        const position = (index + 1) * POSITION_STEP;
        if (e.id === entry.id) {
          moved = repos.queue.update({ ...entry, version: expectedVersion, position, updatedAt: this.ctx.nowIso() });
        } else if (e.position !== position) {
          repos.queue.update({ ...e, position, updatedAt: this.ctx.nowIso() });
        }
      }
      if (!moved) throw new NotFoundError(`Запись очереди для задания «${id}»`);

      this.ctx.invalidatePlacementsFor(id, "изменён порядок очереди", actor);
      this.ctx.recordAudit({
        entityType: "queue_entry",
        entityId: entry.id,
        action: "reordered",
        actor,
        detail: { position: moved.position }
      });
      return moved;
    });
  }

  /**
   * Binds a `QUEUED`/`PLANNED` task to a printer manually — the operator's
   * "print this on that machine" decision.
   *
   * The result is an **executable** `PROPOSED` assignment carrying the task's full
   * {@link resolveTaskBinding binding} (slice variant, artifact + hash, the three
   * profile revisions, expected remote path, material/nozzle/flavor/ETA), the
   * printer id, the operator's reason and who made the call — everything
   * `DispatchService.startAssignment` needs to execute exactly this decision.
   *
   * What changed and why: this used to open a `RESERVED` bed cycle and move the
   * task to `ASSIGNED` immediately. That was a **dead end** — the dispatch gate
   * refuses any task not in `QUEUED`, refuses a printer whose bed cycle is open,
   * and refuses a printer already holding a live assignment, so a manually
   * assigned task could never be started by any route; the only way out was to
   * cancel it. A manual assignment now holds no hardware (exactly like a plan's
   * proposal): the bed is reserved and the task moves on inside the dispatch
   * transaction, at the moment a start is actually attempted.
   */
  assignTask(
    taskId: string,
    printerId: string,
    options: { planId?: string; reason?: string } = {},
    actor?: string
  ): Assignment {
    const printer = printerId.trim();
    if (!printer) throw new ValidationError("Не указан принтер для назначения");
    this.ctx.assertPrinterConfigured(printer);

    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const task = this.queries.getTask(taskId);

      if (task.state !== "QUEUED" && task.state !== "PLANNED") {
        throw new JobError(
          `Задание «${task.title}» в состоянии «${task.state}» — ручное назначение доступно только из QUEUED/PLANNED`
        );
      }

      // Invariants first (the 008 partial unique indexes are the backstop):
      // one live assignment per task, one per printer, no active run on either.
      const liveOfTask = repos.assignments
        .listByTask(taskId)
        .find((a) => a.state !== "CANCELLED" && a.state !== "RELEASED");
      if (liveOfTask) {
        throw new JobError(
          `Задание «${task.title}» уже назначено (${liveOfTask.printerId}, ${liveOfTask.state}) — сначала снимите назначение`
        );
      }
      const liveOnPrinter = repos.assignments.findOpenByPrinter(printer);
      if (liveOnPrinter) {
        throw new JobError(
          `Принтер «${printer}» уже занят назначением ${liveOnPrinter.id} (${liveOnPrinter.state})`
        );
      }
      const activeRun =
        repos.printRuns.findActiveByTask(taskId) ?? repos.printRuns.findActiveByPrinter(printer);
      if (activeRun) {
        throw new JobError(
          `Есть активная печать ${activeRun.id} (${activeRun.state}) — назначение невозможно`
        );
      }

      const iso = this.ctx.nowIso();
      const { binding } = resolveTaskBinding(repos, task);

      const assignment: Assignment = {
        id: newId(ID_PREFIX.assignment),
        taskId,
        printerId: printer,
        planId: options.planId ?? null,
        bedCycleId: null,
        state: "PROPOSED",
        source: options.planId ? "plan" : "manual",
        reason: options.reason?.trim() || null,
        createdBy: actor ?? this.ctx.defaultActor,
        binding,
        invalidatedAt: null,
        invalidatedReason: null,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        legacyRef: null,
        metadata: {}
      };
      repos.assignments.insert(assignment);
      this.ctx.recordAudit({
        entityType: "assignment",
        entityId: assignment.id,
        action: "assigned_manually",
        to: "PROPOSED",
        actor,
        detail: {
          printerId: printer,
          taskId,
          reason: assignment.reason,
          sliceVariantId: binding.sliceVariantId,
          artifactSha256: binding.artifactSha256,
          profileRevisionIds: [
            binding.machineRevisionId,
            binding.processRevisionId,
            binding.filamentRevisionId
          ].filter(Boolean),
          expectedRemotePath: binding.expectedRemotePath
        }
      });

      // The task stays QUEUED/WAITING on purpose: it is still queue work, now with
      // a printer decided. `PLANNED` records that a placement exists without
      // claiming the device — the state the dispatch gate accepts a start from is
      // still QUEUED, so nothing here can wedge it.
      return assignment;
    });
  }

  /**
   * Marks an assignment stale: it stays in history but may never be executed.
   * Used when the queue changes underneath a confirmed plan, when the task is
   * re-sliced, or when an operator withdraws a manual placement.
   */
  invalidateAssignment(assignmentId: string, reason: string, actor?: string): Assignment {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const assignment = repos.assignments.getById(assignmentId);
      if (!assignment) throw new NotFoundError(`Назначение «${assignmentId}»`);
      if (assignment.state === "ACTIVE") {
        throw new JobError(
          `Назначение ${assignmentId} уже исполняется — остановите печать, а не пометку назначения`
        );
      }
      if (assignment.invalidatedAt) return assignment;
      const saved = repos.assignments.update({
        ...assignment,
        invalidatedAt: this.ctx.nowIso(),
        invalidatedReason: reason,
        updatedAt: this.ctx.nowIso()
      });
      this.ctx.recordAudit({
        entityType: "assignment",
        entityId: assignmentId,
        action: "invalidated",
        actor,
        detail: { reason }
      });
      return saved;
    });
  }
}
