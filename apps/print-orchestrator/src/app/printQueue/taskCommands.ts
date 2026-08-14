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
import { buildDeviceFileName, normalizeStartablePath } from "../../infra/printers/files";
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
        sliceVariantId: null,
        sourceArtifactId: null,
        onDeviceFile: file,
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
      this.ctx.invalidatePlacementsFor(id, "задание отложено на проверку", actor);
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
        sliceVariantId: null,
        sourceArtifactId: null,
        onDeviceFile: null,
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
   * printer here — that is a separate, explicit step (`DeviceArtifactService.prepare`)
   * whose result the dispatch pre-flight verifies before any start command.
   *
   * **Idempotent**: promoting the same variant twice does not create a second queue
   * entry, a second task or a duplicate binding — the second call re-reads the same
   * task, sees the binding already matches, and returns it unchanged. Promoting a
   * *different* variant onto a task that already holds a live assignment or run is
   * refused rather than silently re-pointed.
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

      // Re-pointing a task that is already bound to a *different* variant would
      // invalidate any assignment/plan built on the old one behind the operator's
      // back. Refuse while anything live still references it; the operator cancels
      // the assignment (or the task) first.
      if (task.sliceVariantId !== null && task.sliceVariantId !== variant.id) {
        const live = repos.assignments
          .listByTask(task.id)
          .find((a) => a.state !== "CANCELLED" && a.state !== "RELEASED");
        if (live) {
          throw new JobError(
            `Задание «${task.title}» уже назначено по варианту «${task.sliceVariantId}» (назначение ${live.id}) — снимите назначение перед сменой варианта`
          );
        }
      }

      // The on-device path a dispatch will start.
      //
      // The *name* is always generated from the output artifact (sanitized stem +
      // content hash), never taken verbatim: two tasks whose models share a name
      // would otherwise share one device slot, and preparing the second would
      // overwrite the first one's bytes while both records still read VERIFIED.
      // An operator override may choose the directory (and influence the stem),
      // but not defeat the content suffix.
      // The *extension* is the target device's container, not the artifact's: the
      // same sliced G-code is `x.gcode` on Klipper and an `x.gcode.3mf` plate
      // package on a Bambu, because that is what each firmware starts. Resolving
      // the printer here (rather than at prepare time) keeps the recorded path,
      // the uploaded file and the start command naming one and the same thing.
      const rawFile = input.onDeviceFile?.trim() || output.name;
      const targetPrinter =
        (variant.targetPrinterId ?? task.pinnedPrinterId) !== null
          ? this.ctx.resolvePrinter((variant.targetPrinterId ?? task.pinnedPrinterId) as string)
          : undefined;
      let onDeviceFile: string;
      try {
        const slash = rawFile.replace(/\\/g, "/").lastIndexOf("/");
        const dir = slash === -1 ? "" : rawFile.slice(0, slash);
        const name = buildDeviceFileName({ name: rawFile, sha256: output.sha256 }, targetPrinter);
        onDeviceFile = normalizeStartablePath(dir ? `${dir}/${name}` : name, targetPrinter);
      } catch (error) {
        if (error instanceof ValidationError) throw error;
        throw new ValidationError(`Недопустимый путь файла на устройстве: «${rawFile}»`);
      }

      // A printer-scoped variant pins its printer so the start goes to the exact
      // device the file was sliced for; a class-scoped one leaves placement open.
      const pinnedPrinterId = variant.targetPrinterId ?? task.pinnedPrinterId;
      if (pinnedPrinterId) this.ctx.assertPrinterConfigured(pinnedPrinterId);

      // Idempotency: an identical repeat is a no-op. Everything below is a write,
      // so bail out *before* it rather than re-auditing and re-versioning the row.
      const alreadyBound =
        task.state === "QUEUED" &&
        task.sliceVariantId === variant.id &&
        task.artifactId === output.id &&
        task.onDeviceFile === onDeviceFile;
      const existingEntry = repos.queue.findByTaskId(task.id);
      if (alreadyBound && existingEntry?.state === "WAITING") {
        return this.queries.getTaskDetail(task.id);
      }

      // ── Atomic bind: the task's executable becomes the sliced output ──────────
      if (task.state !== "QUEUED") {
        assertTransition("задание", PRINT_TASK_TRANSITIONS, task.state, "QUEUED");
      }
      repos.tasks.update({
        ...task,
        // Typed binding (migration 009): the queue now references the exact slice,
        // its source model and the on-device path — not a free-form metadata blob.
        artifactId: output.id,
        sliceVariantId: variant.id,
        sourceArtifactId: variant.sourceArtifactId,
        onDeviceFile,
        state: "QUEUED",
        reason: null,
        targetPrinter: variant.targetPrinterId ?? task.targetPrinter,
        pinnedPrinterId,
        metadata: {
          ...task.metadata,
          // Kept for the legacy queue projection, which still reads metadata.file.
          file: onDeviceFile,
          outputAnalysisId: analysis.id
        },
        updatedAt: iso
      });
      if (task.sliceVariantId !== null && task.sliceVariantId !== variant.id) {
        this.ctx.invalidatePlacementsFor(task.id, "задание пересобрано другим вариантом слайсинга", who);
      }
      this.ctx.recordAudit({
        entityType: "print_task",
        entityId: task.id,
        action: "slice_promoted",
        from: task.state,
        to: "QUEUED",
        actor: who,
        detail: {
          variantId: variant.id,
          outputArtifactId: output.id,
          outputSha256: output.sha256,
          profileSetId: variant.profileSetId,
          file: onDeviceFile
        }
      });

      // Ensure a WAITING queue entry: create one for a task that had none (an
      // upload draft), un-hold a held one, and leave an already-waiting one be.
      const entry = existingEntry;
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
      } else if (entry.state === "RELEASED") {
        throw new JobError(
          `Задание «${task.title}» уже покинуло очередь (запись ${entry.id} RELEASED) — создайте новое задание`
        );
      }

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
      // Priority/deadline/window are exactly what the placement was computed from.
      this.ctx.invalidatePlacementsFor(task.id, "изменены параметры планирования", actor);
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
