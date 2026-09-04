import { JobError, NotFoundError } from "../../core/errors";
import type { Repositories } from "../../domain/print/repositories";
import type { PrintTaskState } from "../../domain/print/types";
import type { SliceVariant } from "../../domain/slicing/types";
import { errorMessage, type ArtifactContext } from "./context";

/** A task in one of these states is history — nothing will read its file again. */
const TERMINAL_TASK_STATES: ReadonlySet<PrintTaskState> = new Set<PrintTaskState>([
  "COMPLETED",
  "FAILED",
  "CANCELLED"
]);

/** An assignment in any other state has been released or cancelled — it holds nothing. */
const LIVE_ASSIGNMENT_STATES = new Set(["PROPOSED", "RESERVED", "ACTIVE"]);

/**
 * Why an artifact must not be deleted right now, or null when it is safe.
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
 */
export function deletionBlocker(repos: Repositories, artifactId: string): string | null {
  const artifact = repos.artifacts.getById(artifactId);
  if (!artifact) return "артефакт не найден";

  // Tasks naming the file in EITHER binding column. The upload's own DRAFT is
  // not a blocker: it is cancelled together with its artifact.
  for (const task of repos.tasks.listReferencingArtifact(artifactId)) {
    if (!TERMINAL_TASK_STATES.has(task.state) && task.state !== "DRAFT") {
      return `задание «${task.title}» в состоянии ${task.state} использует файл`;
    }
    const activeRun = repos.printRuns.findActiveByTask(task.id);
    if (activeRun) {
      return `активная печать ${activeRun.id} (${activeRun.state}) использует файл`;
    }
  }

  const latest = repos.artifactAnalyses.latestForArtifact(artifactId);
  if (latest && (latest.state === "pending" || latest.state === "running")) {
    return "анализ артефакта ещё выполняется";
  }

  // A live placement pinned to this exact file.
  for (const assignment of repos.assignments.listReferencingArtifact(artifactId)) {
    if (LIVE_ASSIGNMENT_STATES.has(assignment.state)) {
      return `назначение ${assignment.id} на «${assignment.printerId}» (${assignment.state}) использует файл`;
    }
  }

  // Bytes are being read out of the blob right now. Later device states are not
  // blockers: the file already lives on the printer and no longer needs ours —
  // and a live placement around it is caught by the assignment check above.
  for (const device of repos.deviceArtifacts.listByArtifact(artifactId)) {
    if (device.state === "UPLOADING") {
      return `файл сейчас загружается на принтер «${device.printerId}» (${device.remotePath})`;
    }
  }

  for (const variant of repos.sliceVariants.listReferencingArtifact(artifactId)) {
    if (variant.state === "pending" || variant.state === "running") {
      return `slice-вариант ${variant.id} (${variant.state}) использует файл`;
    }
    // Deleting the source cascades this variant away — refuse while it carries weight.
    if (variant.sourceArtifactId === artifactId) {
      const holder = variantStillLoadBearing(repos, variant);
      if (holder) return holder;
    }
  }
  return null;
}

/**
 * Whether anything would be left pointing at nothing if `variant` disappeared.
 * `print_tasks.slice_variant_id` and `assignments.slice_variant_id` are plain
 * columns (no foreign key), so the database would not stop such a deletion — it
 * would simply leave a dangling id behind. History may keep its ids; live work
 * may not lose its variant.
 */
function variantStillLoadBearing(repos: Repositories, variant: SliceVariant): string | null {
  const task = repos.tasks.getById(variant.taskId);
  if (task && task.sliceVariantId === variant.id && !TERMINAL_TASK_STATES.has(task.state)) {
    return `задание «${task.title}» (${task.state}) собрано из этой модели вариантом ${variant.id}`;
  }
  for (const assignment of repos.assignments.listBySliceVariant(variant.id)) {
    if (LIVE_ASSIGNMENT_STATES.has(assignment.state)) {
      return `назначение ${assignment.id} на «${assignment.printerId}» (${assignment.state}) собрано из этой модели вариантом ${variant.id}`;
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
   * Only AFTER the commit is the blob unlinked, and only when no other artifact
   * shares it. That whole step runs under the per-key blob lock, so an upload
   * deduplicating onto the same bytes cannot have them pulled out from under it.
   * A failed unlink leaves an orphan blob (the DB stays truthful, never the
   * reverse); the orphan sweep reclaims it later.
   */
  async deleteArtifact(
    artifactId: string,
    options: { actor?: string } = {}
  ): Promise<ArtifactDeletion> {
    const actor = options.actor ?? this.ctx.defaultActor;
    const committed = this.ctx.store.transaction(() => {
      const repos = this.ctx.store.repositories;
      const artifact = repos.artifacts.getById(artifactId);
      if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);
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
          removedSliceVariants: removedSliceVariants.length
        }
      });
      return {
        // A content-addressed blob key (legacy name-only artifacts have no blob).
        key: artifact.sha256 && artifact.source ? artifact.source : null,
        removedSliceVariants
      };
    });

    const base = { artifactId, removedSliceVariants: committed.removedSliceVariants };
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
