import { BoundedWorkerPool } from "../../shared/boundedWorkerPool";
import { errorMessage, type ArtifactContext } from "./context";
import { NotFoundError } from "../../core/errors";
import type { ArtifactAnalysis, Metadata } from "../../domain/print/types";
import type { AnalyzerInput, AnalyzerLimits, AnalyzerResult } from "./analyzers";
import { analyzeInWorker } from "./analyzers/workerHost";

/** The pluggable analyzer function (real one by default; a stub in tests). */
export type AnalyzeFn = (input: AnalyzerInput, limits: AnalyzerLimits) => Promise<AnalyzerResult>;

/**
 * The analysis use case: owns the bounded worker pool and the whole analysis
 * lifecycle — `pending → running → ready/failed`, re-analysis, and startup
 * recovery. The analyzer itself runs in a worker thread (terminatable timeout);
 * tests inject an in-process stub via `options.analyze`.
 */
export class AnalysisRunner {
  private readonly analyze: AnalyzeFn;
  private readonly worker: BoundedWorkerPool;

  constructor(private readonly ctx: ArtifactContext) {
    // Default to running the analyzer in a worker thread: heavy/hostile parsing
    // stays off the main event loop and the timeout can truly terminate it.
    this.analyze = ctx.options.analyze ?? analyzeInWorker(ctx.options.timeoutMs);
    this.worker = new BoundedWorkerPool(ctx.options.concurrency, (id) => this.runAnalysis(id), {
      logger: ctx.logger,
      label: "analysis worker"
    });
  }

  /** Jobs queued or running — the admission-control backlog figure. */
  get inFlight(): number {
    return this.worker.inFlight;
  }

  enqueue(analysisId: string): void {
    this.worker.enqueue(analysisId);
  }

  /**
   * Re-runs analysis for an artifact (used after a `failed` attempt). Creates a
   * fresh `pending` analysis and queues it; if one is already pending/running it
   * is returned unchanged (idempotent — no duplicate work is stacked).
   */
  reanalyze(artifactId: string, actor?: string): ArtifactAnalysis {
    const repos = this.ctx.store.repositories;
    const artifact = repos.artifacts.getById(artifactId);
    if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);

    const latest = repos.artifactAnalyses.latestForArtifact(artifactId);
    if (latest && (latest.state === "pending" || latest.state === "running")) {
      return latest;
    }

    const analysis = this.ctx.store.transaction(() => {
      const created = this.ctx.newPendingAnalysis(artifactId, this.ctx.nowIso());
      repos.artifactAnalyses.insert(created);
      this.ctx.recordAudit({
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

  /**
   * Analyses one file end-to-end (the worker job). Moves the row `pending →
   * running`, runs the analyzer under a wall-clock timeout *outside* any
   * transaction, then persists the outcome in a short transaction. A `blocked`
   * verdict parks the still-draft task in `NEEDS_REVIEW`; a technical failure
   * leaves the task a draft so it can be re-analysed. Never throws (the worker
   * only logs).
   */
  async runAnalysis(analysisId: string): Promise<void> {
    const started = this.ctx.store.repositories.artifactAnalyses.getById(analysisId);
    if (!started || started.state === "ready" || started.state === "failed") return;

    if (started.state === "pending") {
      this.ctx.store.transaction(() =>
        this.ctx.transitionAnalysis(started, "running", {}, "analysis_started", "analyzer")
      );
    }

    const artifact = this.ctx.store.repositories.artifacts.getById(started.artifactId);
    if (!artifact || !artifact.source) {
      this.failAnalysis(analysisId, "Артефакт или его файл не найден");
      return;
    }

    let path: string;
    try {
      path = this.ctx.storage.resolvePath(artifact.source);
    } catch {
      this.failAnalysis(analysisId, "Некорректный ключ хранилища артефакта");
      return;
    }

    try {
      // The analyzer (worker host) enforces the real timeout and terminates the
      // worker; this outer bound is a safety net (+grace) for an in-process stub
      // or a host that somehow never settles. The slot is freed only when this
      // resolves — after the worker has actually settled — so `concurrency`
      // means at most that many analyzers really executing.
      const result = await this.withTimeout(
        this.analyze(
          { path, sizeBytes: artifact.sizeBytes ?? 0, fileName: artifact.name },
          this.ctx.options.limits
        ),
        this.ctx.options.timeoutMs + 3000
      );
      this.applyResult(analysisId, result);
    } catch (error) {
      this.failAnalysis(analysisId, errorMessage(error));
    }
  }

  /** Re-queues every unfinished analysis on startup (crash recovery). */
  recover(): number {
    const repos = this.ctx.store.repositories;
    const unfinished = repos.artifactAnalyses.listUnfinished();
    for (const analysis of unfinished) {
      if (analysis.state === "running") {
        this.ctx.store.transaction(() => {
          const current = repos.artifactAnalyses.getById(analysis.id);
          if (current && current.state === "running") {
            this.ctx.transitionAnalysis(current, "pending", {}, "analysis_recovered", "system");
          }
        });
      }
      this.worker.enqueue(analysis.id);
    }
    if (unfinished.length > 0) {
      this.ctx.logger.info?.({ recovered: unfinished.length }, "unfinished analyses re-queued");
    }
    return unfinished.length;
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
    this.ctx.store.transaction(() => {
      const repos = this.ctx.store.repositories;
      const current = repos.artifactAnalyses.getById(analysisId);
      if (!current || current.state === "ready" || current.state === "failed") return;

      this.ctx.transitionAnalysis(
        current,
        "ready",
        {
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
          error: null
        },
        "analyzed",
        "analyzer",
        { verdict: result.verdict, format: result.detectedFormat }
      );

      // A critical problem parks the still-draft task for the operator.
      if (result.verdict === "blocked") {
        const task = repos.tasks.findByArtifactId(current.artifactId);
        if (task && task.state === "DRAFT") {
          const reason = result.blockers[0]?.message ?? "анализ выявил критическую проблему";
          this.ctx.transitionTask(task, "NEEDS_REVIEW", reason, "blocked");
        }
      }
    });
  }

  private failAnalysis(analysisId: string, message: string): void {
    this.ctx.store.transaction(() => {
      const repos = this.ctx.store.repositories;
      const current = repos.artifactAnalyses.getById(analysisId);
      if (!current || current.state === "ready" || current.state === "failed") return;
      this.ctx.transitionAnalysis(
        current,
        "failed",
        { error: message },
        "analysis_failed",
        "analyzer",
        { error: message }
      );
    });
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Анализ превысил лимит времени")), ms);
    });
    // If the timeout wins the race, the underlying promise settles later; swallow
    // its outcome so a late rejection is never an unhandled rejection.
    promise.catch(() => {});
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
