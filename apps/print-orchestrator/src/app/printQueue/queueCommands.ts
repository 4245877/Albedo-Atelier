import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { newId, ID_PREFIX } from "../../domain/print/ids";
import type { Assignment, BedCycle, QueueEntry } from "../../domain/print/types";
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
   * Binds a `QUEUED`/`PLANNED` task to a printer: opens a bed cycle in `RESERVED`
   * (a printer with no open cycle is treated as `CLEAR`), creates the
   * `RESERVED` assignment linked to it, and moves the task to `ASSIGNED`. Refuses
   * when the printer's bed is not clear. This is a manual/explicit binding —
   * automatic distribution is a later module.
   */
  assignTask(
    taskId: string,
    printerId: string,
    options: { planId?: string } = {},
    actor?: string
  ): Assignment {
    const printer = printerId.trim();
    if (!printer) throw new ValidationError("Не указан принтер для назначения");

    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const task = this.queries.getTask(taskId);

      // Invariants first (the 008 partial unique indexes are the backstop):
      // one live assignment per task, one per printer, no active run on either.
      const liveOfTask = repos.assignments
        .listByTask(taskId)
        .find((a) => a.state === "RESERVED" || a.state === "ACTIVE");
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

      const openBed = repos.bedCycles.findOpenByPrinter(printer);
      if (openBed) {
        throw new JobError(
          `Стол принтера «${printer}» не свободен (${openBed.state}) — назначение невозможно`
        );
      }

      const iso = this.ctx.nowIso();
      const bed: BedCycle = {
        id: newId(ID_PREFIX.bedCycle),
        printerId: printer,
        state: "RESERVED",
        assignmentId: null,
        createdAt: iso,
        updatedAt: iso,
        clearedAt: null,
        version: 1,
        metadata: {}
      };
      repos.bedCycles.insert(bed);
      this.ctx.recordAudit({
        entityType: "bed_cycle",
        entityId: bed.id,
        action: "reserved",
        from: "CLEAR",
        to: "RESERVED",
        actor,
        detail: { printerId: printer }
      });

      const assignment: Assignment = {
        id: newId(ID_PREFIX.assignment),
        taskId,
        printerId: printer,
        planId: options.planId ?? null,
        bedCycleId: bed.id,
        state: "RESERVED",
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
        action: "reserved",
        to: "RESERVED",
        actor,
        detail: { printerId: printer, taskId }
      });

      // Soft back-link bed → assignment (kept consistent by the service).
      repos.bedCycles.update({ ...bed, assignmentId: assignment.id, updatedAt: this.ctx.nowIso() });

      this.ctx.transitionTask(task, "ASSIGNED", { targetPrinter: printer }, "assigned", actor);
      return assignment;
    });
  }
}
