import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { newId, ID_PREFIX } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  ASSIGNMENT_TRANSITIONS,
  assertTransition,
  BED_CYCLE_TRANSITIONS,
  DISPATCH_ATTEMPT_TRANSITIONS,
  PRINT_RUN_TRANSITIONS,
  PRINT_TASK_TRANSITIONS,
  QUEUE_ENTRY_TRANSITIONS
} from "../../domain/print/states";
import type {
  Artifact,
  ArtifactAnalysis,
  Assignment,
  AuditEntityType,
  AuditEvent,
  BedCycle,
  DayNightPreference,
  DispatchAttempt,
  Metadata,
  PrintRun,
  PrintTask,
  QueueEntry
} from "../../domain/print/types";
import type { QueueJob } from "../../domain/dashboard/types";
import { toLegacyQueue, type QueueProjectionRow } from "./projection";

/** Operator input for a new task; only `title` is required. */
export interface CreateTaskInput {
  title: string;
  /** Target printer hint (name or id); absent → task parks in NEEDS_REVIEW. */
  printer?: string;
  material?: string;
  /** On-printer G-code file name; recorded as an Artifact and projection `file`. */
  file?: string;
  night?: boolean;
  priority?: number;
  /** Presentation-only fields the legacy queue rendered; kept in task metadata. */
  eta?: string;
  at?: string;
}

/**
 * Operator input for the manual scheduler queue. Unlike {@link CreateTaskInput}
 * (the legacy-style quick add that parks printer-less tasks in review), a
 * manually-scheduled task always enters the queue `WAITING` — the planner is what
 * assigns a printer — and carries the scheduling intent the heuristic reads.
 */
export interface ManualTaskInput {
  title: string;
  /** An existing artifact (e.g. an uploaded/sliced model) to attach; must exist. */
  artifactId?: string | null;
  material?: string | null;
  priority?: number;
  notBefore?: string | null;
  deadline?: string | null;
  dayNightPreference?: DayNightPreference;
  /** Hard-pin to a printer id up front (optional). */
  pinnedPrinterId?: string | null;
  unattendedAllowed?: boolean;
  night?: boolean;
}

/** A partial update of a task's scheduling parameters (all fields optional). */
export interface TaskSchedulingPatch {
  priority?: number;
  notBefore?: string | null;
  deadline?: string | null;
  dayNightPreference?: DayNightPreference;
  unattendedAllowed?: boolean;
  night?: boolean;
  material?: string | null;
  /** Optimistic guard: when set, the update fails if the task version moved. */
  expectedVersion?: number;
}

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

/** How a queue reservation is positioned relative to the current tail. */
const POSITION_STEP = 10;

/**
 * The application service for the persistent print queue: the one place that
 * turns operator/dispatcher intents into valid, audited, transactional changes
 * across the entities.
 *
 * Every mutation goes through {@link PrintQueueStore.transaction}, so a change
 * that spans several entities (assign a task → reserve a bed → create an
 * assignment → move the task) either lands whole or not at all. Every state move
 * is checked against the domain transition maps *before* it is written, and
 * every change appends an {@link AuditEvent} — the structured successor to the
 * JSON event feed, satisfying "сохрани существующие механизмы … журнал событий".
 *
 * Out of scope for this stage (and deliberately absent, not stubbed): talking to
 * a real printer. The dispatch/run methods here perform the *state* transitions
 * a future remote-start module and status poller will drive; they never open a
 * device connection themselves.
 */
/** Allowed operator priority band. Beyond this a single job would dominate/break the score. */
const PRIORITY_MIN = -10;
const PRIORITY_MAX = 100;

export class PrintQueueService {
  private readonly now: () => Date;
  private readonly defaultActor: string;
  private readonly isPrinterConfigured: ((printerId: string) => boolean) | null;

