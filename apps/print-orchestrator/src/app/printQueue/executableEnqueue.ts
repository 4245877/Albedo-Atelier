import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { evaluateExecutableArtifact, type ExecutableKind } from "../../domain/print/executable";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import { assertTransition, PRINT_TASK_TRANSITIONS } from "../../domain/print/states";
import type { Artifact, PrintTask, PrintTaskState, QueueEntry } from "../../domain/print/types";
import { buildDeviceFileName, normalizeStartablePath } from "../../infra/printers/files";
import type { PrintQueueContext } from "./context";
import type { QueueQueries, TaskDetail } from "./queueQueries";

/**
 * **Queueing a file that is already printable.**
 *
 * The counterpart to `TaskCommands.promoteSliceVariant`, for the half of the
 * intake that has no slice variant to be promoted from: an uploaded `.gcode` or
 * a sliced `.gcode.3mf`. Both arrive as an `Artifact` plus a `DRAFT` task and
 * both used to stop there — the interface accepted them, analysed them, showed
 * them green, and offered no action that could reach a printer. STL and 3MF got
 * to the queue through the slicer; these two had no route at all.
 *
 * It is a *separate* use case rather than a branch of `releaseTask` on purpose.
 * `releaseTask` moves a task to `QUEUED` and un-holds an existing queue entry —
 * but a draft has no entry, so releasing one produced a `QUEUED` task with
 * nothing in the queue: invisible to the scheduler, unreachable by the launch,
 * and indistinguishable from a real queue row in every listing that reads task
 * state. Creating the entry is not an optional extra here, it is the operation.
 *
 * What it guarantees:
 *
 *  1. the analysis finished, and the file is genuinely executable (content, not
 *     extension — see {@link evaluateExecutableArtifact});
 *  2. a `review` verdict has been read and accepted by a named operator against
 *     these exact bytes, or the enqueue is refused with that as the next step;
 *  3. the executable artifact is bound to the task (`artifactId`, `onDeviceFile`)
 *     using the *same* name-building logic every other delivery path uses, so the
 *     device slot is content-addressed and two same-named uploads cannot collide;
 *  4. `DRAFT → QUEUED` and the `QueueEntry` land in **one** transaction;
 *  5. it is audited;
 *  6. it is idempotent — a second call on an already-queued task returns it
 *     unchanged rather than minting a second entry.
 */
export class ExecutableEnqueue {
  constructor(
    private readonly ctx: PrintQueueContext,
    private readonly queries: QueueQueries
  ) {}

