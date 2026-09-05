import { JobError, NotFoundError } from "../../core/errors";
import type { Repositories } from "../../domain/print/repositories";
import type { Assignment, PrintTask, PrintTaskState } from "../../domain/print/types";
import type { SliceVariant } from "../../domain/slicing/types";
import { errorMessage, type ArtifactContext } from "./context";

/** A task in one of these states is history — nothing will read its file again. */
const TERMINAL_TASK_STATES: ReadonlySet<PrintTaskState> = new Set<PrintTaskState>([
  "COMPLETED",
  "FAILED",
  "CANCELLED"
]);

/**
 * Task states a cascading delete may cancel to free the file.
 *
 * The line is deliberately the one `FarmCommands.removeQueueJob` already draws
 * for «убрать строку из очереди», not a second policy invented here: up to and
 * including `ASSIGNED` the task is still *planning* — a placement is a
 * reservation, nothing has been sent anywhere — while `DISPATCHING` and
 * `PRINTING` mean bytes or a nozzle are already in motion. Those are stopped on
 * the printer, never by deleting the file out from under them.
 *
 * `DRAFT` is absent because it is not a hold in the first place: the upload
 * placeholder is cancelled with its artifact by every delete, cascading or not.
 */
const CASCADE_CANCELLABLE_TASK_STATES: ReadonlySet<PrintTaskState> = new Set<PrintTaskState>([
  "QUEUED",
  "PLANNED",
  "ASSIGNED",
  "NEEDS_REVIEW"
]);

/** An assignment in any other state has been released or cancelled — it holds nothing. */
const LIVE_ASSIGNMENT_STATES = new Set(["PROPOSED", "RESERVED", "ACTIVE"]);

/** A scheduler task holding a file, as named to the operator before a cascade. */
export interface HeldTask {
  id: string;
  title: string;
  state: PrintTaskState;
}

/** Why a file is held right now, and whether cancelling scheduler work would free it. */
export interface DeletionHold {
  /** The operator-facing reason, or null when the file may be deleted as is. */
  reason: string | null;
  /**
   * True when EVERY hold on the file is scheduler work a cascading delete is
   * allowed to cancel. False both for a free file and for one held by something
   * no cascade may override — so the dashboard never offers a cascade the
   * transaction is going to refuse.
   */
  cascadable: boolean;
  /** The tasks that cascade would cancel, in the order it would cancel them. */
  tasks: HeldTask[];
}

/** One reason a file is held, and what — if anything — would clear it. */
interface Hold {
  reason: string;
  /**
   * The task whose cancellation clears this hold, or null when nothing does.
   * A single null anywhere makes the whole file non-cascadable.
   */
  clearedByCancelling: PrintTask | null;
}

/**
 * Why an artifact must not be deleted right now, and what a cascade could do
 * about it.
 *
 * Free function rather than a method so the read side ({@link file://./queries.ts
 * ArtifactQueries}) can show the same answer the delete path enforces — the
 * dashboard must never offer a button the transaction is going to refuse.
 *
 * Fail-closed, and it walks the WHOLE reference graph, because more than one
 * table points at an artifact:
 *
 *   - `print_tasks.artifact_id` — the executable a task will print;
 *   - `print_tasks.source_artifact_id` — the model it was sliced from. Promoting
 *     a slice re-points `artifact_id` at the G-code and leaves the model only
 *     here, so checking `artifact_id` alone declared a live task's source model
 *     free to delete;
 *   - `assignments.artifact_id` / `.slice_variant_id` — a placement built on it;
 *   - `device_artifacts.artifact_id` — bytes being streamed to a printer;
 *   - `slice_variants.source_artifact_id` / `.output_artifact_id`.
 *
 * That last one is the sharp edge: `source_artifact_id` is `ON DELETE CASCADE`,
 * so deleting a model silently destroys every slice variant made from it. That
 * is acceptable for finished, unreferenced variants (the sliced G-code itself is
 * a separate artifact and survives), but never while a task or an assignment
 * still stands on one — hence {@link variantStillLoadBearing}.
 *
 * Every hold is classified as it is found: a *cascadable* hold names the task
 * whose cancellation removes it, a *hard* hold names something a cascade must
 * not touch (a live run, bytes on the wire, a slicer mid-job, a placement whose
 * task is already history and can no longer be cancelled).
 */
