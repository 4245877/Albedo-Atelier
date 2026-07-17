import type { Readable } from "node:stream";

import { NotFoundError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  ARTIFACT_ANALYSIS_TRANSITIONS,
  assertTransition,
  PRINT_TASK_TRANSITIONS
} from "../../domain/print/states";
import type {
  Artifact,
  ArtifactAnalysis,
  ArtifactKind,
  AuditEntityType,
  AuditEvent,
  Metadata,
  PrintTask
} from "../../domain/print/types";
import type { StoreLogger } from "../../shared/logger";
import type { ArtifactStorage, CommittedBlob } from "../../infra/storage/artifactStorage";
import { AnalysisWorker } from "./analysisWorker";
import { analyzeFile, type AnalyzerInput, type AnalyzerLimits, type AnalyzerResult } from "./analyzers";

/** The pluggable analyzer function (real one by default; a stub in tests). */
export type AnalyzeFn = (input: AnalyzerInput, limits: AnalyzerLimits) => Promise<AnalyzerResult>;

export interface ArtifactServiceOptions {
  now?: () => Date;
  actor?: string;
  limits: AnalyzerLimits;
  /** Single-file size limit enforced while staging (belt-and-braces with multipart). */
  maxFileBytes: number;
  timeoutMs: number;
  concurrency: number;
  /** Analyzer implementation; defaults to the built-in {@link analyzeFile}. */
  analyze?: AnalyzeFn;
  logger?: StoreLogger;
}

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

export interface ArtifactSummary {
  artifact: Artifact;
  task: PrintTask | null;
  analysis: ArtifactAnalysis | null;
}

export interface ArtifactDetail {
  artifact: Artifact;
  task: PrintTask | null;
  analyses: ArtifactAnalysis[];
  audit: AuditEvent[];
}

/**
 * The application service for uploaded artifacts and their analysis.
 *
 * It is the *only* place that turns an upload into durable state, and it does so
 * exactly the way the brief demands: the blob is content-addressed on disk
 * first, then — in a single SQLite transaction — an {@link Artifact}, a
 * {@link PrintTask} in `DRAFT`, a `pending` {@link ArtifactAnalysis} and their
 * audit events are created together. No `QueueEntry` is made: an uploaded task
 * is a draft, not queued work. Analysis then runs off the request on a bounded
 * {@link AnalysisWorker}; the dashboard polls the analysis row for the result.
 *
 * This service never touches the legacy JSON queue, `/api/queue` or `state.json`
 * — the upload path lives entirely in the new SQLite model.
 */
export class ArtifactService {
  private readonly now: () => Date;
  private readonly defaultActor: string;
  private readonly analyze: AnalyzeFn;
  private readonly worker: AnalysisWorker;
  private readonly logger: StoreLogger;

  constructor(
    private readonly store: PrintQueueStore,
    private readonly storage: ArtifactStorage,
    private readonly options: ArtifactServiceOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.defaultActor = options.actor ?? "operator";
    this.analyze = options.analyze ?? analyzeFile;
    this.logger = options.logger ?? {};
    this.worker = new AnalysisWorker(
      options.concurrency,
      (id) => this.runAnalysis(id),
      this.logger
    );
  }

  // ── Ingest ───────────────────────────────────────────────────────────────

  /**
   * Stores one uploaded file and creates its draft task + pending analysis.
   * Streams to a content-addressed blob (hashed on the way, atomically moved
   * into place, deduplicated), then transactionally creates the rows. A DB
   * failure after the blob landed cleans up only a blob this upload newly
   * created — never one another artifact already shares.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const fileName = sanitizeName(input.fileName);
    const actor = input.actor ?? this.defaultActor;

    const staged = await this.storage.stage(input.source, {
      maxBytes: this.options.maxFileBytes,
      alreadyTruncated: input.truncated
    });
    const committed = await this.storage.commit(staged);

    try {
      const result = this.store.transaction<Omit<IngestResult, "blobExisted">>(() => {
        const repos = this.store.repositories;
        const iso = this.nowIso();

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
        this.recordAudit({ entityType: "artifact", entityId: artifact.id, action: "uploaded", actor });

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
          createdAt: iso,
          updatedAt: iso,
          version: 1,
          legacyRef: null,
          metadata: { source: "upload" }
        };
        repos.tasks.insert(task);
        this.recordAudit({
          entityType: "print_task",
          entityId: task.id,
          action: "created",
          to: task.state,
          actor
        });

        const analysis = this.newPendingAnalysis(artifact.id, iso);
        repos.artifactAnalyses.insert(analysis);
        this.recordAudit({
          entityType: "artifact_analysis",
          entityId: analysis.id,
          action: "created",
          to: analysis.state,
          actor
        });

        return { artifact, task, analysis };
      });

      this.worker.enqueue(result.analysis.id);
      return { ...result, blobExisted: committed.deduplicated };
    } catch (dbError) {
      await this.cleanupOrphanBlob(committed);
      throw dbError;
    }
  }

  /**
   * Re-runs analysis for an artifact (used after a `failed` attempt). Creates a
   * fresh `pending` analysis and queues it; if one is already pending/running it
   * is returned unchanged (idempotent — no duplicate work is stacked).
   */
  reanalyze(artifactId: string, actor?: string): ArtifactAnalysis {
    const repos = this.store.repositories;
    const artifact = repos.artifacts.getById(artifactId);
    if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);

