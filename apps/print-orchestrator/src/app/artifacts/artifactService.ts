import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Artifact, ArtifactAnalysis, Metadata } from "../../domain/print/types";
import type { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { AnalysisRunner, type AnalyzeFn } from "./analysisRunner";
import { ArtifactContext, type ArtifactServiceOptions } from "./context";
import { ArtifactIngest, type IngestInput, type IngestResult } from "./ingest";
import { ModelScaleService } from "./modelScale";
import { ArtifactQueries, type ArtifactDetail, type ArtifactSummary } from "./queries";
import { ArtifactRetention } from "./retention";

export type { AnalyzeFn } from "./analysisRunner";
export type { ArtifactServiceOptions } from "./context";
export type { IngestInput, IngestResult } from "./ingest";
export type { ArtifactDetail, ArtifactSummary } from "./queries";

/**
 * The application service for uploaded artifacts and their analysis. A facade
 * over four use-case modules sharing one {@link ArtifactContext}:
 *
 *   - {@link ArtifactIngest} — uploads and slicer outputs into durable state
 *     (content-addressed blob + rows in one transaction, fail-closed quotas);
 *   - {@link AnalysisRunner} — the bounded analysis worker pool and lifecycle
 *     (`pending → running → ready/failed`, re-analysis, crash recovery);
 *   - {@link ArtifactQueries} — listings and the per-artifact detail;
 *   - {@link ArtifactRetention} — safe deletion, the retention sweep and the
 *     orphan-blob reconciliation.
 *
 * This service never touches the legacy JSON queue, `/api/queue` or `state.json`
 * — the upload path lives entirely in the new SQLite model.
 */
export class ArtifactService {
  private readonly analysis: AnalysisRunner;
  private readonly ingestOps: ArtifactIngest;
  private readonly queries: ArtifactQueries;
  private readonly retention: ArtifactRetention;
  private readonly modelScale: ModelScaleService;

  constructor(store: PrintQueueStore, storage: ArtifactStorage, options: ArtifactServiceOptions) {
    const ctx = new ArtifactContext(store, storage, options);
    this.analysis = new AnalysisRunner(ctx);
    this.ingestOps = new ArtifactIngest(ctx, this.analysis);
    this.queries = new ArtifactQueries(ctx);
    this.retention = new ArtifactRetention(ctx);
    this.modelScale = new ModelScaleService(ctx);
  }

  // ── Ingest (ArtifactIngest) ────────────────────────────────────────────────

  ingest(input: IngestInput): Promise<IngestResult> {
    return this.ingestOps.ingest(input);
  }

  ingestOutputFile(input: {
    filePath: string;
    fileName: string;
    actor?: string;
    metadata?: Metadata;
  }): Promise<{ artifact: Artifact; analysis: ArtifactAnalysis }> {
    return this.ingestOps.ingestOutputFile(input);
  }

  // ── Analysis (AnalysisRunner) ──────────────────────────────────────────────

  reanalyze(artifactId: string, actor?: string): ArtifactAnalysis {
    return this.analysis.reanalyze(artifactId, actor);
  }

  runAnalysis(analysisId: string): Promise<void> {
    return this.analysis.runAnalysis(analysisId);
  }

  /** Re-queues every unfinished analysis on startup (crash recovery). */
  recover(): number {
    return this.analysis.recover();
  }

  /** Awaits the worker draining (tests only). */
  whenIdle(): Promise<void> {
    return this.analysis.whenIdle();
  }

  close(): void {
    this.analysis.close();
  }

  // ── Model scale (ModelScaleService) ────────────────────────────────────────

  /**
   * Records the operator's statement of what a model's coordinates mean. Until
   * this exists an STL's size is unproven and nothing may auto-start on it.
   */
  confirmModelScale(
    artifactId: string,
    input: { units: unknown; scaleFactor?: unknown; actor?: string }
  ): ReturnType<ModelScaleService["confirm"]> {
    return this.modelScale.confirm(artifactId, input);
  }

  /** Withdraws a scale confirmation; the size reverts to unproven. */
  clearModelScale(artifactId: string, actor?: string): ReturnType<ModelScaleService["clear"]> {
    return this.modelScale.clear(artifactId, actor);
  }

  // ── Reads (ArtifactQueries) ────────────────────────────────────────────────

  listArtifacts(): ArtifactSummary[] {
    return this.queries.listArtifacts();
  }

  getArtifactDetail(id: string): ArtifactDetail {
    return this.queries.getArtifactDetail(id);
  }

  // ── Retention / safe deletion (ArtifactRetention) ──────────────────────────

  deletionBlocker(artifactId: string): string | null {
    return this.retention.deletionBlocker(artifactId);
  }

  deleteArtifact(
    artifactId: string,
    options: { actor?: string } = {}
  ): Promise<{ blobKey: string | null; blobRemoved: boolean }> {
    return this.retention.deleteArtifact(artifactId, options);
  }

  retentionSweep(options: {
    olderThanDays: number;
    dryRun?: boolean;
    maxDelete?: number;
    actor?: string;
  }): ReturnType<ArtifactRetention["retentionSweep"]> {
    return this.retention.retentionSweep(options);
  }

  orphanSweep(
    options: { dryRun?: boolean; maxDelete?: number } = {}
  ): ReturnType<ArtifactRetention["orphanSweep"]> {
    return this.retention.orphanSweep(options);
  }
}
