import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { newId, ID_PREFIX } from "../../domain/print/ids";
import { assertTransition, PRINT_TASK_TRANSITIONS } from "../../domain/print/states";
import type {
  Artifact,
  DayNightPreference,
  Metadata,
  PrintTask,
  QueueEntry
} from "../../domain/print/types";
import type { PrintTaskState } from "../../domain/print/types";
import { evaluateSliceOutput } from "../../domain/slicing/outputGate";
import { normalizeStartablePath } from "../../infra/printers/files";
import { isTaskTerminal, type PrintQueueContext } from "./context";
import type { QueueQueries, TaskDetail } from "./queueQueries";

/** Task states from which a finished slice may be handed off into the queue. */
const PROMOTABLE_TASK_STATES: ReadonlySet<PrintTaskState> = new Set([
  "DRAFT",
  "QUEUED",
  "PLANNED",
  "NEEDS_REVIEW"
]);

/** Allowed operator priority band. Beyond this a single job would dominate/break the score. */
const PRIORITY_MIN = -10;
const PRIORITY_MAX = 100;

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

/**
 * Task-lifecycle commands: authoring (create/add), the slice→print handoff
 * (promote), parking/releasing/cancelling, scheduling parameters and printer
 * pins. Every mutation is transactional, transition-checked and audited via
 * the shared {@link PrintQueueContext}.
 */
export class TaskCommands {
  constructor(
    private readonly ctx: PrintQueueContext,
    private readonly queries: QueueQueries
  ) {}

  private get store() {
    return this.ctx.store;
  }

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
    const iso = this.ctx.nowIso();

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
        this.ctx.recordAudit({ entityType: "artifact", entityId: artifact.id, action: "created", actor });
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
      this.ctx.recordAudit({
        entityType: "print_task",
        entityId: task.id,
        action: "created",
        to: task.state,
        actor
      });

      const entry: QueueEntry = {
        id: newId(ID_PREFIX.queueEntry),
        taskId: task.id,
        position: this.ctx.nextPosition(),
        state: runnable ? "WAITING" : "HELD",
        enqueuedAt: iso,
        updatedAt: iso,
        version: 1
      };
      repos.queue.insert(entry);
      this.ctx.recordAudit({
        entityType: "queue_entry",
        entityId: entry.id,
        action: "enqueued",
        to: entry.state,
        actor
      });