export function deletionHold(repos: Repositories, artifactId: string): DeletionHold {
  const artifact = repos.artifacts.getById(artifactId);
  if (!artifact) return { reason: "артефакт не найден", cascadable: false, tasks: [] };

  const holds = collectHolds(repos, artifactId);
  if (holds.length === 0) return { reason: null, cascadable: false, tasks: [] };

  // One unclearable hold decides the whole answer, wherever in the graph it sits:
  // reporting a cascadable reason while something physical is still running would
  // offer the operator a delete the re-check inside the transaction then refuses.
  const hard = holds.find((hold) => hold.clearedByCancelling === null);
  if (hard) return { reason: hard.reason, cascadable: false, tasks: [] };

  // The same task typically holds a file through several edges at once (its own
  // binding column and the slice variant behind it). Cancel it once.
  const tasks = new Map<string, HeldTask>();
  for (const hold of holds) {
    const task = hold.clearedByCancelling as PrintTask;
    if (!tasks.has(task.id)) tasks.set(task.id, { id: task.id, title: task.title, state: task.state });
  }
  return { reason: holds[0].reason, cascadable: true, tasks: [...tasks.values()] };
}

/**
 * The reason string alone — the shape the dashboard read model and the refusal
 * message have always used. @see {@link deletionHold}
 */
export function deletionBlocker(repos: Repositories, artifactId: string): string | null {
  return deletionHold(repos, artifactId).reason;
}

/**
 * Every hold on the file, in the order the graph is walked (the first is the one
 * reported when they are all cascadable, so the message stays the one operators
 * have been reading: the task, before the machinery behind it).
 */
function collectHolds(repos: Repositories, artifactId: string): Hold[] {
  const holds: Hold[] = [];

  // Tasks naming the file in EITHER binding column. The upload's own DRAFT is
  // not a blocker: it is cancelled together with its artifact.
  for (const task of repos.tasks.listReferencingArtifact(artifactId)) {
    if (!TERMINAL_TASK_STATES.has(task.state) && task.state !== "DRAFT") {
      holds.push({
        reason: `задание «${task.title}» в состоянии ${task.state} использует файл`,
        clearedByCancelling: cancellable(task)
      });
    }
    const activeRun = repos.printRuns.findActiveByTask(task.id);
    if (activeRun) {
      // A print in progress is a physical process. It ends on the printer.
      holds.push({
        reason: `активная печать ${activeRun.id} (${activeRun.state}) использует файл`,
        clearedByCancelling: null
      });
    }
  }

  const latest = repos.artifactAnalyses.latestForArtifact(artifactId);
  if (latest && (latest.state === "pending" || latest.state === "running")) {
    holds.push({ reason: "анализ артефакта ещё выполняется", clearedByCancelling: null });
  }

  // A live placement pinned to this exact file. Cancelling its task unwinds it
  // (bed and interventions included); a placement whose task is already terminal
  // has no such lever, so it holds the file outright.
  for (const assignment of repos.assignments.listReferencingArtifact(artifactId)) {
    if (LIVE_ASSIGNMENT_STATES.has(assignment.state)) {
      holds.push({
        reason: `назначение ${assignment.id} на «${assignment.printerId}» (${assignment.state}) использует файл`,
        clearedByCancelling: cancellableOwner(repos, assignment)
      });
    }
  }

  // Bytes are being read out of the blob right now. Later device states are not
  // blockers: the file already lives on the printer and no longer needs ours —
  // and a live placement around it is caught by the assignment check above.
  for (const device of repos.deviceArtifacts.listByArtifact(artifactId)) {
    if (device.state === "UPLOADING") {
      holds.push({
        reason: `файл сейчас загружается на принтер «${device.printerId}» (${device.remotePath})`,
        clearedByCancelling: null
      });
    }
  }

  for (const variant of repos.sliceVariants.listReferencingArtifact(artifactId)) {
    if (variant.state === "pending" || variant.state === "running") {
      // The slicer is reading this file in another process; cancelling the task
      // does not stop it. Nothing here may take the bytes away.
      holds.push({
        reason: `slice-вариант ${variant.id} (${variant.state}) использует файл`,
        clearedByCancelling: null
      });
      continue;
    }
    // Deleting the source cascades this variant away — refuse while it carries weight.
    if (variant.sourceArtifactId === artifactId) {
      const holder = variantStillLoadBearing(repos, variant);
      if (holder) holds.push(holder);
    }
  }
  return holds;
}

/** The task itself when a cascade is allowed to cancel it, else null. */
function cancellable(task: PrintTask): PrintTask | null {
  return CASCADE_CANCELLABLE_TASK_STATES.has(task.state) ? task : null;
}