    const latest = repos.artifactAnalyses.latestForArtifact(artifactId);
    if (latest && (latest.state === "pending" || latest.state === "running")) {
      return latest;
    }

    const analysis = this.store.transaction(() => {
      const created = this.newPendingAnalysis(artifactId, this.nowIso());
      repos.artifactAnalyses.insert(created);
      this.recordAudit({
        entityType: "artifact_analysis",
        entityId: created.id,
        action: "reanalyze",
        to: created.state,
        actor,
        detail: { previous: latest?.id ?? null }
      });
      return created;
    });

    this.worker.enqueue(analysis.id);
    return analysis;
  }

  // ── Worker body ────────────────────────────────────────────────────────────

  /**
   * Analyses one file end-to-end (the worker job). Moves the row `pending →
   * running`, runs the analyzer under a wall-clock timeout *outside* any
   * transaction, then persists the outcome in a short transaction. A `blocked`
   * verdict parks the still-draft task in `NEEDS_REVIEW`; a technical failure
   * leaves the task a draft so it can be re-analysed. Never throws (the worker
   * only logs).
   */
  async runAnalysis(analysisId: string): Promise<void> {
    const started = this.store.repositories.artifactAnalyses.getById(analysisId);
    if (!started || started.state === "ready" || started.state === "failed") return;

    if (started.state === "pending") {
      this.store.transaction(() =>
        this.transitionAnalysis(started, "running", {}, "analysis_started", "analyzer")
      );
    }

    const artifact = this.store.repositories.artifacts.getById(started.artifactId);
    if (!artifact || !artifact.source) {
      this.failAnalysis(analysisId, "Артефакт или его файл не найден");
      return;
    }

    let path: string;
    try {
      path = this.storage.resolvePath(artifact.source);
    } catch {
      this.failAnalysis(analysisId, "Некорректный ключ хранилища артефакта");
      return;
    }

    try {
      const result = await this.withTimeout(
        this.analyze(
          { path, sizeBytes: artifact.sizeBytes ?? 0, fileName: artifact.name },
          this.options.limits
        ),
        this.options.timeoutMs
      );
      this.applyResult(analysisId, result);
    } catch (error) {
      this.failAnalysis(analysisId, errorMessage(error));
    }
  }

  /** Re-queues every unfinished analysis on startup (crash recovery). */
  recover(): number {
    const repos = this.store.repositories;
    const unfinished = repos.artifactAnalyses.listUnfinished();
    for (const analysis of unfinished) {
      if (analysis.state === "running") {
        this.store.transaction(() => {
          const current = repos.artifactAnalyses.getById(analysis.id);
          if (current && current.state === "running") {
            this.transitionAnalysis(current, "pending", {}, "analysis_recovered", "system");
          }
        });
      }
      this.worker.enqueue(analysis.id);
    }
    if (unfinished.length > 0) {
      this.logger.info?.({ recovered: unfinished.length }, "unfinished analyses re-queued");
    }
    return unfinished.length;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  listArtifacts(): ArtifactSummary[] {
    const repos = this.store.repositories;
    return repos.artifacts
      .list()
      .map((artifact) => ({
        artifact,
        task: repos.tasks.findByArtifactId(artifact.id),
        analysis: repos.artifactAnalyses.latestForArtifact(artifact.id)
      }))
      .reverse(); // newest upload first
  }

  getArtifactDetail(id: string): ArtifactDetail {
    const repos = this.store.repositories;
    const artifact = repos.artifacts.getById(id);
    if (!artifact) throw new NotFoundError(`Артефакт «${id}»`);
    const task = repos.tasks.findByArtifactId(id);
    const audit = [
      ...repos.audit.listByEntity("artifact", id),
      ...(task ? repos.audit.listByEntity("print_task", task.id) : [])
    ].sort((a, b) => (a.at < b.at ? 1 : -1));
    return {
      artifact,
      task,
      analyses: repos.artifactAnalyses.listByArtifact(id),
      audit
    };
  }

  /** Awaits the worker draining (tests only). */
  whenIdle(): Promise<void> {
    return this.worker.whenIdle();
  }

  close(): void {
    this.worker.close();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private applyResult(analysisId: string, result: AnalyzerResult): void {
    this.store.transaction(() => {
      const repos = this.store.repositories;
      const current = repos.artifactAnalyses.getById(analysisId);
      if (!current || current.state === "ready" || current.state === "failed") return;

      assertTransition("анализ артефакта", ARTIFACT_ANALYSIS_TRANSITIONS, current.state, "ready");
      const iso = this.nowIso();
      repos.artifactAnalyses.update({
        ...current,
        state: "ready",
        detectedFormat: result.detectedFormat,
        verdict: result.verdict,
        analyzer: result.analyzer,
        analyzerVersion: result.analyzerVersion,
        estimatedDurationS: result.estimatedDurationS ?? null,
        estimatedFilamentG: result.estimatedFilamentG ?? null,
        material: result.material ?? null,
        nozzleDiameterMm: result.nozzleDiameterMm ?? null,
        layerHeightMm: result.layerHeightMm ?? null,
        warnings: result.warnings,
        blockers: result.blockers,
        data: result.data as Metadata,
        error: null,
        updatedAt: iso
      });
      this.recordAudit({
        entityType: "artifact_analysis",
        entityId: current.id,
        action: "analyzed",
        from: current.state,
        to: "ready",
        actor: "analyzer",
        detail: { verdict: result.verdict, format: result.detectedFormat }
      });

      // A critical problem parks the still-draft task for the operator.
      if (result.verdict === "blocked") {
        const task = repos.tasks.findByArtifactId(current.artifactId);
        if (task && task.state === "DRAFT") {
          const reason = result.blockers[0]?.message ?? "анализ выявил критическую проблему";
          this.transitionTask(task, "NEEDS_REVIEW", reason, "blocked");
        }
      }
    });
  }

  private failAnalysis(analysisId: string, message: string): void {
    this.store.transaction(() => {
      const repos = this.store.repositories;
      const current = repos.artifactAnalyses.getById(analysisId);
      if (!current || current.state === "ready" || current.state === "failed") return;
      assertTransition("анализ артефакта", ARTIFACT_ANALYSIS_TRANSITIONS, current.state, "failed");
      repos.artifactAnalyses.update({
        ...current,
        state: "failed",
        error: message,
        updatedAt: this.nowIso()
      });
      this.recordAudit({
        entityType: "artifact_analysis",
        entityId: current.id,
        action: "analysis_failed",
        from: current.state,
        to: "failed",
        actor: "analyzer",
        detail: { error: message }
      });
    });
  }

  private transitionAnalysis(
    analysis: ArtifactAnalysis,
    to: ArtifactAnalysis["state"],
    patch: Partial<ArtifactAnalysis>,
    action: string,
    actor?: string
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
      actor
    });
    return saved;
  }

  private transitionTask(
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

  private newPendingAnalysis(artifactId: string, iso: string): ArtifactAnalysis {
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

  /** Removes a blob a failed DB write orphaned — never a pre-existing/shared one. */
  private async cleanupOrphanBlob(committed: CommittedBlob): Promise<void> {
    if (committed.deduplicated) return; // pre-existing content may be shared → keep
    const referenced = this.store.repositories.artifacts.findBySource(committed.key);
    if (!referenced) {
      await this.storage.remove(committed.key).catch((error) => {
        this.logger.error?.({ err: error, key: committed.key }, "failed to remove orphan blob");
      });
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Анализ превысил лимит времени")), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Ошибка анализа";
}