      return this.queries.getTaskDetail(task.id);
    });
  }

  /**
   * Parks a task for the operator: task → `NEEDS_REVIEW`, its queue entry → `HELD`,
   * so it stops being eligible to run without being removed. The successor to the
   * legacy "move to review".
   */
  holdTask(id: string, reason?: string, actor?: string): PrintTask {
    return this.store.transaction(() => {
      const task = this.queries.getTask(id);
      const trimmed = reason?.trim();
      const updated = this.ctx.transitionTask(
        task,
        "NEEDS_REVIEW",
        { reason: trimmed || task.reason || "отложено оператором на проверку" },
        "held",
        actor
      );
      this.ctx.holdEntryFor(id, actor);
      return updated;
    });
  }

  /** Returns a parked/failed task to the runnable queue: → `QUEUED`, entry → `WAITING`. */
  releaseTask(id: string, actor?: string): PrintTask {
    return this.store.transaction(() => {
      const task = this.queries.getTask(id);
      const updated = this.ctx.transitionTask(task, "QUEUED", { reason: null }, "released", actor);
      const entry = this.store.repositories.queue.findByTaskId(id);
      if (entry && entry.state === "HELD") {
        this.ctx.transitionEntry(entry, "WAITING", actor);
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
      const task = this.queries.getTask(id);
      const updated = this.ctx.transitionTask(
        task,
        "CANCELLED",
        { reason: reason?.trim() || task.reason },
        "cancelled",
        actor
      );

      const entry = repos.queue.findByTaskId(id);
      if (entry && entry.state !== "RELEASED") {
        this.ctx.transitionEntry(entry, "RELEASED", actor);
      }

      for (const assignment of repos.assignments.listByTask(id)) {
        if (assignment.state === "RELEASED" || assignment.state === "CANCELLED") continue;
        this.ctx.unwindAssignment(assignment, "CANCELLED", actor);
      }
      return updated;
    });
  }

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
    const iso = this.ctx.nowIso();
    const notBefore = parseIsoOrNull(input.notBefore, "notBefore");
    const deadline = parseIsoOrNull(input.deadline, "deadline");
    assertWindowOrder(notBefore, deadline);
    const priority = normalizePriority(input.priority, 0);
    const pinned = input.pinnedPrinterId?.trim() || null;
    if (pinned) this.ctx.assertPrinterConfigured(pinned);

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
      this.ctx.recordAudit({
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
        position: this.ctx.nextPosition(),
        state: "WAITING",
        enqueuedAt: iso,
        updatedAt: iso,
        version: 1
      };
      repos.queue.insert(entry);
      this.ctx.recordAudit({
        entityType: "queue_entry",
        entityId: entry.id,
        action: "enqueued",
        to: entry.state,
        actor
      });

      return this.queries.getTaskDetail(task.id);
    });
  }

  /**
   * The slice → print HANDOFF. Binds a `ready` slice variant's verified output onto
   * its source task so the task becomes an executable print job, then enqueues it.
   *
   * The gap this closes: a finished slice lived only on `SliceVariant.output*`; its
   * task stayed bound to the STL/3MF (analysis `needs_preparation`) with no on-device
   * file, so dispatching it hit `NO_FILE` or was blocked as an un-prepared model.
   * After promotion the task's executable artifact IS the sliced output (analysis
   * `schedulable`), `metadata.file` is the on-device path, and — for a printer-scoped
   * variant — the task is pinned to that printer. The dispatch gate then reads the
   * OUTPUT's clean analysis, so a start uses exactly the vetted ready variant and its
   * analysis, never the raw model.
   *
   * Fail-closed: the output must pass {@link evaluateSliceOutput} (completed,
   * `schedulable`, no blocker) or promotion is refused. The file is not pushed to the
   * printer here (no such transport exists) — its on-device identity is matched by
   * the dispatch pre-flight (name + size), which refuses if it is absent or different.
   */
  promoteSliceVariant(
    variantId: string,
    input: { onDeviceFile?: string | null } = {},
    actor?: string
  ): TaskDetail {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const who = actor ?? this.ctx.defaultActor;
      const iso = this.ctx.nowIso();

      const variant = repos.sliceVariants.getById(variantId);
      if (!variant) throw new NotFoundError(`Вариант слайсинга «${variantId}»`);
      if (variant.state !== "ready" || !variant.outputArtifactId) {
        throw new JobError(
          `Вариант «${variantId}» не готов к постановке в очередь (состояние «${variant.state}») — нужен ready-вариант с готовым файлом`
        );
      }

      const output = repos.artifacts.getById(variant.outputArtifactId);
      if (!output) throw new NotFoundError(`Выходной артефакт «${variant.outputArtifactId}»`);

      // The output must be a safe, verified, schedulable file — the same bar the
      // slice pipeline and the dispatch gate use. Never promote anything else.
      const analysis = variant.outputAnalysisId
        ? repos.artifactAnalyses.getById(variant.outputAnalysisId)
        : repos.artifactAnalyses.latestForArtifact(output.id);
      if (!analysis) throw new JobError("У выходного файла нет анализа — постановка в очередь запрещена");
      const gate = evaluateSliceOutput(analysis);
      if (!gate.ok) throw new JobError(`Нельзя поставить в очередь непроверенный файл: ${gate.reason}`);

      const task = repos.tasks.getById(variant.taskId);
      if (!task) throw new NotFoundError(`Задание «${variant.taskId}»`);
      if (!PROMOTABLE_TASK_STATES.has(task.state)) {
        throw new JobError(
          `Задание «${task.title}» в состоянии «${task.state}» — постановка слайса в очередь недоступна`
        );
      }

      // The on-device path a dispatch will start: an explicit override, else the
      // output file's own name — validated as a safe, startable path.
      const rawFile = input.onDeviceFile?.trim() || output.name;
      let onDeviceFile: string;
      try {
        onDeviceFile = normalizeStartablePath(rawFile);
      } catch {
        throw new ValidationError(`Недопустимый путь файла на устройстве: «${rawFile}»`);
      }

      // A printer-scoped variant pins its printer so the start goes to the exact
      // device the file was sliced for; a class-scoped one leaves placement open.
      const pinnedPrinterId = variant.targetPrinterId ?? task.pinnedPrinterId;
      if (pinnedPrinterId) this.ctx.assertPrinterConfigured(pinnedPrinterId);

      // ── Atomic bind: the task's executable becomes the sliced output ──────────
      if (task.state !== "QUEUED") {
        assertTransition("задание", PRINT_TASK_TRANSITIONS, task.state, "QUEUED");
      }
      const bound = repos.tasks.update({
        ...task,
        artifactId: output.id,
        state: "QUEUED",
        reason: null,
        targetPrinter: variant.targetPrinterId ?? task.targetPrinter,
        pinnedPrinterId,
        metadata: {
          ...task.metadata,
          file: onDeviceFile,
          sourceArtifactId: variant.sourceArtifactId,
          sliceVariantId: variant.id,
          outputAnalysisId: analysis.id
        },
        updatedAt: iso
      });
      this.ctx.recordAudit({
        entityType: "print_task",
        entityId: task.id,
        action: "slice_promoted",
        from: task.state,
        to: "QUEUED",
        actor: who,
        detail: { variantId: variant.id, outputArtifactId: output.id, file: onDeviceFile }
      });

      // Ensure a WAITING queue entry: create one for a task that had none (an
      // upload draft), un-hold a held one, and leave an already-waiting one be.
      const entry = repos.queue.findByTaskId(task.id);
      if (!entry) {
        const created: QueueEntry = {
          id: newId(ID_PREFIX.queueEntry),
          taskId: task.id,
          position: this.ctx.nextPosition(),
          state: "WAITING",
          enqueuedAt: iso,
          updatedAt: iso,
          version: 1
        };
        repos.queue.insert(created);
        this.ctx.recordAudit({ entityType: "queue_entry", entityId: created.id, action: "enqueued", to: "WAITING", actor: who });
      } else if (entry.state === "HELD") {
        this.ctx.transitionEntry(entry, "WAITING", who);
      }

      void bound;
      return this.queries.getTaskDetail(task.id);
    });
  }

  /**
   * Updates a task's scheduling parameters (priority, notBefore, deadline,
   * day/night preference, unattended permission, material). Refuses on a terminal
   * or in-flight task, and honours an optional optimistic `expectedVersion`.
   */
  setTaskScheduling(id: string, patch: TaskSchedulingPatch, actor?: string): PrintTask {
    return this.store.transaction(() => {
      const task = this.queries.getTask(id);
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
        updatedAt: this.ctx.nowIso()
      };
      const saved = this.store.repositories.tasks.update(next);
      this.ctx.recordAudit({
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
    this.ctx.assertPrinterConfigured(pinned);
    return this.store.transaction(() => {
      const task = this.queries.getTask(id);
      if (isTaskTerminal(task.state)) {
        throw new ValidationError(`Нельзя закрепить принтер для завершённого задания «${task.state}»`);
      }
      const saved = this.store.repositories.tasks.update({
        ...task,
        pinnedPrinterId: pinned,
        targetPrinter: pinned,
        updatedAt: this.ctx.nowIso()
      });
      this.ctx.recordAudit({
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
      const task = this.queries.getTask(id);
      if (task.pinnedPrinterId === null) return task;
      const saved = this.store.repositories.tasks.update({
        ...task,
        pinnedPrinterId: null,
        updatedAt: this.ctx.nowIso()
      });
      this.ctx.recordAudit({ entityType: "print_task", entityId: task.id, action: "unpinned", actor });
      return saved;
    });
  }
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