/** The task whose cancellation would unwind `assignment`, when it may be cancelled. */
function cancellableOwner(repos: Repositories, assignment: Assignment): PrintTask | null {
  const task = repos.tasks.getById(assignment.taskId);
  return task ? cancellable(task) : null;
}

/**
 * Whether anything would be left pointing at nothing if `variant` disappeared.
 * `print_tasks.slice_variant_id` and `assignments.slice_variant_id` are plain
 * columns (no foreign key), so the database would not stop such a deletion — it
 * would simply leave a dangling id behind. History may keep its ids; live work
 * may not lose its variant.
 */
function variantStillLoadBearing(repos: Repositories, variant: SliceVariant): Hold | null {
  const task = repos.tasks.getById(variant.taskId);
  if (task && task.sliceVariantId === variant.id && !TERMINAL_TASK_STATES.has(task.state)) {
    return {
      reason: `задание «${task.title}» (${task.state}) собрано из этой модели вариантом ${variant.id}`,
      clearedByCancelling: cancellable(task)
    };
  }
  for (const assignment of repos.assignments.listBySliceVariant(variant.id)) {
    if (LIVE_ASSIGNMENT_STATES.has(assignment.state)) {
      return {
        reason: `назначение ${assignment.id} на «${assignment.printerId}» (${assignment.state}) собрано из этой модели вариантом ${variant.id}`,
        clearedByCancelling: cancellableOwner(repos, assignment)
      };
    }
  }
  return null;
}

/** What one deletion actually did — reported to the operator and to the audit log. */
export interface ArtifactDeletion {
  artifactId: string;
  /** The blob's storage key, or null for a legacy name-only artifact. */
  blobKey: string | null;
  /** False when the blob stays: shared with another artifact, or the unlink failed. */
  blobRemoved: boolean;
  /** Slice variants removed with the source model (their G-code outputs survive). */
  removedSliceVariants: string[];
  /**
   * Scheduler tasks cancelled to free the file — only ever non-empty for a
   * cascading delete, and never containing the upload's own DRAFT placeholder
   * (that one is cancelled by every delete and is not a hold to begin with).
   */
  cancelledTasks: string[];
}

/**
 * Retention / safe deletion of artifacts. Fail-closed: anything still referenced
 * by live work is protected, and the blob is unlinked only AFTER the database
 * commit — and only when no other artifact shares it (dedup refcount).
 */
export class ArtifactRetention {
  constructor(private readonly ctx: ArtifactContext) {}

  /** @see {@link deletionBlocker} — the module-level rule this delegates to. */
  deletionBlocker(artifactId: string): string | null {
    return deletionBlocker(this.ctx.store.repositories, artifactId);
  }

  /** @see {@link deletionHold} — the structured answer behind the blocker string. */
  deletionHold(artifactId: string): DeletionHold {
    return deletionHold(this.ctx.store.repositories, artifactId);
  }

