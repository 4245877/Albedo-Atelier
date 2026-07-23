import fs from "node:fs";
import type { Readable } from "node:stream";

import {
  InsufficientStorageError,
  NotFoundError,
  ServiceBusyError
} from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { Artifact, ArtifactAnalysis, ArtifactKind, Metadata, PrintTask } from "../../domain/print/types";
import { keyFor, type CommittedBlob, type StagedBlob } from "../../infra/storage/artifactStorage";
import type { AnalysisRunner } from "./analysisRunner";
import type { ArtifactContext } from "./context";

export interface IngestInput {
  source: Readable;
  fileName: string;
  mimeType?: string;
  actor?: string;
  /** Getter the route wires to the multipart part's `truncated` flag. */
  truncated?: () => boolean;
}

export interface IngestResult {
  artifact: Artifact;
  task: PrintTask;
  analysis: ArtifactAnalysis;
  /** True when identical content was already stored — the blob was reused, not rewritten. */
  blobExisted: boolean;
}

/**
 * The ingest use case: the only place that turns an upload (or an on-disk
 * slicer output) into durable state. The blob is content-addressed on disk
 * first, then — in a single SQLite transaction — an {@link Artifact}, a
 * {@link PrintTask} in `DRAFT` (uploads only), a `pending` analysis and their
 * audit events are created together. Admission control (backlog, disk headroom,
 * store quotas) is fail-closed and runs BEFORE any bytes are stored.
 */
export class ArtifactIngest {
  constructor(
    private readonly ctx: ArtifactContext,
    private readonly analysis: AnalysisRunner
  ) {}

  /**
   * Stores one uploaded file and creates its draft task + pending analysis.
   * Streams to a content-addressed blob (hashed on the way, atomically moved
   * into place, deduplicated), then transactionally creates the rows. A DB
   * failure after the blob landed cleans up only a blob this upload newly
   * created — never one another artifact already shares.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const fileName = sanitizeName(input.fileName);
    const actor = input.actor ?? this.ctx.defaultActor;

    // Fail-closed admission control BEFORE any bytes are stored: don't accept
    // analysis work we cannot bound, and don't start filling a disk that is
    // already low (the JSON state + SQLite share this volume).
    this.assertAnalysisCapacity();
    await this.assertDiskHeadroom();

    let staged: StagedBlob;
    try {
      staged = await this.ctx.storage.stage(input.source, {
        maxBytes: this.ctx.options.maxFileBytes,
        alreadyTruncated: input.truncated
      });
    } catch (error) {
      throw mapStorageError(error);
    }

    // Server-side global store quota (count + bytes) — NOT advisory. Discard the
    // staged temp if accepting it would push the store past its cap.
    try {
      await this.assertStoreQuota(staged);
    } catch (error) {
      await this.ctx.storage.discard(staged.tempPath);
      throw error;
    }

    let committed: CommittedBlob;
    try {
      committed = await this.ctx.storage.commit(staged);
    } catch (error) {
      await this.ctx.storage.discard(staged.tempPath);
      throw mapStorageError(error);
    }

    try {
      const result = this.ctx.store.transaction<Omit<IngestResult, "blobExisted">>(() => {
        const repos = this.ctx.store.repositories;
        const iso = this.ctx.nowIso();

        const artifact: Artifact = {
          id: newId(ID_PREFIX.artifact),
          kind: kindForName(fileName),
          name: fileName,
          source: committed.key,
          sizeBytes: committed.sizeBytes,
          sha256: committed.sha256,
          createdAt: iso,
          updatedAt: iso,
          version: 1,
          legacyRef: null,
          metadata: {
            originalName: input.fileName,
            mimeType: input.mimeType ?? null,
            blobExisted: committed.deduplicated
          }
        };
        repos.artifacts.insert(artifact);
        this.ctx.recordAudit({ entityType: "artifact", entityId: artifact.id, action: "uploaded", actor });

        const task: PrintTask = {
          id: newId(ID_PREFIX.printTask),
          artifactId: artifact.id,
          title: fileName,
          material: null,
          targetPrinter: null,
          priority: 0,
          // Uploaded work is a DRAFT — deliberately NOT enqueued (no QueueEntry).
          state: "DRAFT",
          reason: null,
          night: false,
          notBefore: null,
          deadline: null,
          dayNightPreference: "any",
          pinnedPrinterId: null,
          unattendedAllowed: false,
          createdAt: iso,
          updatedAt: iso,
          version: 1,
          legacyRef: null,
          metadata: { source: "upload" }
        };
        repos.tasks.insert(task);
        this.ctx.recordAudit({
          entityType: "print_task",
          entityId: task.id,
          action: "created",
          to: task.state,
          actor
        });

        const analysis = this.ctx.newPendingAnalysis(artifact.id, iso);
        repos.artifactAnalyses.insert(analysis);
        this.ctx.recordAudit({
          entityType: "artifact_analysis",
          entityId: analysis.id,
          action: "created",
          to: analysis.state,
          actor
        });

        return { artifact, task, analysis };
      });

      this.analysis.enqueue(result.analysis.id);
      return { ...result, blobExisted: committed.deduplicated };
    } catch (dbError) {
      await this.cleanupOrphanBlob(committed);
      throw dbError;
    }
  }

  /**
   * Registers an already-on-disk file (an OrcaSlicer output) as a NEW artifact —
   * content-addressed through the same {@link ArtifactStorage} the uploads use —
   * and analyses it **synchronously** with the existing analyzer. Unlike
   * {@link ingest} it creates no draft task (the output belongs to a slice variant,
   * not the upload queue) and enqueues no background work: the slice pipeline awaits
   * the finished analysis so it can copy the ETA/usage/geometry onto the variant.
   * The `metadata` (e.g. `{ sliceVariantId }`) is merged onto the artifact.
   */
  async ingestOutputFile(input: {
    filePath: string;
    fileName: string;
    actor?: string;
    metadata?: Metadata;
  }): Promise<{ artifact: Artifact; analysis: ArtifactAnalysis }> {
    const fileName = sanitizeName(input.fileName);
    const actor = input.actor ?? this.ctx.defaultActor;

    const staged = await this.ctx.storage.stage(fs.createReadStream(input.filePath), {
      maxBytes: this.ctx.options.maxFileBytes
    });
    const committed = await this.ctx.storage.commit(staged);

    try {
      const created = this.ctx.store.transaction(() => {
        const repos = this.ctx.store.repositories;
        const iso = this.ctx.nowIso();
        const artifact: Artifact = {
          id: newId(ID_PREFIX.artifact),
          kind: kindForName(fileName),
          name: fileName,
          source: committed.key,
          sizeBytes: committed.sizeBytes,
          sha256: committed.sha256,
          createdAt: iso,
          updatedAt: iso,
          version: 1,
          legacyRef: null,
          metadata: { ...(input.metadata ?? {}), source: "slice", blobExisted: committed.deduplicated }
        };
        repos.artifacts.insert(artifact);
        this.ctx.recordAudit({ entityType: "artifact", entityId: artifact.id, action: "sliced", actor });

        const analysis = this.ctx.newPendingAnalysis(artifact.id, iso);
        repos.artifactAnalyses.insert(analysis);
        this.ctx.recordAudit({
          entityType: "artifact_analysis",
          entityId: analysis.id,
          action: "created",
          to: analysis.state,
          actor
        });
        return { artifact, analysisId: analysis.id };
      });

      await this.analysis.runAnalysis(created.analysisId);
      const analysis =
        this.ctx.store.repositories.artifactAnalyses.getById(created.analysisId) ??
        (() => {
          throw new NotFoundError(`Анализ «${created.analysisId}»`);
        })();
      return { artifact: created.artifact, analysis };
    } catch (error) {
      await this.cleanupOrphanBlob(committed);
      throw error;
    }
  }