  constructor(
    private readonly store: PrintQueueStore,
    options: {
      now?: () => Date;
      actor?: string;
      /** Farm-config check for a printer id; when set, pins to unknown printers are refused. */
      isPrinterConfigured?: (printerId: string) => boolean;
    } = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.defaultActor = options.actor ?? "operator";
    this.isPrinterConfigured = options.isPrinterConfigured ?? null;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  listTasks(): PrintTask[] {
    return this.store.repositories.tasks.list();
  }

  getTask(id: string): PrintTask {
    const task = this.store.repositories.tasks.getById(id);
    if (!task) throw new NotFoundError(`Задание «${id}»`);
    return task;
  }

  /** The open queue as `{ entry, task, artifact }` rows, ordered by position. */
  listOpenQueue(): QueueProjectionRow[] {
    const repos = this.store.repositories;
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
    const repos = this.store.repositories;
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
    return this.store.repositories.audit.list(limit);
  }

  // ── Task / queue lifecycle (operator-facing) ─────────────────────────────────

  /**
   * Creates a task (and, when a file is given, its artifact) and enqueues it.
   * With a target printer the task starts `QUEUED` (entry `WAITING`); without
   * one it parks in `NEEDS_REVIEW` (entry `HELD`) so it never blocks the queue —
   * the same rule the legacy queue used, now expressed in the state machine.
   */
  createTask(input: CreateTaskInput, actor?: string): TaskDetail {
    const title = input.title?.trim();
    if (!title) throw new ValidationError("Поле «title» обязательно");

    const printer = input.printer?.trim() || null;
    const file = input.file?.trim() || null;
    const runnable = printer !== null;
    const iso = this.nowIso();

    return this.store.transaction(() => {
      const repos = this.store.repositories;

      let artifactId: string | null = null;
      if (file) {
        const artifact: Artifact = {
          id: newId(ID_PREFIX.artifact),
          kind: "gcode",
          name: file,
          source: file,
          sizeBytes: null,
          sha256: null,
          createdAt: iso,
          updatedAt: iso,
          version: 1,
          legacyRef: null,
          metadata: {}
        };
        repos.artifacts.insert(artifact);
        artifactId = artifact.id;
        this.recordAudit({ entityType: "artifact", entityId: artifact.id, action: "created", actor });
      }

      const metadata: Metadata = {};
      if (input.eta?.trim()) metadata.eta = input.eta.trim();
      if (input.at?.trim()) metadata.at = input.at.trim();
      if (file) metadata.file = file;

      const task: PrintTask = {
        id: newId(ID_PREFIX.printTask),
        artifactId,
        title,
        material: input.material?.trim() || null,
        targetPrinter: printer,
        priority: normalizePriority(input.priority, 0),
        state: runnable ? "QUEUED" : "NEEDS_REVIEW",
        reason: runnable ? null : "не задан принтер",
        night: input.night === true,
        notBefore: null,
        deadline: null,
        dayNightPreference: input.night === true ? "night" : "any",
        pinnedPrinterId: null,
        unattendedAllowed: false,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        legacyRef: null,
        metadata
      };
      repos.tasks.insert(task);
      this.recordAudit({
        entityType: "print_task",
        entityId: task.id,
        action: "created",
        to: task.state,
        actor
      });

      const entry: QueueEntry = {
        id: newId(ID_PREFIX.queueEntry),
        taskId: task.id,
        position: this.nextPosition(),
        state: runnable ? "WAITING" : "HELD",
        enqueuedAt: iso,
        updatedAt: iso,
        version: 1
      };
      repos.queue.insert(entry);
      this.recordAudit({
        entityType: "queue_entry",
        entityId: entry.id,
        action: "enqueued",
        to: entry.state,
        actor
      });

      return this.getTaskDetail(task.id);
    });
  }

  /**
   * Parks a task for the operator: task → `NEEDS_REVIEW`, its queue entry → `HELD`,
   * so it stops being eligible to run without being removed. The successor to the
   * legacy "move to review".
   */
  holdTask(id: string, reason?: string, actor?: string): PrintTask {
    return this.store.transaction(() => {
      const task = this.getTask(id);
      const trimmed = reason?.trim();
      const updated = this.transitionTask(
        task,
        "NEEDS_REVIEW",
        { reason: trimmed || task.reason || "отложено оператором на проверку" },
        "held",
        actor
      );
      this.holdEntryFor(id, actor);
      return updated;
    });
  }

  /** Returns a parked/failed task to the runnable queue: → `QUEUED`, entry → `WAITING`. */
  releaseTask(id: string, actor?: string): PrintTask {
    return this.store.transaction(() => {
      const task = this.getTask(id);
      const updated = this.transitionTask(task, "QUEUED", { reason: null }, "released", actor);
      const entry = this.store.repositories.queue.findByTaskId(id);
      if (entry && entry.state === "HELD") {
        this.transitionEntry(entry, "WAITING", actor);
      }
      return updated;
    });
  }

  /**
   * Cancels a task without deleting it: task → `CANCELLED`, its queue entry is
   * `RELEASED`, and any open assignment/bed cycle is unwound (a reserved bed goes
   * back to `CLEAR`; a running one to `AWAITING_CLEARANCE`, since a part may still
   * be on it). The row and its whole chain stay as history.
   */
  cancelTask(id: string, reason?: string, actor?: string): PrintTask {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const task = this.getTask(id);
      const updated = this.transitionTask(
        task,
        "CANCELLED",
        { reason: reason?.trim() || task.reason },
        "cancelled",
        actor
      );

      const entry = repos.queue.findByTaskId(id);
      if (entry && entry.state !== "RELEASED") {
        this.transitionEntry(entry, "RELEASED", actor);
      }

      for (const assignment of repos.assignments.listByTask(id)) {
        if (assignment.state === "RELEASED" || assignment.state === "CANCELLED") continue;
        this.unwindAssignment(assignment, "CANCELLED", actor);
      }
      return updated;
    });
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
          moved = repos.queue.update({ ...entry, version: expectedVersion, position, updatedAt: this.nowIso() });
        } else if (e.position !== position) {
          repos.queue.update({ ...e, position, updatedAt: this.nowIso() });
        }
      }
      if (!moved) throw new NotFoundError(`Запись очереди для задания «${id}»`);

      this.recordAudit({
        entityType: "queue_entry",
        entityId: entry.id,
        action: "reordered",
        actor,
        detail: { position: moved.position }
      });
      return moved;
    });
  }

  // ── Manual scheduler queue (operator-facing) ─────────────────────────────────

  /**
   * Adds a task straight into the manual scheduler queue: task `QUEUED`, entry
   * `WAITING`, with the operator's scheduling intent. No target printer is
   * required — the planner assigns one — so, unlike {@link createTask}, a
   * printer-less task is *not* parked in review. A pin, when given, is recorded as
   * both `pinnedPrinterId` and the `targetPrinter` hint.
   */
  addTask(input: ManualTaskInput, actor?: string): TaskDetail {
    const title = input.title?.trim();
    if (!title) throw new ValidationError("Поле «title» обязательно");
    const iso = this.nowIso();
    const notBefore = parseIsoOrNull(input.notBefore, "notBefore");
    const deadline = parseIsoOrNull(input.deadline, "deadline");
    assertWindowOrder(notBefore, deadline);
    const priority = normalizePriority(input.priority, 0);
    const pinned = input.pinnedPrinterId?.trim() || null;
    if (pinned) this.assertPrinterConfigured(pinned);

    return this.store.transaction(() => {
      const repos = this.store.repositories;
      if (input.artifactId) {
        if (!repos.artifacts.getById(input.artifactId)) {
          throw new NotFoundError(`Артефакт «${input.artifactId}»`);
        }
      }

      const night = input.night === true;
      const task: PrintTask = {
        id: newId(ID_PREFIX.printTask),
        artifactId: input.artifactId ?? null,
        title,
        material: input.material?.trim() || null,
        targetPrinter: pinned,
        priority,
        state: "QUEUED",
        reason: null,
        night,
        notBefore,
        deadline,
        dayNightPreference: input.dayNightPreference ?? (night ? "night" : "any"),
        pinnedPrinterId: pinned,
        unattendedAllowed: input.unattendedAllowed === true,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        legacyRef: null,
        metadata: {}
      };
      repos.tasks.insert(task);
      this.recordAudit({
        entityType: "print_task",
        entityId: task.id,
        action: "created",
        to: task.state,
        actor,
        detail: { via: "scheduler" }
      });

      const entry: QueueEntry = {
        id: newId(ID_PREFIX.queueEntry),
        taskId: task.id,
        position: this.nextPosition(),
        state: "WAITING",
        enqueuedAt: iso,
        updatedAt: iso,
        version: 1
      };
      repos.queue.insert(entry);
      this.recordAudit({
        entityType: "queue_entry",
        entityId: entry.id,
        action: "enqueued",
        to: entry.state,
        actor
      });

      return this.getTaskDetail(task.id);
    });
  }

  /**
   * Updates a task's scheduling parameters (priority, notBefore, deadline,
   * day/night preference, unattended permission, material). Refuses on a terminal
   * or in-flight task, and honours an optional optimistic `expectedVersion`.
   */
  setTaskScheduling(id: string, patch: TaskSchedulingPatch, actor?: string): PrintTask {
    return this.store.transaction(() => {
      const task = this.getTask(id);
      if (isTaskTerminal(task.state) || task.state === "PRINTING" || task.state === "DISPATCHING") {
        throw new ValidationError(
          `Параметры планирования нельзя менять для задания в состоянии «${task.state}»`
        );
      }
      const notBefore =
        patch.notBefore === undefined ? task.notBefore : parseIsoOrNull(patch.notBefore, "notBefore");
      const deadline =
        patch.deadline === undefined ? task.deadline : parseIsoOrNull(patch.deadline, "deadline");
      // Validate the *effective* pair — a patch that moves only one of the two can
      // still leave notBefore after the deadline.
      assertWindowOrder(notBefore, deadline);
      const next: PrintTask = {
        ...task,
        priority: patch.priority === undefined ? task.priority : normalizePriority(patch.priority, task.priority),
        notBefore,
        deadline,
        dayNightPreference: patch.dayNightPreference ?? task.dayNightPreference,
        unattendedAllowed:
          typeof patch.unattendedAllowed === "boolean" ? patch.unattendedAllowed : task.unattendedAllowed,
        night: typeof patch.night === "boolean" ? patch.night : task.night,
        material: patch.material === undefined ? task.material : patch.material?.trim() || null,
        version: patch.expectedVersion ?? task.version,
        updatedAt: this.nowIso()
      };
      const saved = this.store.repositories.tasks.update(next);
      this.recordAudit({
        entityType: "print_task",
        entityId: task.id,
        action: "scheduling_updated",
        actor,
        detail: {
          priority: saved.priority,
          notBefore: saved.notBefore,
          deadline: saved.deadline,
          dayNight: saved.dayNightPreference,
          unattended: saved.unattendedAllowed
        }
      });
      return saved;
    });
  }

  /** Pins a task to a specific printer (also updates the `targetPrinter` hint). */
  pinPrinter(id: string, printerId: string, actor?: string): PrintTask {
    const pinned = printerId.trim();
    if (!pinned) throw new ValidationError("Не указан принтер для закрепления");
    this.assertPrinterConfigured(pinned);
    return this.store.transaction(() => {
      const task = this.getTask(id);
      if (isTaskTerminal(task.state)) {
        throw new ValidationError(`Нельзя закрепить принтер для завершённого задания «${task.state}»`);
      }
      const saved = this.store.repositories.tasks.update({
        ...task,
        pinnedPrinterId: pinned,
        targetPrinter: pinned,
        updatedAt: this.nowIso()
      });
      this.recordAudit({
        entityType: "print_task",
        entityId: task.id,
        action: "pinned",
        actor,
        detail: { printerId: pinned }
      });
      return saved;
    });
  }

  /** Removes a task's printer pin (leaves the soft `targetPrinter` hint intact). */
  unpinPrinter(id: string, actor?: string): PrintTask {
    return this.store.transaction(() => {
      const task = this.getTask(id);
      if (task.pinnedPrinterId === null) return task;
      const saved = this.store.repositories.tasks.update({
        ...task,
        pinnedPrinterId: null,
        updatedAt: this.nowIso()
      });
      this.recordAudit({ entityType: "print_task", entityId: task.id, action: "unpinned", actor });
      return saved;
    });
  }

  // ── Assignment + dispatch + run chain (dispatcher-facing) ────────────────────

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
      const task = this.getTask(taskId);

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

      const iso = this.nowIso();
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
      this.recordAudit({
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
      this.recordAudit({
        entityType: "assignment",
        entityId: assignment.id,
        action: "reserved",
        to: "RESERVED",
        actor,
        detail: { printerId: printer, taskId }
      });

      // Soft back-link bed → assignment (kept consistent by the service).
      repos.bedCycles.update({ ...bed, assignmentId: assignment.id, updatedAt: this.nowIso() });

      this.transitionTask(task, "ASSIGNED", { targetPrinter: printer }, "assigned", actor);
      return assignment;
    });
  }

  /**
   * Records one dispatch attempt for an assignment — the seam a future
   * remote-start module writes through when it sends (or fails to send) a start
   * command. Appends a `DispatchAttempt` (auto-incremented `attemptNo`) and, on
   * the first attempt, moves the task `ASSIGNED → DISPATCHING`. No device is
   * contacted here; `state` reflects what the caller observed.
   */
  recordDispatchAttempt(
    assignmentId: string,
    result: { state?: DispatchAttempt["state"]; error?: string } = {},
    actor?: string
  ): DispatchAttempt {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const assignment = this.getAssignment(assignmentId);
      const iso = this.nowIso();
      const state = result.state ?? "PENDING";
      const terminal = state === "ACKED" || state === "FAILED";

      const attempt: DispatchAttempt = {
        id: newId(ID_PREFIX.dispatchAttempt),
        assignmentId,
        taskId: assignment.taskId,
        printerId: assignment.printerId,
        attemptNo: repos.dispatchAttempts.maxAttemptNo(assignmentId) + 1,
        state,
        error: result.error?.trim() || null,
        requestedAt: iso,
        completedAt: terminal ? iso : null,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        metadata: {}
      };
      repos.dispatchAttempts.insert(attempt);
      this.recordAudit({
        entityType: "dispatch_attempt",
        entityId: attempt.id,
        action: "created",
        to: state,
        actor,
        detail: { attemptNo: attempt.attemptNo }
      });

      const task = repos.tasks.getById(assignment.taskId);
      if (task && task.state === "ASSIGNED") {
        this.transitionTask(task, "DISPATCHING", {}, "dispatching", actor);
      }
      if (state === "FAILED") {
        const dispatching = repos.tasks.getById(assignment.taskId);
        if (dispatching && dispatching.state === "DISPATCHING") {
          this.transitionTask(
            dispatching,
            "FAILED",
            { reason: result.error?.trim() || "запуск не удался" },
            "dispatch_failed",
            actor
          );
        }
      }
      return attempt;
    });
  }

  /**
   * Advances a recorded dispatch attempt to a terminal state (`ACKED`/`FAILED`).
   * Used by the future dispatcher once the device answers.
   */
  completeDispatchAttempt(
    attemptId: string,
    result: { ok: boolean; error?: string },
    actor?: string
  ): DispatchAttempt {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const attempt = repos.dispatchAttempts.getById(attemptId);
      if (!attempt) throw new NotFoundError(`Попытка запуска «${attemptId}»`);
      const to: DispatchAttempt["state"] = result.ok ? "ACKED" : "FAILED";
      assertTransition("попытка запуска", DISPATCH_ATTEMPT_TRANSITIONS, attempt.state, to);
      const saved = repos.dispatchAttempts.update({
        ...attempt,
        state: to,
        error: result.error?.trim() || null,
        completedAt: this.nowIso(),
        updatedAt: this.nowIso()
      });
      this.recordAudit({
        entityType: "dispatch_attempt",
        entityId: attempt.id,
        action: "completed",
        from: attempt.state,
        to,
        actor
      });
      return saved;
    });
  }

  /**
   * Opens the actual print: creates a `RUNNING` {@link PrintRun}, moves the task
   * to `PRINTING`, the assignment to `ACTIVE`, and the bed cycle `RESERVED →
   * RUNNING`. The last link of the chain — driven by the poller when it first
   * sees the device printing.
   */
  startRun(
    assignmentId: string,
    options: { dispatchAttemptId?: string; startedAt?: string } = {},
    actor?: string
  ): PrintRun {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const assignment = this.getAssignment(assignmentId);
      const task = this.getTask(assignment.taskId);
      const iso = this.nowIso();

      // One active run per task and per printer — checked here for an honest
      // 409; the 008 partial unique indexes refuse the write regardless.
      const activeOfTask = repos.printRuns.findActiveByTask(assignment.taskId);
      if (activeOfTask) {
        throw new JobError(
          `У задания «${task.title}» уже есть активная печать (${activeOfTask.id}, ${activeOfTask.state})`
        );
      }
      const activeOnPrinter = repos.printRuns.findActiveByPrinter(assignment.printerId);
      if (activeOnPrinter) {
        throw new JobError(
          `На принтере «${assignment.printerId}» уже есть активная печать (${activeOnPrinter.id}, ${activeOnPrinter.state})`
        );
      }
      if (assignment.state === "RELEASED" || assignment.state === "CANCELLED") {
        throw new JobError(
          `Назначение ${assignment.id} уже закрыто (${assignment.state}) — печать по нему невозможна`
        );
      }

      const run: PrintRun = {
        id: newId(ID_PREFIX.printRun),
        taskId: assignment.taskId,
        assignmentId,
        dispatchAttemptId: options.dispatchAttemptId ?? null,
        printerId: assignment.printerId,
        bedCycleId: assignment.bedCycleId,
        state: "RUNNING",
        file: null,
        artifactId: null,
        artifactSha256: null,
        idempotencyKey: null,
        startedAt: options.startedAt ?? iso,
        endedAt: null,
        progress: 0,
        filamentUsedG: null,
        durationS: null,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        legacyRef: null,
        metadata: {}
      };
      repos.printRuns.insert(run);
      this.recordAudit({
        entityType: "print_run",
        entityId: run.id,
        action: "started",
        to: "RUNNING",
        actor,
        detail: { printerId: assignment.printerId }
      });

      // Task may still be ASSIGNED (no dispatch attempt recorded) or DISPATCHING.
      if (task.state === "ASSIGNED") {
        const dispatching = this.transitionTask(task, "DISPATCHING", {}, "dispatching", actor);
        this.transitionTask(dispatching, "PRINTING", {}, "printing", actor);
      } else if (task.state === "DISPATCHING") {
        this.transitionTask(task, "PRINTING", {}, "printing", actor);
      } else {
        assertTransition("задание", PRINT_TASK_TRANSITIONS, task.state, "PRINTING");
      }

      if (assignment.state !== "ACTIVE") {
        this.transitionAssignment(assignment, "ACTIVE", actor);
      }
      if (assignment.bedCycleId) {
        const bed = repos.bedCycles.getById(assignment.bedCycleId);
        if (bed && bed.state === "RESERVED") {
          this.transitionBed(bed, "RUNNING", actor);
        }
      }
      return run;
    });
  }

  /**
   * Closes a run and cascades the outcome: run → `SUCCEEDED`/`FAILED`/`CANCELLED`,
   * task → `COMPLETED`/`FAILED`/`CANCELLED`, assignment → `RELEASED`, and the bed
   * cycle → `AWAITING_CLEARANCE` (a part is on the bed until the operator clears
   * it). Records duration/filament metrics on the run when provided.
   */
  completeRun(
    runId: string,
    outcome: "SUCCEEDED" | "FAILED" | "CANCELLED",
    metrics: { durationS?: number; filamentUsedG?: number; endedAt?: string } = {},
    actor?: string
  ): PrintRun {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const run = repos.printRuns.getById(runId);
      if (!run) throw new NotFoundError(`Печать «${runId}»`);
      assertTransition("печать", PRINT_RUN_TRANSITIONS, run.state, outcome);
      const iso = this.nowIso();

      const saved = repos.printRuns.update({
        ...run,
        state: outcome,
        endedAt: metrics.endedAt ?? iso,
        durationS: metrics.durationS ?? run.durationS,
        filamentUsedG: metrics.filamentUsedG ?? run.filamentUsedG,
        progress: outcome === "SUCCEEDED" ? 1 : run.progress,
        updatedAt: iso
      });
      this.recordAudit({
        entityType: "print_run",
        entityId: run.id,
        action: "completed",
        from: run.state,
        to: outcome,
        actor
      });

      const taskTarget =
        outcome === "SUCCEEDED" ? "COMPLETED" : outcome === "FAILED" ? "FAILED" : "CANCELLED";
      const task = repos.tasks.getById(run.taskId);
      if (task && !isTaskTerminal(task.state)) {
        this.transitionTask(task, taskTarget, {}, "finished", actor);
      }

      const assignment = repos.assignments.getById(run.assignmentId);
      if (assignment && assignment.state === "ACTIVE") {
        this.transitionAssignment(assignment, "RELEASED", actor);
      }

      if (run.bedCycleId) {
        const bed = repos.bedCycles.getById(run.bedCycleId);
        if (bed && bed.state === "RUNNING") {
          this.transitionBed(bed, "AWAITING_CLEARANCE", actor);
        }
      }
      return saved;
    });
  }

  /**
   * Confirms the bed was cleared after a print: the printer's open cycle
   * `AWAITING_CLEARANCE → CLEAR` (with `clearedAt`). The gate that lets the
   * printer be reserved again — a new assignment cannot reuse the bed until this
   * happens.
   */
  clearBed(printerId: string, actor?: string): BedCycle {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const bed = repos.bedCycles.findOpenByPrinter(printerId.trim());
      if (!bed) throw new NotFoundError(`Активный цикл стола принтера «${printerId}»`);
      assertTransition("цикл стола", BED_CYCLE_TRANSITIONS, bed.state, "CLEAR");
      const saved = repos.bedCycles.update({
        ...bed,
        state: "CLEAR",
        clearedAt: this.nowIso(),
        updatedAt: this.nowIso()
      });
      this.recordAudit({
        entityType: "bed_cycle",
        entityId: bed.id,
        action: "cleared",
        from: bed.state,
        to: "CLEAR",
        actor
      });
      return saved;
    });
  }

  /**
   * Marks a printer's bed state unknown (sensor gap, restart mid-print, manual
   * intervention) — reachable from any live state and recoverable via
   * {@link clearBed} or a fresh reservation. Opens a fresh UNKNOWN cycle when the
   * printer had none.
   */
  markBedUnknown(printerId: string, reason?: string, actor?: string): BedCycle {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const printer = printerId.trim();
      const existing = repos.bedCycles.findOpenByPrinter(printer);
      const iso = this.nowIso();
      if (existing) {
        assertTransition("цикл стола", BED_CYCLE_TRANSITIONS, existing.state, "UNKNOWN");
        const saved = repos.bedCycles.update({ ...existing, state: "UNKNOWN", updatedAt: iso });
        this.recordAudit({
          entityType: "bed_cycle",
          entityId: existing.id,
          action: "unknown",
          from: existing.state,
          to: "UNKNOWN",
          actor,
          detail: reason ? { reason } : {}
        });
        return saved;
      }
      const bed: BedCycle = {
        id: newId(ID_PREFIX.bedCycle),
        printerId: printer,
        state: "UNKNOWN",
        assignmentId: null,
        createdAt: iso,
        updatedAt: iso,
        clearedAt: null,
        version: 1,
        metadata: reason ? { reason } : {}
      };
      repos.bedCycles.insert(bed);
      this.recordAudit({
        entityType: "bed_cycle",
        entityId: bed.id,
        action: "unknown",
        to: "UNKNOWN",
        actor,
        detail: reason ? { reason } : {}
      });
      return bed;
    });
  }

  // ── Internal transition helpers ──────────────────────────────────────────────

  private transitionTask(
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

  private transitionEntry(entry: QueueEntry, to: QueueEntry["state"], actor?: string): QueueEntry {
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

  private transitionAssignment(
    assignment: Assignment,
    to: Assignment["state"],
    actor?: string
  ): Assignment {
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

  private transitionBed(bed: BedCycle, to: BedCycle["state"], actor?: string): BedCycle {
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
  private unwindAssignment(assignment: Assignment, to: "CANCELLED" | "RELEASED", actor?: string): void {
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

  private holdEntryFor(taskId: string, actor?: string): void {
    const entry = this.store.repositories.queue.findByTaskId(taskId);
    if (entry && entry.state === "WAITING") {
      this.transitionEntry(entry, "HELD", actor);
    }
  }

  private getAssignment(id: string): Assignment {
    const assignment = this.store.repositories.assignments.getById(id);
    if (!assignment) throw new NotFoundError(`Назначение «${id}»`);
    return assignment;
  }

  /** Refuses a pin to a printer the farm does not know (when a config check is wired). */
  private assertPrinterConfigured(printerId: string): void {
    if (this.isPrinterConfigured && !this.isPrinterConfigured(printerId)) {
      throw new ValidationError(`Принтер «${printerId}» отсутствует в конфигурации фермы`);
    }
  }

  private nextPosition(): number {
    const max = this.store.repositories.queue.maxPosition();
    return (max ?? 0) + POSITION_STEP;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private recordAudit(input: {
    entityType: AuditEntityType;
    entityId: string;
    action: string;
    from?: string;
    to?: string;
    actor?: string;
    detail?: Metadata;
  }): void {
    this.store.repositories.audit.insert({
      id: newId(ID_PREFIX.auditEvent),
      at: this.nowIso(),
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      fromState: input.from ?? null,
      toState: input.to ?? null,
      actor: input.actor ?? this.defaultActor,
      detail: input.detail ?? {}
    });
  }
}

function isTaskTerminal(state: PrintTask["state"]): boolean {
  return state === "COMPLETED" || state === "FAILED" || state === "CANCELLED";
}

/**
 * Coerces an operator-supplied priority: absent/non-finite falls back, and a value
 * outside the allowed band is a `ValidationError` (400) rather than silently
 * clamped — an unbounded priority (e.g. `1e308`) would make the whole planning
 * score `Infinity` and swamp every other factor.
 */
function normalizePriority(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value < PRIORITY_MIN || value > PRIORITY_MAX) {
    throw new ValidationError(`Приоритет должен быть в диапазоне ${PRIORITY_MIN}…${PRIORITY_MAX}`);
  }
  return value;
}

/**
 * Rejects an impossible scheduling window: a `notBefore` at or after the `deadline`
 * is unsatisfiable, so it fails loudly at write time instead of surfacing only as a
 * warning buried in a later plan. Either side null (no bound) is always fine.
 */
function assertWindowOrder(notBefore: string | null, deadline: string | null): void {
  if (notBefore === null || deadline === null) return;
  const nb = Date.parse(notBefore);
  const dl = Date.parse(deadline);
  if (Number.isFinite(nb) && Number.isFinite(dl) && nb >= dl) {
    throw new ValidationError(
      `«notBefore» (${notBefore}) не может быть позже дедлайна (${deadline})`
    );
  }
}

/**
 * Normalises an optional ISO timestamp: `null`/empty clears it, a valid ISO
 * string is canonicalised, and anything unparseable is a `ValidationError` (so a
 * bad `notBefore`/`deadline` fails loudly instead of silently becoming null).
 */
function parseIsoOrNull(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) throw new ValidationError(`Поле «${field}» — некорректная дата: «${value}»`);
  return new Date(ms).toISOString();
}