  /**
   * Deletes one artifact safely.
   *
   * In ONE transaction: the safety check re-runs (so an artifact that became
   * live between the operator's click and this call is refused, not deleted),
   * the DRAFT upload task is cancelled, every slice variant built FROM this
   * model is removed explicitly — auditing each one instead of letting the
   * `ON DELETE CASCADE` erase them invisibly — and the artifact row goes
   * (analyses cascade, task references null out).
   *
   * With `cascade`, the scheduler work holding the file is cancelled first, so
   * «удалить файл» does not dead-end on «его использует задание» with no way to
   * remove that task. The cascade is OPT-IN, and deliberately not the default:
   * `deleteArtifact` is also what the unattended retention sweep calls, and a
   * sweep must never be able to cancel a queued print. What it may cancel is
   * {@link CASCADE_CANCELLABLE_TASK_STATES} — planning states only; a live run,
   * a dispatch in flight, a slicer mid-job or a placement whose task is already
   * history still refuse, cascade or not, and refuse BEFORE anything is
   * cancelled ({@link DeletionHold.cascadable}), so a rejected delete leaves the
   * queue exactly as it found it.
   *
   * Cancellation goes through the queue's own `cancelTask` — the same use case
   * the operator's «убрать из очереди» calls — so the queue entry is released,
   * open assignments are unwound, a reserved bed goes back to `CLEAR` and a
   * running one to `AWAITING_CLEARANCE`. Nothing about that lifecycle is
   * re-implemented here. Both run in this transaction (the store joins nested
   * calls to the outer one), so a refusal later in the delete rolls the
   * cancellations back with it.
   *
   * Only AFTER the commit is the blob unlinked, and only when no other artifact
   * shares it. That whole step runs under the per-key blob lock, so an upload
   * deduplicating onto the same bytes cannot have them pulled out from under it.
   * A failed unlink leaves an orphan blob (the DB stays truthful, never the
   * reverse); the orphan sweep reclaims it later.
   */
  async deleteArtifact(
    artifactId: string,
    options: { actor?: string; cascade?: boolean } = {}
  ): Promise<ArtifactDeletion> {
    const actor = options.actor ?? this.ctx.defaultActor;
    const committed = this.ctx.store.transaction(() => {
      const repos = this.ctx.store.repositories;
      const artifact = repos.artifacts.getById(artifactId);
      if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);

      const cancelledTasks: string[] = [];
      if (options.cascade) {
        const hold = deletionHold(repos, artifactId);
        // Refuse on an uncascadable hold HERE, before a single task is touched:
        // falling through to the blocker check below would have cancelled the
        // clearable half of the queue first and only then discovered that the
        // file was never going to be deletable.
        if (hold.reason && !hold.cascadable) {
          throw new JobError(`Файл «${artifact.name}» нельзя удалить: ${hold.reason}`, {
            artifactId,
            blocker: hold.reason
          });
        }
        for (const held of hold.tasks) {
          this.ctx.cancelTask(held.id, `файл «${artifact.name}» удалён`, actor);
          cancelledTasks.push(held.id);
        }
      }

      // Re-run unconditionally, cascade or not: it is the single gate every
      // deletion passes, and after a cascade it proves the cancellations
      // actually freed the file rather than assuming they did.
      const blocker = deletionBlocker(repos, artifactId);
      if (blocker) {
        // 409, not 400: the request is perfectly well formed — the FILE is in a
        // state that forbids the action, exactly like every other "your view was
        // stale, refresh and look again" refusal in this taxonomy. A 400 would
        // tell the dashboard the call itself was wrong and must not be retried.
        throw new JobError(`Файл «${artifact.name}» нельзя удалить: ${blocker}`, {
          artifactId,
          blocker
        });
      }

      // Cancel the upload placeholder DRAFT together with its artifact.
      for (const task of repos.tasks.listReferencingArtifact(artifactId)) {
        if (task.state === "DRAFT") {
          this.ctx.transitionTask(task, "CANCELLED", "артефакт удалён", "cancelled", actor);
        }
      }

      // The FK cascade made explicit and auditable. Only variants whose SOURCE
      // this is: a variant that merely names it as output keeps its row, with
      // `output_artifact_id` nulled by the schema.
      const removedSliceVariants: string[] = [];
      for (const variant of repos.sliceVariants.listReferencingArtifact(artifactId)) {
        if (variant.sourceArtifactId !== artifactId) continue;
        repos.sliceVariants.delete(variant.id);
        removedSliceVariants.push(variant.id);
        this.ctx.recordAudit({
          entityType: "slice_variant",
          entityId: variant.id,
          action: "deleted",
          from: variant.state,
          actor,
          detail: {
            reason: "исходная модель удалена",
            sourceArtifactId: artifactId,
            // The sliced G-code is its own artifact and is NOT deleted here.
            outputArtifactId: variant.outputArtifactId
          }
        });
      }

      repos.artifacts.delete(artifactId);
      this.ctx.recordAudit({
        entityType: "artifact",
        entityId: artifactId,
        action: "deleted",
        actor,
        detail: {
          name: artifact.name,
          sizeBytes: artifact.sizeBytes,
          removedSliceVariants: removedSliceVariants.length,
          // Named, not just counted: the artifact's audit trail is where an
          // operator asks «почему задание отменилось», and the answer has to
          // point at the tasks rather than at a number.
          cancelledTasks
        }
      });
      return {
        // A content-addressed blob key (legacy name-only artifacts have no blob).
        key: artifact.sha256 && artifact.source ? artifact.source : null,
        removedSliceVariants,
        cancelledTasks
      };
    });

    const base = {
      artifactId,
      removedSliceVariants: committed.removedSliceVariants,
      cancelledTasks: committed.cancelledTasks
    };
    const key = committed.key;
    if (!key) return { ...base, blobKey: null, blobRemoved: false };

