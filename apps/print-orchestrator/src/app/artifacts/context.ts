import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  ARTIFACT_ANALYSIS_TRANSITIONS,
  assertTransition,
  PRINT_TASK_TRANSITIONS
} from "../../domain/print/states";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { ArtifactAnalysis, Metadata, PrintTask } from "../../domain/print/types";
import { KeyedMutex } from "../../shared/keyedMutex";
import type { StoreLogger } from "../../shared/logger";
import type { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { recordAuditEvent, type AuditInput } from "../audit";
import type { AnalyzerLimits } from "./analyzers";

export interface ArtifactServiceOptions {
  now?: () => Date;
  actor?: string;
  limits: AnalyzerLimits;
  /** Single-file size limit enforced while staging (belt-and-braces with multipart). */
  maxFileBytes: number;
  timeoutMs: number;
  concurrency: number;
  /** Hard cap on total stored bytes (dedup-aware); undefined disables the check. */
  maxStoredBytes?: number;
  /** Hard cap on the number of stored artifacts; undefined disables the check. */
  maxArtifactCount?: number;
  /** Free-disk reserve before accepting an upload; undefined disables the check. */
  minFreeDiskBytes?: number;
  /** Max analyses queued/running before an upload is refused; undefined disables the check. */
  analysisMaxQueue?: number;
  /** Analyzer implementation; defaults to the built-in worker-thread analyzer. */
  analyze?: import("./analysisRunner").AnalyzeFn;
  logger?: StoreLogger;
}

/**
 * Shared collaborator state for the artifact use cases (ingest, analysis,
 * queries, retention): the store, blob storage, options, and the audited
 * transitions both the analysis worker and the ingest path need. Not exported
 * outside `app/artifacts`.
 */
export class ArtifactContext {
  readonly now: () => Date;
  readonly defaultActor: string;
  readonly logger: StoreLogger;
  /**
   * Serializes everything that touches ONE blob key: committing bytes into
   * content-addressed storage together with the rows that reference them, and
   * unlinking a blob after its last row is gone. Without it the two race — a
   * delete reads "nothing references this key", an upload deduplicates onto the
   * very same bytes and inserts its row, and then the delete unlinks the file
   * out from under it, leaving a DB row pointing at nothing. Different keys
   * never block each other, so parallel uploads are unaffected.
   */
  private readonly blobLocks = new KeyedMutex();

  constructor(
    readonly store: PrintQueueStore,
    readonly storage: ArtifactStorage,
    readonly options: ArtifactServiceOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.defaultActor = options.actor ?? "operator";
    this.logger = options.logger ?? {};
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /** Runs `task` with exclusive access to one storage key. @see {@link blobLocks} */
  withBlobLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.blobLocks.run(key, task);
  }

  recordAudit(input: AuditInput): void {
    recordAuditEvent(this.store, () => this.nowIso(), this.defaultActor, input);
  }

  transitionAnalysis(
    analysis: ArtifactAnalysis,
    to: ArtifactAnalysis["state"],
    patch: Partial<ArtifactAnalysis>,
    action: string,
    actor?: string,
    detail?: Metadata
  ): ArtifactAnalysis {
    assertTransition("анализ артефакта", ARTIFACT_ANALYSIS_TRANSITIONS, analysis.state, to);
    const saved = this.store.repositories.artifactAnalyses.update({
      ...analysis,
      ...patch,
      state: to,
      updatedAt: this.nowIso()
    });
    this.recordAudit({
      entityType: "artifact_analysis",
      entityId: analysis.id,
      action,
      from: analysis.state,
      to,
      actor,
      detail
    });
    return saved;
  }

  transitionTask(
    task: PrintTask,
    to: PrintTask["state"],
    reason: string | null,
    action: string,
    actor?: string
  ): PrintTask {
    assertTransition("задание", PRINT_TASK_TRANSITIONS, task.state, to);
    const saved = this.store.repositories.tasks.update({
      ...task,
      state: to,
      reason,
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

  newPendingAnalysis(artifactId: string, iso: string): ArtifactAnalysis {
    return {
      id: newId(ID_PREFIX.artifactAnalysis),
      artifactId,
      state: "pending",
      detectedFormat: null,
      verdict: null,
      analyzer: null,
      analyzerVersion: null,
      estimatedDurationS: null,
      estimatedFilamentG: null,
      material: null,
      nozzleDiameterMm: null,
      layerHeightMm: null,
      warnings: [],
      blockers: [],
      data: {},
      error: null,
      createdAt: iso,
      updatedAt: iso,
      version: 1,
      metadata: {}
    };
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Ошибка анализа";
}
