import { NotFoundError, ValidationError } from "../../core/errors";
import { errorMessage, type ArtifactContext } from "./context";

/**
 * Retention / safe deletion of artifacts. Fail-closed: anything still
 * referenced by live work is protected, and the blob is unlinked only AFTER the
 * database commit — and only when no other artifact shares it (dedup refcount).
 */
export class ArtifactRetention {
  constructor(private readonly ctx: ArtifactContext) {}

  /**
   * Why an artifact must not be deleted right now, or null when it is safe.
   * Fail-closed: anything still referenced by live work is protected —
   * a non-terminal task (except the upload DRAFT, which is cancelled together
   * with its artifact), an active/pending run, an unfinished analysis, or a
   * live slice variant.
   */
  deletionBlocker(artifactId: string): string | null {
    const repos = this.ctx.store.repositories;
    const artifact = repos.artifacts.getById(artifactId);
    if (!artifact) return "артефакт не найден";

    for (const task of repos.tasks.listByArtifactId(artifactId)) {
      const terminal = task.state === "COMPLETED" || task.state === "FAILED" || task.state === "CANCELLED";
      if (!terminal && task.state !== "DRAFT") {
        return `задание «${task.title}» в состоянии ${task.state} использует артефакт`;
      }
      const activeRun = repos.printRuns.findActiveByTask(task.id);
      if (activeRun) {
        return `активная печать ${activeRun.id} (${activeRun.state}) использует артефакт`;
      }
    }

    const latest = repos.artifactAnalyses.latestForArtifact(artifactId);
    if (latest && (latest.state === "pending" || latest.state === "running")) {
      return "анализ артефакта ещё выполняется";
    }

    for (const variant of repos.sliceVariants.listReferencingArtifact(artifactId)) {
      if (variant.state === "pending" || variant.state === "running") {
        return `slice-вариант ${variant.id} (${variant.state}) использует артефакт`;
      }
    }
    return null;
  }

  /**
   * Deletes one artifact safely. In ONE transaction: the safety check re-runs,
   * a DRAFT upload task is cancelled, the artifact row is removed (analyses
   * cascade, terminal task references null out). Only AFTER the commit is the
   * blob unlinked — and only when no other artifact shares it (dedup refcount).
   * A failed unlink leaves an orphan blob (the DB stays truthful); the orphan
   * sweep reclaims it later.
   */
  async deleteArtifact(
    artifactId: string,
    options: { actor?: string } = {}
  ): Promise<{ blobKey: string | null; blobRemoved: boolean }> {
    const actor = options.actor ?? this.ctx.defaultActor;
    const key = this.ctx.store.transaction(() => {
      const repos = this.ctx.store.repositories;
      const artifact = repos.artifacts.getById(artifactId);
      if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);
      const blocker = this.deletionBlocker(artifactId);
      if (blocker) throw new ValidationError(`Артефакт нельзя удалить: ${blocker}`);

      // Cancel the upload placeholder DRAFT together with its artifact.
      for (const task of repos.tasks.listByArtifactId(artifactId)) {
        if (task.state === "DRAFT") {
          repos.tasks.update({ ...task, state: "CANCELLED", reason: "артефакт удалён", updatedAt: this.ctx.nowIso() });
        }
      }
      repos.artifacts.delete(artifactId);
      this.ctx.recordAudit({ entityType: "artifact", entityId: artifactId, action: "deleted", actor });
      // A content-addressed blob key (legacy name-only artifacts have no blob).
      return artifact.sha256 && artifact.source ? artifact.source : null;
    });

    if (!key) return { blobKey: null, blobRemoved: false };
    if (this.ctx.store.repositories.artifacts.countBySource(key) > 0) {
      // Deduplicated content is still referenced by another artifact — keep it.
      return { blobKey: key, blobRemoved: false };
    }
    try {
      await this.ctx.storage.remove(key);
      return { blobKey: key, blobRemoved: true };
    } catch (error) {
      this.ctx.logger.error?.({ err: error, key }, "blob unlink failed — left as orphan for the sweep");
      return { blobKey: key, blobRemoved: false };
    }
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
      const tasks = repos.tasks.listByArtifactId(artifact.id);
      if (tasks.some((t) => t.state === "DRAFT")) {
        skipped.push({ id: artifact.id, reason: "черновик загрузки — только ручное удаление" });
        continue;
      }
      const blocker = this.deletionBlocker(artifact.id);
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
      if (repos.artifacts.countBySource(key) > 0) continue;
      if (!options.dryRun) {
        try {
          await this.ctx.storage.remove(key);
        } catch (error) {
          this.ctx.logger.error?.({ err: error, key }, "orphan blob removal failed");
          continue;
        }
      }
      orphanBlobsRemoved.push(key);
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