    return this.ctx.withBlobLock(key, async () => {
      if (this.ctx.store.repositories.artifacts.countBySource(key) > 0) {
        // Deduplicated content is still referenced by another artifact — keep it.
        return { ...base, blobKey: key, blobRemoved: false };
      }
      try {
        await this.ctx.storage.remove(key);
        return { ...base, blobKey: key, blobRemoved: true };
      } catch (error) {
        this.ctx.logger.error?.({ err: error, key }, "blob unlink failed — left as orphan for the sweep");
        return { ...base, blobKey: key, blobRemoved: false };
      }
    });
  }

  /**
   * Retention sweep: deletes artifacts that are provably unused — every
   * referencing task terminal (or none), analyses finished, no live slice
   * variant — and older than the cutoff. Conservative by design: DRAFT uploads
   * are NOT reclaimed automatically (an operator may still be deciding); use
   * the explicit delete for those. `dryRun` reports without touching anything;
   * `maxDelete` bounds one sweep. Skip reasons are reported per artifact.
   */
  async retentionSweep(options: {
    olderThanDays: number;
    dryRun?: boolean;
    maxDelete?: number;
    actor?: string;
  }): Promise<{
    scanned: number;
    deleted: string[];
    skipped: { id: string; reason: string }[];
    dryRun: boolean;
  }> {
    const cutoffMs = Date.now() - options.olderThanDays * 24 * 3600 * 1000;
    const limit = options.maxDelete ?? 50;
    const repos = this.ctx.store.repositories;
    const deleted: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const artifacts = repos.artifacts.list();

    for (const artifact of artifacts) {
      if (deleted.length >= limit) {
        skipped.push({ id: artifact.id, reason: "лимит одной очистки исчерпан" });
        continue;
      }
      if (Date.parse(artifact.createdAt) > cutoffMs) {
        skipped.push({ id: artifact.id, reason: "моложе порога retention" });
        continue;
      }
      const tasks = repos.tasks.listReferencingArtifact(artifact.id);
      if (tasks.some((t) => t.state === "DRAFT")) {
        skipped.push({ id: artifact.id, reason: "черновик загрузки — только ручное удаление" });
        continue;
      }
      const blocker = deletionBlocker(repos, artifact.id);
      if (blocker) {
        skipped.push({ id: artifact.id, reason: blocker });
        continue;
      }
      if (options.dryRun) {
        deleted.push(artifact.id);
        continue;
      }
      try {
        await this.deleteArtifact(artifact.id, { actor: options.actor ?? "retention" });
        deleted.push(artifact.id);
      } catch (error) {
        skipped.push({ id: artifact.id, reason: errorMessage(error) });
      }
    }

    this.ctx.logger.info?.(
      { scanned: artifacts.length, deleted: deleted.length, skipped: skipped.length, dryRun: options.dryRun === true },
      "artifact retention sweep"
    );
    return { scanned: artifacts.length, deleted, skipped, dryRun: options.dryRun === true };
  }

  /**
   * Orphan reconciliation, both directions:
   *  - blobs on disk with no DB reference (crashed delete, failed unlink) are
   *    removed (bounded per sweep);
   *  - DB artifacts whose blob is missing on disk are reported (never silently
   *    deleted — the operator decides; their analyses are already suspect).
   *
   * The refcount check and the unlink happen together under the per-key blob
   * lock, so an upload landing on the same content mid-sweep is never robbed of
   * its bytes.
   */
  async orphanSweep(options: { dryRun?: boolean; maxDelete?: number } = {}): Promise<{
    orphanBlobsRemoved: string[];
    artifactsMissingBlob: string[];
    dryRun: boolean;
  }> {
    const repos = this.ctx.store.repositories;
    const limit = options.maxDelete ?? 100;
    const keys = await this.ctx.storage.listKeys();
    const orphanBlobsRemoved: string[] = [];
    for (const key of keys) {
      if (orphanBlobsRemoved.length >= limit) break;
      const removed = await this.ctx.withBlobLock(key, async () => {
        if (repos.artifacts.countBySource(key) > 0) return false;
        if (options.dryRun) return true;
        try {
          await this.ctx.storage.remove(key);
          return true;
        } catch (error) {
          this.ctx.logger.error?.({ err: error, key }, "orphan blob removal failed");
          return false;
        }
      });
      if (removed) orphanBlobsRemoved.push(key);
    }

    const artifactsMissingBlob: string[] = [];
    for (const artifact of repos.artifacts.list()) {
      if (!artifact.sha256 || !artifact.source) continue; // name-only artifacts have no blob
      if (!(await this.ctx.storage.exists(artifact.source))) {
        artifactsMissingBlob.push(artifact.id);
      }
    }

    this.ctx.logger.info?.(
      {
        orphanBlobs: orphanBlobsRemoved.length,
        missingBlobs: artifactsMissingBlob.length,
        dryRun: options.dryRun === true
      },
      "artifact orphan sweep"
    );
    return { orphanBlobsRemoved, artifactsMissingBlob, dryRun: options.dryRun === true };
  }
}
