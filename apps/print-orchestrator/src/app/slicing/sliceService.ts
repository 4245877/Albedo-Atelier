import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { assertTransition } from "../../domain/print/states";
import type { AnalysisFinding, ArtifactAnalysis, AuditEntityType, Metadata } from "../../domain/print/types";
import { computeCacheKey } from "../../domain/slicing/cacheKey";
import { finding } from "../../domain/slicing/findings";
import { evaluateSliceOutput } from "../../domain/slicing/outputGate";
import { SLICE_VARIANT_TRANSITIONS } from "../../domain/slicing/states";
import type { ProfileRevision, SliceVariant, SliceVariantState } from "../../domain/slicing/types";
import type { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { SliceRuntimeUnavailableError, type SliceRunner } from "../../infra/slicing/sliceRunner";
import type { StoreLogger } from "../../shared/logger";
import type { ArtifactService } from "../artifacts/artifactService";
import { SliceWorker } from "./sliceWorker";

export interface CreateSliceInput {
  artifactId: string;
  profileSetId: string;
  targetPrinterId?: string | null;
  targetPrinterClass?: string | null;
  actor?: string;
  /** Skip the cache and force a fresh slice. */
  force?: boolean;
}

export interface SliceServiceOptions {
  /** Base directory under which each slice gets its own isolated work dir. */
  tmpRoot: string;
  timeoutMs: number;
  concurrency: number;
  now?: () => Date;
  actor?: string;
  logger?: StoreLogger;
}

/**
 * The slice pipeline (the brief's "Pipeline" section), for STL / generic 3MF.
 *
 * `createSlice` validates the preconditions (a `needs_preparation` analysis, an
 * **approved** set of **active** profiles, a real task) and either returns a cache
 * hit or a `pending` variant queued on the bounded {@link SliceWorker}. `runSlice`
 * (the worker body) then: probes the runtime (no runtime → honest `blocked`, never
 * a fake); copies the model and writes the resolved profile JSONs into an isolated
 * temp dir; spawns OrcaSlicer under a timeout; on success stages the output through
 * the existing {@link ArtifactStorage}, creates an output {@link Artifact} and
 * re-analyses it with the existing analyzer; copies OrcaSlicer's own ETA / filament
 * / dimensions onto the variant; and always cleans up the temp dir. It never
 * touches the source analysis, the legacy queue, or a printer.
 */
export class SliceService {
  private readonly now: () => Date;
  private readonly defaultActor: string;
  private readonly worker: SliceWorker;
  private readonly logger: StoreLogger;

  constructor(
    private readonly store: PrintQueueStore,
    private readonly storage: ArtifactStorage,
    private readonly artifacts: ArtifactService,
    private readonly runner: SliceRunner,
    private readonly options: SliceServiceOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.defaultActor = options.actor ?? "operator";
    this.logger = options.logger ?? {};
    this.worker = new SliceWorker(options.concurrency, (id) => this.runSlice(id), this.logger);
    // The per-slice work dirs are created under this root; ensure it exists once.
    fs.mkdirSync(this.options.tmpRoot, { recursive: true });
  }

  // ── Create ───────────────────────────────────────────────────────────────────

  /** Validates preconditions and creates a variant (cache hit → `ready`; else queued). */
  async createSlice(input: CreateSliceInput): Promise<SliceVariant> {
    const repos = this.store.repositories;
    const actor = input.actor ?? this.defaultActor;

    const artifact = repos.artifacts.getById(input.artifactId);
    if (!artifact) throw new NotFoundError(`Артефакт «${input.artifactId}»`);

    const analysis = repos.artifactAnalyses.latestForArtifact(artifact.id);
    if (!analysis || analysis.state !== "ready" || analysis.verdict !== "needs_preparation") {
      throw new ValidationError(
        "Артефакт не является исходной моделью, готовой к подготовке (нужен успешный анализ с результатом needs_preparation)"
      );
    }

    const set = repos.profileSets.getById(input.profileSetId);
    if (!set) throw new NotFoundError(`Набор профилей «${input.profileSetId}»`);
    if (!set.approved) {
      throw new JobError("Набор профилей не утверждён — сначала утвердите его");
    }

    const machine = this.requireActive(set.machineRevisionId);
    const process = this.requireActive(set.processRevisionId);
    const filament = this.requireActive(set.filamentRevisionId);

    const task = repos.tasks.findByArtifactId(artifact.id);
    if (!task) throw new ValidationError("У артефакта нет связанного задания");

    const orcaVersion = this.runner.pinnedVersion ?? machine.orcaVersion ?? "unknown";
    const cacheKey = computeCacheKey({
      sourceSha256: artifact.sha256 ?? artifact.id,
      machineResolvedSha256: machine.resolvedSha256 ?? machine.rawSha256,
      processResolvedSha256: process.resolvedSha256 ?? process.rawSha256,
      filamentResolvedSha256: filament.resolvedSha256 ?? filament.rawSha256,
      orcaVersion,
      workerVersion: this.runner.workerVersion
    });

    // The slice's target is bound by the APPROVED set — a client cannot silently
    // retarget it. For a printer-scoped set the target IS the set's printer; any
    // conflicting override is refused. For a class-scoped set the client may name a
    // concrete printer, but the class stays the set's (server-derived, never the
    // client's) so a mismatch is caught downstream at schedule/dispatch time.
    const targetPrinterClass = set.printerClass ?? null;
    let targetPrinterId: string | null;
    if (set.printerId) {
      if (input.targetPrinterId && input.targetPrinterId !== set.printerId) {
        throw new ValidationError(
          `Набор профилей привязан к принтеру «${set.printerId}» — запуск на «${input.targetPrinterId}» запрещён`
        );
      }
      targetPrinterId = set.printerId;
    } else {
      targetPrinterId = input.targetPrinterId ?? null;
    }

    // Cache hit: a finished variant with this key whose output blob still exists
    // AND whose output analysis is still clean (schedulable, no blockers) — a stale
    // or since-invalidated result must never be re-served as ready.
    if (!input.force) {
      const cached = repos.sliceVariants.findReadyByCacheKey(cacheKey);
      if (cached?.outputArtifactId && this.cachedOutputStillReady(cached)) {
        const out = repos.artifacts.getById(cached.outputArtifactId);
        if (out?.source && (await this.storage.exists(out.source))) {
          return this.createFromCache(
            { artifact, task, set, cacheKey, orcaVersion, targetPrinterId, targetPrinterClass },
            cached,
            actor
          );
        }
      }
      // Dedup a double-submit: if an identical slice (same cache key AND target) is
      // already queued or running, return it instead of launching OrcaSlicer a
      // second time. Reaching here without a cache hit, the path down to the insert
      // below is synchronous (no `await`), so two rapid POSTs cannot both slip past.
      const inFlight = repos.sliceVariants
        .listInFlightByCacheKey(cacheKey)
        .find(
          (v) => v.targetPrinterId === targetPrinterId && v.targetPrinterClass === targetPrinterClass
        );
      if (inFlight) return inFlight;
    }

    const iso = this.nowIso();
    const variant: SliceVariant = {
      id: newId(ID_PREFIX.sliceVariant),
      taskId: task.id,
      sourceArtifactId: artifact.id,
      profileSetId: set.id,
      targetPrinterId,
      targetPrinterClass,
      state: "pending",
      cacheKey,
      orcaVersion,
      workerVersion: this.runner.workerVersion,
      outputArtifactId: null,
      outputAnalysisId: null,
      orcaEtaS: null,
      filamentG: null,
      filamentMm: null,
      dimensions: null,
      warnings: [],
      blockers: [],
      error: null,
      startedAt: null,
      endedAt: null,
      createdAt: iso,
      updatedAt: iso,
      version: 1,
      metadata: {}
    };
    this.store.transaction(() => {
      repos.sliceVariants.insert(variant);
      this.recordAudit(actor, { entityId: variant.id, action: "created", to: "pending", detail: { cacheKey } });
    });
    this.worker.enqueue(variant.id);
    return variant;
  }

  private createFromCache(
    ctx: {
      artifact: { id: string };
      task: { id: string };
      set: { id: string };
      cacheKey: string;
      orcaVersion: string;
      targetPrinterId: string | null;
      targetPrinterClass: string | null;
    },
    cached: SliceVariant,
    actor: string
  ): SliceVariant {
    const iso = this.nowIso();
    const variant: SliceVariant = {
      id: newId(ID_PREFIX.sliceVariant),
      taskId: ctx.task.id,
      sourceArtifactId: ctx.artifact.id,
      profileSetId: ctx.set.id,
      targetPrinterId: ctx.targetPrinterId,
      targetPrinterClass: ctx.targetPrinterClass,
      state: "ready",
      cacheKey: ctx.cacheKey,
      orcaVersion: ctx.orcaVersion,
      workerVersion: this.runner.workerVersion,
      outputArtifactId: cached.outputArtifactId,
      outputAnalysisId: cached.outputAnalysisId,
      orcaEtaS: cached.orcaEtaS,
      filamentG: cached.filamentG,
      filamentMm: cached.filamentMm,
      dimensions: cached.dimensions,
      warnings: [finding("cache_hit", "Готовый результат переиспользован по cache key")],
      blockers: [],
      error: null,
      startedAt: iso,
      endedAt: iso,
      createdAt: iso,
      updatedAt: iso,
      version: 1,
      metadata: { cacheHitFrom: cached.id }
    };
    this.store.transaction(() => {
      this.store.repositories.sliceVariants.insert(variant);
      this.recordAudit(actor, { entityId: variant.id, action: "cache_hit", to: "ready", detail: { from: cached.id } });
    });
    return variant;
  }

  // ── Rerun / recover ────────────────────────────────────────────────────────

  /** Re-runs a terminal variant by returning it to `pending` and re-queuing it. */
  rerun(variantId: string, actor = this.defaultActor): SliceVariant {
    const repos = this.store.repositories;
    const variant = repos.sliceVariants.getById(variantId);
    if (!variant) throw new NotFoundError(`Вариант слайсинга «${variantId}»`);
    if (variant.state === "pending" || variant.state === "running") return variant;

    // Clear the *entire* result of the previous attempt — not just error/findings
    // but the output link and every OrcaSlicer estimate — before re-queuing. Left
    // behind, a stale outputArtifactId/ETA/filament/dimensions would be shown as if
    // it belonged to the new attempt (and, worse, a re-run that then fails would
    // still surface last time's "ready" output).
    const reset = this.store.transaction(() =>
      this.transition(variant, "pending", actor, "rerun", {
        outputArtifactId: null,
        outputAnalysisId: null,
        orcaEtaS: null,
        filamentG: null,
        filamentMm: null,
        dimensions: null,
        error: null,
        blockers: [],
        warnings: [],
        startedAt: null,
        endedAt: null
      })
    );
    this.worker.enqueue(reset.id);
    return reset;
  }

  /** Re-queues every unfinished variant on startup (crash recovery). */
  recover(): number {
    const repos = this.store.repositories;
    const unfinished = repos.sliceVariants.listUnfinished();
    for (const variant of unfinished) {
      if (variant.state === "running") {
        this.store.transaction(() => {
          const current = repos.sliceVariants.getById(variant.id);
          if (current && current.state === "running") {
            this.transition(current, "pending", "system", "recovered", {});
          }
        });
      }
      this.worker.enqueue(variant.id);
    }
    if (unfinished.length > 0) {
      this.logger.info?.({ recovered: unfinished.length }, "unfinished slice variants re-queued");
    }
    return unfinished.length;
  }

  // ── Worker body (the pipeline) ───────────────────────────────────────────────

  /** Slices one variant end-to-end. Never throws — the worker only logs. */
  async runSlice(variantId: string): Promise<void> {
    const repos = this.store.repositories;
    let variant = repos.sliceVariants.getById(variantId);
    if (!variant || variant.state === "ready" || variant.state === "failed" || variant.state === "blocked") {
      return;
    }

    if (variant.state === "pending") {
      variant = this.store.transaction(() =>
        this.transition(variant as SliceVariant, "running", "orca", "slice_started", {
          startedAt: this.nowIso()
        })
      );
    }

    // The variant is now `running`. From here EVERY failure path — including ones
    // outside the slice call itself (a rejected `probe()`, an unavailable tmpRoot
    // that makes `mkdtemp` fail) — must drive it to a terminal state. Without this
    // outer guard such an error would only be logged by the worker and the variant
    // would stay `running` forever, with the UI polling and offering no retry.
    try {
      await this.runPipeline(variant);
    } catch (error) {
      if (error instanceof SliceRuntimeUnavailableError) {
        this.block(variant.id, "runtime_unavailable", error.message);
      } else {
        this.fail(variant.id, errorMessage(error));
      }
    }
  }

  /**
   * The body of a `running` slice: re-check dependencies, gate on the runtime, then
   * slice → stage → analyse → finalize inside an isolated work dir. Recoverable
   * precondition failures short-circuit to `blocked`; anything thrown (from the
   * runtime probe, the temp dir, the slicer, or staging) propagates to
   * {@link runSlice}, which turns it into a terminal `blocked`/`failed`.
   */
  private async runPipeline(variant: SliceVariant): Promise<void> {
    const repos = this.store.repositories;

    // Re-load and re-check the dependencies (they may have changed since creation).
    const artifact = repos.artifacts.getById(variant.sourceArtifactId);
    if (!artifact?.source) {
      this.block(variant.id, "source_missing", "Исходный артефакт или его файл недоступен");
      return;
    }
    const set = repos.profileSets.getById(variant.profileSetId);
    if (!set || !set.approved) {
      this.block(variant.id, "set_not_approved", "Набор профилей не утверждён");
      return;
    }
    let machine: ProfileRevision;
    let process: ProfileRevision;
    let filament: ProfileRevision;
    try {
      machine = this.requireActive(set.machineRevisionId);
      process = this.requireActive(set.processRevisionId);
      filament = this.requireActive(set.filamentRevisionId);
    } catch (error) {
      this.block(variant.id, "profile_not_active", (error as Error).message);
      return;
    }
    if (!machine.resolvedJson || !process.resolvedJson || !filament.resolvedJson) {
      this.block(variant.id, "profile_unresolved", "Один из профилей набора не разрешён (нет resolved JSON)");
      return;
    }

    // Honest runtime gate — no runtime means a blocker, never a fabricated slice.
    // A `probe()` that *throws* (rather than reporting `available: false`) is an
    // infrastructure error and propagates to runSlice's guard.
    const runtime = await this.runner.probe();
    if (!runtime.available) {
      this.block(variant.id, "runtime_unavailable", runtime.error ?? "OrcaSlicer недоступен");
      return;
    }

    // Creating the isolated work dir can itself fail (tmpRoot removed/unwritable);
    // that error propagates to runSlice so the variant never gets stuck `running`.
    const workDir = await fsp.mkdtemp(path.join(this.options.tmpRoot, "slice-"));
    try {
      const modelName = safeBasename(artifact.name, "model.stl");
      const modelPath = path.join(workDir, modelName);
      await pipeline(this.storage.createReadStream(artifact.source), fs.createWriteStream(modelPath));

      const machineJsonPath = path.join(workDir, "machine.json");
      const processJsonPath = path.join(workDir, "process.json");
      const filamentJsonPath = path.join(workDir, "filament.json");
      await fsp.writeFile(machineJsonPath, machine.resolvedJson, "utf8");
      await fsp.writeFile(processJsonPath, process.resolvedJson, "utf8");
      await fsp.writeFile(filamentJsonPath, filament.resolvedJson, "utf8");

      const outputPath = path.join(workDir, "output.gcode");
      await this.runner.slice(
        { modelPath, machineJsonPath, processJsonPath, filamentJsonPath, outputPath, workDir },
        { timeoutMs: this.options.timeoutMs }
      );

      // Stage + register + analyse the output with the EXISTING artifact pipeline.
      const outName = outputName(artifact.name);
      const { artifact: outArtifact, analysis } = await this.artifacts.ingestOutputFile({
        filePath: outputPath,
        fileName: outName,
        metadata: { sliceVariantId: variant.id, taskId: variant.taskId, sourceArtifactId: artifact.id }
      });

      // The output analysis — not merely the fact a file appeared — decides the
      // variant's terminal state.
      const current = repos.sliceVariants.getById(variant.id) ?? variant;
      this.store.transaction(() => this.finalizeOutput(current, outArtifact.id, analysis));
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch((error) => {
        this.logger.error?.({ err: error, workDir }, "failed to clean up slice work dir");
      });
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  listVariants(): SliceVariant[] {
    return this.store.repositories.sliceVariants.list();
  }

  listByTask(taskId: string): SliceVariant[] {
    return this.store.repositories.sliceVariants.listByTask(taskId);
  }

  getVariant(id: string): SliceVariant {
    const variant = this.store.repositories.sliceVariants.getById(id);
    if (!variant) throw new NotFoundError(`Вариант слайсинга «${id}»`);
    return variant;
  }

  whenIdle(): Promise<void> {
    return this.worker.whenIdle();
  }

  close(): void {
    this.worker.close();
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private requireActive(revisionId: string): ProfileRevision {
    const rev = this.store.repositories.profileRevisions.getById(revisionId);
    if (!rev) throw new JobError(`Профиль «${revisionId}» не найден`);
    if (rev.status !== "active") {
      throw new JobError(`Профиль «${rev.name}» не активен (${rev.status})`);
    }
    return rev;
  }

  /**
   * Decides a sliced variant's terminal state from the OUTPUT analysis, not just
   * the fact a file appeared. The output is `ready` only when its analysis actually
   * completed (`state: "ready"`), reached a `schedulable` verdict, and carries no
   * blocker — the very bar {@link evaluateDispatchGate} enforces before a start.
   * Anything else (analyzer failed/timed out, or a `blocked`/`review`/`needs_input`
   * verdict — e.g. a forbidden config-mutating command like M502/SAVE_CONFIG baked
   * into a profile's start/end G-code) makes the variant `blocked`, with the
   * analysis's own findings copied across so the operator sees exactly why. The
   * output artifact stays linked for inspection, but an unsafe or unverified file
   * can never go `ready`, be dispatched, or be re-served from cache as ready.
   */
  private finalizeOutput(variant: SliceVariant, outputArtifactId: string, analysis: ArtifactAnalysis): void {
    const estimates = {
      outputArtifactId,
      outputAnalysisId: analysis.id,
      orcaEtaS: analysis.estimatedDurationS,
      filamentG: analysis.estimatedFilamentG,
      filamentMm: numberOrNull(analysis.data.filamentUsedMm),
      dimensions: readBbox(analysis.data)
    };
    const gate = evaluateSliceOutput(analysis);
    if (gate.ok) {
      this.transition(variant, "ready", "orca", "sliced", {
        ...estimates,
        warnings: analysis.warnings,
        blockers: [],
        error: null,
        endedAt: this.nowIso()
      });
      this.logger.info?.({ variantId: variant.id, output: outputArtifactId }, "slice completed");
      return;
    }
    this.transition(variant, "blocked", "orca", "output_rejected", {
      ...estimates,
      warnings: analysis.warnings,
      blockers: gate.blockers,
      error: gate.reason,
      endedAt: this.nowIso()
    });
    this.logger.warn?.(
      { variantId: variant.id, output: outputArtifactId, verdict: analysis.verdict, state: analysis.state },
      "slice output rejected — not dispatchable"
    );
  }

  /** A cached ready variant is only reusable if its output analysis is still clean. */
  private cachedOutputStillReady(cached: SliceVariant): boolean {
    if (!cached.outputAnalysisId) return false;
    const analysis = this.store.repositories.artifactAnalyses.getById(cached.outputAnalysisId);
    return Boolean(analysis) && evaluateSliceOutput(analysis as ArtifactAnalysis).ok;
  }

  private block(variantId: string, code: string, message: string): void {
    this.store.transaction(() => {
      const current = this.store.repositories.sliceVariants.getById(variantId);
      if (!current || current.state === "ready" || current.state === "failed" || current.state === "blocked") return;
      this.transition(current, "blocked", "orca", "blocked", {
        blockers: [finding(code, message)],
        error: message,
        endedAt: this.nowIso()
      });
    });
    this.logger.warn?.({ variantId, code }, "slice blocked");
  }

  private fail(variantId: string, message: string): void {
    this.store.transaction(() => {
      const current = this.store.repositories.sliceVariants.getById(variantId);
      if (!current || current.state === "ready" || current.state === "failed" || current.state === "blocked") return;
      this.transition(current, "failed", "orca", "slice_failed", {
        error: message,
        endedAt: this.nowIso()
      });
    });
    this.logger.warn?.({ variantId }, "slice failed");
  }

  private transition(
    variant: SliceVariant,
    to: SliceVariantState,
    actor: string,
    action: string,
    patch: Partial<SliceVariant>
  ): SliceVariant {
    assertTransition("вариант слайсинга", SLICE_VARIANT_TRANSITIONS, variant.state, to);
    const saved = this.store.repositories.sliceVariants.update({
      ...variant,
      ...patch,
      state: to,
      updatedAt: this.nowIso()
    });
    this.recordAudit(actor, { entityId: variant.id, action, from: variant.state, to });
    return saved;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private recordAudit(
    actor: string,
    input: { entityId: string; action: string; from?: string; to?: string; detail?: Metadata }
  ): void {
    const entityType: AuditEntityType = "slice_variant";
    this.store.repositories.audit.insert({
      id: newId(ID_PREFIX.auditEvent),
      at: this.nowIso(),
      entityType,
      entityId: input.entityId,
      action: input.action,
      fromState: input.from ?? null,
      toState: input.to ?? null,
      actor,
      detail: input.detail ?? {}
    });
  }
}

/** Derives an output filename from the source (cube.stl → cube.gcode). */
function outputName(sourceName: string): string {
  const base = sourceName.replace(/\.[^.]+$/, "");
  return `${base || "output"}.gcode`;
}

/** A safe basename for the temp model file (never a path, never empty). */
function safeBasename(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").trim();
  return cleaned || fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Lifts the analyzer's bbox payload into the variant's dimensions object. */
function readBbox(data: Metadata): Metadata | null {
  const bbox = data.bbox;
  if (bbox !== null && typeof bbox === "object" && !Array.isArray(bbox)) {
    return bbox as Metadata;
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Ошибка слайсинга";
}