  // ── Admission control ──────────────────────────────────────────────────────

  /** Refuses a new upload when the analysis backlog is at its bound (503). */
  private assertAnalysisCapacity(): void {
    const max = this.ctx.options.analysisMaxQueue;
    if (max !== undefined && this.analysis.inFlight >= max) {
      throw new ServiceBusyError(
        `Очередь анализа переполнена (${this.analysis.inFlight}/${max}) — повторите позже`
      );
    }
  }

  /** Refuses a new upload when free disk is below the configured reserve (507). */
  private async assertDiskHeadroom(): Promise<void> {
    const min = this.ctx.options.minFreeDiskBytes;
    if (min === undefined) return;
    const free = await this.ctx.storage.freeBytes();
    if (free !== null && free < min) {
      throw new InsufficientStorageError(
        `Недостаточно места на диске (свободно ${free} Б, требуется не менее ${min} Б) — удалите ненужные загрузки`
      );
    }
  }

  /** Refuses a new upload that would exceed the count or total-bytes store quota (507). */
  private async assertStoreQuota(staged: StagedBlob): Promise<void> {
    const repos = this.ctx.store.repositories;
    const maxCount = this.ctx.options.maxArtifactCount;
    if (maxCount !== undefined && repos.artifacts.count() >= maxCount) {
      throw new InsufficientStorageError(
        `Достигнут лимит числа артефактов (${maxCount}) — удалите ненужные загрузки`
      );
    }
    const maxBytes = this.ctx.options.maxStoredBytes;
    if (maxBytes === undefined) return;
    // Dedup-aware: identical content already on disk adds nothing to the store.
    const willAdd = (await this.ctx.storage.exists(keyFor(staged.sha256))) ? 0 : staged.sizeBytes;
    if (repos.artifacts.totalStoredBytes() + willAdd > maxBytes) {
      throw new InsufficientStorageError(
        `Достигнут лимит хранилища артефактов (${maxBytes} Б) — удалите ненужные загрузки`
      );
    }
  }

  /** Removes a blob a failed DB write orphaned — never a pre-existing/shared one. */
  private async cleanupOrphanBlob(committed: CommittedBlob): Promise<void> {
    if (committed.deduplicated) return; // pre-existing content may be shared → keep
    const referenced = this.ctx.store.repositories.artifacts.findBySource(committed.key);
    if (!referenced) {
      await this.ctx.storage.remove(committed.key).catch((error) => {
        this.ctx.logger.error?.({ err: error, key: committed.key }, "failed to remove orphan blob");
      });
    }
  }
}

// ── Free helpers ─────────────────────────────────────────────────────────────

function kindForName(fileName: string): ArtifactKind {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "gcode" || ext === "gco" || ext === "g") return "gcode";
  if (ext === "stl" || ext === "3mf") return "model";
  return "unknown";
}

/** Keeps only a safe display basename — the name is never used as a filesystem path. */
function sanitizeName(name: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  // Strip ASCII control characters (< 0x20) — the name is display/extension only.
  let cleaned = "";
  for (const ch of base) {
    if (ch.charCodeAt(0) >= 0x20) cleaned += ch;
  }
  cleaned = cleaned.trim();
  return cleaned.slice(0, 255) || "upload.bin";
}

/**
 * Maps a low-level storage failure onto the API taxonomy. A disk-full/quota
 * error (the write filling the volume mid-stream) becomes a 507 the dashboard
 * can act on; everything else (including a {@link PayloadTooLargeError} the
 * stager already raised) passes through unchanged.
 */
function mapStorageError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") {
    return new InsufficientStorageError("На диске нет места для загрузки — освободите место и повторите");
  }
  return error;
}