  /**
   * Puts an already-executable task into the queue.
   *
   * `taskId` names the draft the upload created. The artifact is the task's own
   * (`artifactId`), never one passed in: allowing a caller to name the bytes
   * would be a second way to bind an executable to a task, and the identity
   * checks downstream all assume there is exactly one.
   */
  enqueue(
    taskId: string,
    input: { onDeviceFile?: string | null; material?: string | null } = {},
    actor?: string
  ): TaskDetail {
    return this.ctx.store.transaction(() => {
      const repos = this.ctx.store.repositories;
      const who = actor ?? this.ctx.defaultActor;
      const iso = this.ctx.nowIso();

      const task = this.queries.getTask(taskId);
      if (!ENQUEUEABLE_STATES.has(task.state)) {
        throw new JobError(
          `Задание «${task.title}» в состоянии «${task.state}» — постановка в очередь недоступна`,
          { taskId: task.id, taskState: task.state }
        );
      }

      const artifact = this.requireArtifact(task);
      const analysis = repos.artifactAnalyses.latestForArtifact(artifact.id);
      const admission = evaluateExecutableArtifact(artifact, analysis);
      if (!admission.ok) {
        throw new JobError(`Нельзя поставить «${artifact.name}» в очередь: ${admission.reason}`, {
          taskId: task.id,
          artifactId: artifact.id,
          code: admission.code,
          // The one thing the card needs in order to offer a next step rather
          // than a dead end: is a human reading the review all that is missing?
          needsReview: admission.needsReview
        });
      }

      const onDeviceFile = this.deviceFileFor(task, artifact, input.onDeviceFile);

      // ── Idempotency: bail out BEFORE any write, so a repeat neither re-audits
      //    nor bumps the row version.
      const existingEntry = repos.queue.findByTaskId(task.id);
      const alreadyQueued =
        task.state === "QUEUED" &&
        task.artifactId === artifact.id &&
        task.onDeviceFile === onDeviceFile &&
        existingEntry?.state === "WAITING";
      if (alreadyQueued) return this.queries.getTaskDetail(task.id);

      if (task.state !== "QUEUED") {
        assertTransition("задание", PRINT_TASK_TRANSITIONS, task.state, "QUEUED");
      }

      const material = input.material?.trim() || task.material || analysis?.material || null;
      repos.tasks.update({
        ...task,
        // The uploaded file IS both the source and the executable: nothing was
        // sliced, so `sliceVariantId` stays null and `sourceArtifactId` keeps
        // pointing at the same bytes the upload registered.
        artifactId: artifact.id,
        sliceVariantId: null,
        sourceArtifactId: task.sourceArtifactId ?? artifact.id,
        onDeviceFile,
        state: "QUEUED",
        reason: null,
        material,
        metadata: {
          ...task.metadata,
          // Read by the legacy queue projection and by `resolveDispatchFile`.
          file: onDeviceFile,
          executableKind: admission.kind satisfies ExecutableKind,
          ...(analysis ? { analysisId: analysis.id } : {})
        },
        updatedAt: iso
      });
      this.ctx.recordAudit({
        entityType: "print_task",
        entityId: task.id,
        action: "executable_enqueued",
        from: task.state,
        to: "QUEUED",
        actor: who,
        detail: {
          artifactId: artifact.id,
          sha256: artifact.sha256,
          kind: admission.kind,
          file: onDeviceFile,
          verdict: analysis?.verdict ?? null,
          ...(admission.acknowledgedBy ? { reviewAcceptedBy: admission.acknowledgedBy } : {})
        }
      });

      this.ensureWaitingEntry(task.id, task.title, existingEntry, who, iso);
      return this.queries.getTaskDetail(task.id);
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private requireArtifact(task: PrintTask): Artifact {
    if (!task.artifactId) {
      throw new JobError(
        `У задания «${task.title}» нет файла — загрузите файл заново`,
        { taskId: task.id }
      );
    }
    const artifact = this.ctx.store.repositories.artifacts.getById(task.artifactId);
    if (!artifact) throw new NotFoundError(`Артефакт «${task.artifactId}»`);
    return artifact;
  }

  /**
   * The path this file will occupy on a device — built by the *shared*
   * `buildDeviceFileName`, exactly as promotion does.
   *
   * The name always carries the content hash (`<stem>-<sha8><ext>`), so two
   * uploads that happen to share a file name can never share one device slot.
   * With no printer pinned yet the artifact's own extension is preserved, and the
   * launch re-derives the name for whichever printer is actually chosen (see
   * `PrintQueueService.retargetDeviceFile`) — a bare `.gcode` becomes a
   * `.gcode.3mf` plate package name on a Bambu, because that is the container
   * that firmware starts.
   */
  private deviceFileFor(
    task: PrintTask,
    artifact: Artifact,
    override: string | null | undefined
  ): string {
    const pinned = task.pinnedPrinterId ?? task.targetPrinter;
    const printer = pinned ? this.ctx.resolvePrinter(pinned) : undefined;
    const raw = override?.trim() || artifact.name;
    try {
      const slash = raw.replace(/\\/g, "/").lastIndexOf("/");
      const dir = slash === -1 ? "" : raw.slice(0, slash);
      const name = buildDeviceFileName({ name: raw, sha256: artifact.sha256 }, printer);
      // With no printer pinned the startability scope is `"any"`, not the Klipper
      // default: what may be started is a property of the *target* adapter, and
      // there is no target yet. The narrow default refuses the very `.gcode.3mf`
      // a Bambu starts — «не похож на файл печати» about a finished plate
      // package — while the launch re-validates against the real printer anyway.
      return normalizeStartablePath(dir ? `${dir}/${name}` : name, printer ?? "any");
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError(`Недопустимый путь файла на устройстве: «${raw}»`);
    }
  }

  /** A `WAITING` entry for the task: created, un-held, or already right. */
  private ensureWaitingEntry(
    taskId: string,
    title: string,
    existing: QueueEntry | null,
    actor: string,
    iso: string
  ): void {
    const repos = this.ctx.store.repositories;
    if (!existing) {
      const entry: QueueEntry = {
        id: newId(ID_PREFIX.queueEntry),
        taskId,
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
        to: "WAITING",
        actor
      });
      return;
    }
    if (existing.state === "HELD") {
      this.ctx.transitionEntry(existing, "WAITING", actor);
      return;
    }
    if (existing.state === "RELEASED") {
      throw new JobError(
        `Задание «${title}» уже покинуло очередь (запись ${existing.id} RELEASED) — загрузите файл заново`
      );
    }
  }
}

/**
 * States an executable may be queued from.
 *
 * `DRAFT` is the upload's own state and the case this exists for. The other two
 * are re-entry: a task parked for review, or one already queued (the idempotent
 * repeat). Anything in flight or finished is refused — re-binding an executable
 * under a running print is not a queue operation.
 */
const ENQUEUEABLE_STATES: ReadonlySet<PrintTaskState> = new Set([
  "DRAFT",
  "NEEDS_REVIEW",
  "QUEUED"
]);
