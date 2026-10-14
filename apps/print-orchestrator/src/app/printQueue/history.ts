import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { newDraftTask } from "../../domain/print/draftTask";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  evaluateReprint,
  evaluateVariantReprint,
  FINISHED_TASK_STATES,
  isFinishedTask,
  reprepareHint,
  type ReprepareHint,
  type ReprintFacts,
  type ReprintRoute,
  type ReprintVerdict
} from "../../domain/print/reprint";
import type {
  Artifact,
  ArtifactAnalysis,
  AuditEntityType,
  Metadata,
  PrintRun,
  PrintTask,
  PrintTaskState
} from "../../domain/print/types";
import { finding } from "../../domain/slicing/findings";
import { readPinnedSliceScale } from "../../domain/slicing/sliceScaleProvenance";
import type { SliceVariant } from "../../domain/slicing/types";
import { recordAuditEvent } from "../audit";
import { isAnalysisCurrent } from "../artifacts/analyzers";
import type { PrintQueueService, TaskDetail } from "./printQueueService";

/**
 * **История печати и повтор.**
 *
 * The read side answers «что, где, чем и с каким итогом печаталось» for every
 * finished print, with the settings it was made with — the printer, the recipe
 * (profile set and its three pinned revisions), the scale the model was cut at —
 * and, per entry, what can be done with it now: print the same verified file
 * again, retry a failed attempt, or prepare the source model anew with the same
 * recipe. Those answers come from the same domain rules the commands enforce
 * ({@link evaluateReprint}), so the screen never offers a button the server is
 * going to refuse.
 *
 * The write side is the reprint: a NEW task for the same bytes, admitted by the
 * promotion/enqueue paths every fresh job takes. The finished print is never
 * reopened or edited — it gains one audit line, `reprinted`, naming the new
 * task, and that is how history shows «повторена».
 */

/** Default and maximum page sizes for the history listing. */
const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

/** Longest accepted client request id (idempotency key). */
const REQUEST_ID_MAX = 120;

export interface HistoryQuery {
  limit?: number;
  /** Opaque cursor from a previous page's {@link HistoryPage.nextCursor}. */
  cursor?: string | null;
  /** Only this terminal state. */
  state?: PrintTaskState | null;
  /** Only prints that ran on this printer. */
  printerId?: string | null;
}

export interface HistoryRun {
  id: string;
  printerId: string;
  printerName: string;
  state: PrintRun["state"];
  startedAt: string | null;
  endedAt: string | null;
  durationS: number | null;
  filamentUsedG: number | null;
}

/**
 * The settings a sliced print was made with — recorded at slicing time on the
 * variant and its pinned profile revisions, so they are what was actually used,
 * not what the recipe happens to say today.
 */
export interface HistoryRecipe {
  variantId: string;
  profileSetId: string;
  profileSetName: string | null;
  /** Approved and not quarantined NOW — i.e. whether «Новая печать» will offer it again. */
  profileSetUsable: boolean;
  machine: string | null;
  process: string | null;
  filament: string | null;
  targetPrinterId: string | null;
  targetPrinterClass: string | null;
  /** The factor the model was cut at (1 for millimetres), when it was pinned. */
  scaleFactor: number | null;
  orcaVersion: string | null;
  /** OrcaSlicer's own predicted time and filament for this slice. */
  etaS: number | null;
  filamentG: number | null;
}

export interface HistoryAction {
  allowed: boolean;
  /** Stable refusal key ({@link ReprintVerdict}); null when allowed. */
  code: string | null;
  reason: string | null;
}

export interface HistoryEntry {
  taskId: string;
  title: string;
  state: PrintTaskState;
  /** Why it ended where it did (failure cause, cancel reason), when recorded. */
  reason: string | null;
  createdAt: string;
  /** When the print was closed (the terminal transition). */
  closedAt: string;
  material: string | null;
  /** The latest run — what physically happened last. Null when it never reached a printer. */
  run: HistoryRun | null;
  runCount: number;
  /** The file that was (to be) printed. */
  file: { artifactId: string; name: string; sha256: string | null; sizeBytes: number | null } | null;
  /** The model it was sliced from, while that model is still stored. */
  source: { artifactId: string; name: string } | null;
  recipe: HistoryRecipe | null;
  lineage: {
    /** The finished print this one repeated. */
    reprintOf: string | null;
    /** The earlier print of the same model this preparation followed. */
    previousTaskId: string | null;
    /** New prints made from this one, oldest first. */
    reprintedAs: string[];
  };
  actions: {
    /** «Напечатать ещё раз» — a new print of the same verified file. */
    reprint: HistoryAction & { route: ReprintRoute | null };
    /** «Повторить» — a FAILED print back into the queue as the same job. */
    retry: HistoryAction;
    /** «Подготовить заново» — the wizard pre-filled with the source and the recipe. */
    reprepare: ReprepareHint | null;
  };
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Pass back as `cursor` for the next (older) page; null on the last one. */
  nextCursor: string | null;
}

export interface ReprintResult {
  /** The new print's whole chain, as `GET /tasks/:id` returns it. */
  detail: TaskDetail;
  route: ReprintRoute;
  /** True when this request id already produced this print — nothing new was created. */
  deduplicated: boolean;
}

export interface PrintHistoryDeps {
  store: PrintQueueStore;
  printQueue: PrintQueueService;
  /** Whether a storage key still resolves to bytes; never throws for a well-formed key. */
  blobExists: (key: string) => Promise<boolean>;
  /** Operator-facing printer name for an id; null when the printer is not configured. */
  printerName: (printerId: string) => string | null;
  now?: () => Date;
  actor?: string;
}

export class PrintHistory {
  private readonly now: () => Date;
  private readonly defaultActor: string;

  constructor(private readonly deps: PrintHistoryDeps) {
    this.now = deps.now ?? (() => new Date());
    this.defaultActor = deps.actor ?? "operator";
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  async list(query: HistoryQuery = {}): Promise<HistoryPage> {
    const limit = clampLimit(query.limit);
    const state = query.state ?? null;
    if (state !== null && !isFinishedTask(state)) {
      throw new ValidationError(
        `Фильтр «state» принимает только завершённые состояния: ${FINISHED_TASK_STATES.join(", ")}`
      );
    }
    const before = parseCursor(query.cursor ?? null);
    const tasks = this.deps.store.repositories.tasks.listFinished({
      limit: limit + 1,
      before,
      states: state ? [state] : undefined,
      printerId: query.printerId?.trim() || null
    });
    const page = tasks.slice(0, limit);
    const entries = await Promise.all(page.map((task) => this.entryFor(task)));
    const last = page.at(-1);
    return {
      entries,
      nextCursor: tasks.length > limit && last ? formatCursor(last) : null
    };
  }

  /** One history entry, by task id — for a print the listing has not paged to. */
  async entry(taskId: string): Promise<HistoryEntry> {
    return this.entryFor(this.requireTask(taskId));
  }

  private async entryFor(task: PrintTask): Promise<HistoryEntry> {
    const repos = this.deps.store.repositories;
    const stored = await this.storedState(task.artifactId);
    const facts = this.reprintFacts(task, stored);
    const verdict = evaluateReprint(facts);

    const runs = repos.printRuns.listByTask(task.id);
    const last = latestRun(runs);
    const source =
      task.sourceArtifactId && task.sourceArtifactId !== task.artifactId
        ? repos.artifacts.getById(task.sourceArtifactId)
        : null;
    const sourceAnalysis = source ? repos.artifactAnalyses.latestForArtifact(source.id) : null;
    // A task closed while still a model has the model as its executable: the
    // source to prepare again is the task's own file.
    const preparable = source ?? (facts.analysis?.verdict === "needs_preparation" ? facts.executable : null);
    const preparableAnalysis = source ? sourceAnalysis : preparable ? facts.analysis : null;
    // The recipe to offer: the slice the print was made from, or — for a print
    // closed before promotion — the newest slice made for it (ready first).
    const made = facts.variant ? [] : repos.sliceVariants.listByTask(task.id);
    const hintVariant = facts.variant ?? made.find((v) => v.state === "ready") ?? made[0] ?? null;

    const reprintedAs = repos.audit
      .listByEntity("print_task", task.id)
      .filter((event) => event.action === "reprinted")
      .map((event) => event.detail.newTaskId)
      .filter((id): id is string => typeof id === "string");

    const file = facts.executable;
    return {
      taskId: task.id,
      title: task.title,
      state: task.state,
      reason: task.reason,
      createdAt: task.createdAt,
      closedAt: task.updatedAt,
      material: task.material ?? facts.analysis?.material ?? null,
      run: last ? this.runView(last) : null,
      runCount: runs.length,
      file: file
        ? { artifactId: file.id, name: file.name, sha256: file.sha256, sizeBytes: file.sizeBytes }
        : null,
      source: source ? { artifactId: source.id, name: source.name } : null,
      recipe: facts.variant ? this.recipeOf(facts.variant) : null,
      lineage: {
        reprintOf: stringOrNull(task.metadata.reprintOf),
        previousTaskId: stringOrNull(task.metadata.previousTaskId),
        reprintedAs
      },
      actions: {
        reprint: verdict.ok
          ? { allowed: true, code: null, reason: null, route: verdict.route }
          : { allowed: false, code: verdict.code, reason: verdict.reason, route: null },
        retry:
          task.state !== "FAILED"
            ? { allowed: false, code: "not_failed", reason: "повторить попытку можно только неудавшуюся печать" }
            : verdict.ok
              ? { allowed: true, code: null, reason: null }
              : { allowed: false, code: verdict.code, reason: verdict.reason },
        reprepare: reprepareHint({
          source: preparable,
          sourceAnalysis: preparableAnalysis,
          variant: hintVariant,
          lastPrinterId: last?.printerId ?? null
        })
      }
    };
  }

  private runView(run: PrintRun): HistoryRun {
    return {
      id: run.id,
      printerId: run.printerId,
      printerName: this.deps.printerName(run.printerId) ?? run.printerId,
      state: run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationS: run.durationS,
      filamentUsedG: run.filamentUsedG
    };
  }

  private recipeOf(variant: SliceVariant): HistoryRecipe {
    const repos = this.deps.store.repositories;
    const set = repos.profileSets.getById(variant.profileSetId);
    const name = (id: string | undefined) => (id ? (repos.profileRevisions.getById(id)?.name ?? null) : null);
    return {
      variantId: variant.id,
      profileSetId: variant.profileSetId,
      profileSetName: set?.name ?? null,
      profileSetUsable: Boolean(set && set.approved && set.validation !== "blocked"),
      machine: name(set?.machineRevisionId),
      process: name(set?.processRevisionId),
      filament: name(set?.filamentRevisionId),
      targetPrinterId: variant.targetPrinterId,
      targetPrinterClass: variant.targetPrinterClass,
      scaleFactor: readPinnedSliceScale(variant)?.factor ?? null,
      orcaVersion: variant.orcaVersion,
      etaS: variant.orcaEtaS,
      filamentG: variant.filamentG
    };
  }

  // ── Reprint ─────────────────────────────────────────────────────────────────

  /**
   * «Напечатать ещё раз»: a new print of a finished task's own verified file.
   *
   * `requestId` makes it retry-safe: the same id for the same task answers with
   * the print it already created instead of creating a second one.
   */
  async reprintTask(
    taskId: string,
    options: { requestId?: string | null; actor?: string } = {}
  ): Promise<ReprintResult> {
    const actor = options.actor?.trim() || this.defaultActor;
    const requestId = normalizeRequestId(options.requestId);
    const task = this.requireTask(taskId);

    const prior = requestId ? this.priorReprint(task.id, requestId) : null;
    if (prior) return prior;
    // The only await: whether the bytes are still in storage. Everything the
    // decision rests on is re-read inside the transaction below.
    const stored = await this.storedState(task.artifactId);

    return this.deps.store.transaction(() => {
      const again = requestId ? this.priorReprint(task.id, requestId) : null;
      if (again) return again;
      const fresh = this.requireTask(taskId);
      const facts = this.reprintFacts(fresh, stored);
      const verdict = evaluateReprint(facts);
      if (!verdict.ok) {
        throw new JobError(`Нельзя повторить «${fresh.title}»: ${verdict.reason}`, {
          code: verdict.code,
          taskId: fresh.id
        });
      }
      const detail =
        verdict.route === "variant"
          ? this.printVariantAgain(facts.variant as SliceVariant, facts.analysis as ArtifactAnalysis, fresh, requestId, actor)
          : this.printExecutableAgain(facts.executable as Artifact, fresh, requestId, actor);
      this.audit({
        entityType: "print_task",
        entityId: fresh.id,
        action: "reprinted",
        actor,
        detail: { newTaskId: detail.task.id, route: verdict.route, ...(requestId ? { requestId } : {}) }
      });
      return { detail, route: verdict.route, deduplicated: false };
    });
  }

  /**
   * A new print from a ready slice variant, whatever became of the task it was
   * sliced for — the slicing screen's way to reuse a verified G-code whose own
   * task is closed or was promoted onto another slice. A variant whose task can
   * still take it is promoted instead (`POST /slicing/variants/:id/promote`).
   */
  async reprintVariant(
    variantId: string,
    options: { requestId?: string | null; actor?: string } = {}
  ): Promise<ReprintResult> {
    const actor = options.actor?.trim() || this.defaultActor;
    const requestId = normalizeRequestId(options.requestId);
    const repos = this.deps.store.repositories;
    const variant = repos.sliceVariants.getById(variantId);
    if (!variant) throw new NotFoundError(`Вариант слайсинга «${variantId}»`);

    const prior = requestId ? this.priorVariantReprint(variant.id, requestId) : null;
    if (prior) return prior;
    const stored = await this.storedState(variant.outputArtifactId);

    return this.deps.store.transaction(() => {
      const again = requestId ? this.priorVariantReprint(variant.id, requestId) : null;
      if (again) return again;
      const fresh = repos.sliceVariants.getById(variantId);
      if (!fresh) throw new NotFoundError(`Вариант слайсинга «${variantId}»`);
      const owner = repos.tasks.getById(fresh.taskId);
      // A variant its own task can still take is a promotion, not a new print:
      // creating a second task next to a draft that is waiting for exactly this
      // slice would leave the draft behind as clutter.
      if (owner && owner.sliceVariantId !== fresh.id && isPromotable(owner.state)) {
        throw new JobError(
          `Вариант ещё можно поставить в очередь как задание «${owner.title}» — используйте «Добавить в очередь»`,
          { code: "promote_instead", taskId: owner.id }
        );
      }
      const output = fresh.outputArtifactId ? repos.artifacts.getById(fresh.outputArtifactId) : null;
      const analysis = output ? repos.artifactAnalyses.latestForArtifact(output.id) : null;
      const verdict = evaluateVariantReprint({
        variant: fresh,
        executable: output,
        stored,
        analysis,
        analysisCurrent: analysis ? isAnalysisCurrent(analysis.analyzerVersion, analysis.detectedFormat) : false
      });
      if (!verdict.ok) {
        throw new JobError(`Нельзя напечатать этот вариант: ${verdict.reason}`, {
          code: verdict.code,
          variantId: fresh.id
        });
      }
      const detail = this.printVariantAgain(fresh, analysis as ArtifactAnalysis, owner, requestId, actor);
      this.audit({
        entityType: "slice_variant",
        entityId: fresh.id,
        action: "reprinted",
        actor,
        detail: { newTaskId: detail.task.id, ...(requestId ? { requestId } : {}) }
      });
      if (owner) {
        this.audit({
          entityType: "print_task",
          entityId: owner.id,
          action: "reprinted",
          actor,
          detail: { newTaskId: detail.task.id, route: "variant", variantId: fresh.id }
        });
      }
      return { detail, route: "variant" as const, deduplicated: false };
    });
  }

  /**
   * The `variant` route: a new draft for the source model, a copy of the ready
   * variant (same output artifact, same pinned scale and profile set), then the
   * ordinary promotion — inside the caller's transaction, so a refusal anywhere
   * leaves no draft and no copy behind.
   */
  private printVariantAgain(
    variant: SliceVariant,
    analysis: ArtifactAnalysis,
    base: PrintTask | null,
    requestId: string | null,
    actor: string
  ): TaskDetail {
    const repos = this.deps.store.repositories;
    const iso = this.now().toISOString();
    const source = repos.artifacts.getById(variant.sourceArtifactId);
    if (!source) {
      throw new JobError("исходная модель варианта не найдена — подготовьте модель заново", {
        code: "file_missing",
        variantId: variant.id
      });
    }
    const task = this.insertDraft(source, base, iso, { fromVariantId: variant.id }, requestId, actor);
    const copy: SliceVariant = {
      ...variant,
      id: newId(ID_PREFIX.sliceVariant),
      taskId: task.id,
      // The output's analysis as it stands now — promotion admits on it.
      outputAnalysisId: analysis.id,
      warnings: [
        ...variant.warnings.filter((w) => w.code !== "cache_hit" && w.code !== "reprint"),
        finding("reprint", "Повтор проверенного G-code — тот же файл, без новой нарезки")
      ],
      blockers: [],
      error: null,
      startedAt: iso,
      endedAt: iso,
      createdAt: iso,
      updatedAt: iso,
      version: 1,
      // The pinned scale travels with it: the dispatch compares it against the
      // source model's confirmation as it stands at launch time.
      metadata: { ...variant.metadata, reprintOf: variant.id }
    };
    repos.sliceVariants.insert(copy);
    this.audit({
      entityType: "slice_variant",
      entityId: copy.id,
      action: "created",
      to: "ready",
      actor,
      detail: { via: "reprint", from: variant.id, outputArtifactId: variant.outputArtifactId }
    });
    return this.deps.printQueue.promoteSliceVariant(copy.id, {}, actor);
  }

  /** The `executable` route: the file itself, queued exactly as an upload would be. */
  private printExecutableAgain(
    file: Artifact,
    base: PrintTask,
    requestId: string | null,
    actor: string
  ): TaskDetail {
    const task = this.insertDraft(file, base, this.now().toISOString(), {}, requestId, actor);
    return this.deps.printQueue.enqueueExecutableArtifact(task.id, { material: base.material }, actor);
  }

  /**
   * The new print's draft. It inherits what the operator said about the JOB —
   * its title, material and priority — and none of the per-print decisions:
   * time window, deadline, printer pin and the unattended permission are asked
   * again, because "may this run with nobody there" is a decision about one
   * print, not a property of a model.
   */
  private insertDraft(
    artifact: Artifact,
    base: PrintTask | null,
    iso: string,
    extra: Metadata,
    requestId: string | null,
    actor: string
  ): PrintTask {
    const repos = this.deps.store.repositories;
    const draft = newDraftTask({
      artifact,
      iso,
      title: base?.title ?? artifact.name,
      metadata: {
        source: "reprint",
        ...(base ? { reprintOf: base.id } : {}),
        ...extra,
        ...(requestId ? { requestId } : {})
      }
    });
    const task: PrintTask = {
      ...draft,
      material: base?.material ?? null,
      priority: base?.priority ?? 0
    };
    repos.tasks.insert(task);
    this.audit({
      entityType: "print_task",
      entityId: task.id,
      action: "created",
      to: task.state,
      actor,
      detail: { via: "reprint", reprintOf: base?.id ?? null, artifactId: artifact.id, ...extra }
    });
    return task;
  }

  /** What a previous request with this id already did for this task. */
  private priorReprint(taskId: string, requestId: string): ReprintResult | null {
    const repos = this.deps.store.repositories;
    const event = repos.audit
      .listByEntity("print_task", taskId)
      .find((e) => e.action === "reprinted" && e.detail.requestId === requestId);
    const newTaskId = event ? stringOrNull(event.detail.newTaskId) : null;
    if (!newTaskId || !repos.tasks.getById(newTaskId)) return null;
    const route: ReprintRoute = event?.detail.route === "executable" ? "executable" : "variant";
    return { detail: this.deps.printQueue.getTaskDetail(newTaskId), route, deduplicated: true };
  }

  private priorVariantReprint(variantId: string, requestId: string): ReprintResult | null {
    const repos = this.deps.store.repositories;
    const event = repos.audit
      .listByEntity("slice_variant", variantId)
      .find((e) => e.action === "reprinted" && e.detail.requestId === requestId);
    const newTaskId = event ? stringOrNull(event.detail.newTaskId) : null;
    if (!newTaskId || !repos.tasks.getById(newTaskId)) return null;
    return { detail: this.deps.printQueue.getTaskDetail(newTaskId), route: "variant", deduplicated: true };
  }

  // ── Facts ───────────────────────────────────────────────────────────────────

  private reprintFacts(task: PrintTask, stored: boolean | null): ReprintFacts {
    const repos = this.deps.store.repositories;
    const executable = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    const analysis = executable ? repos.artifactAnalyses.latestForArtifact(executable.id) : null;
    return {
      task,
      executable,
      stored,
      analysis,
      analysisCurrent: analysis ? isAnalysisCurrent(analysis.analyzerVersion, analysis.detectedFormat) : false,
      variant: task.sliceVariantId ? repos.sliceVariants.getById(task.sliceVariantId) : null
    };
  }

  /**
   * Whether an artifact's bytes are still stored: null when there is nothing to
   * check (no artifact, or a legacy name-only record whose locator is a path on
   * a printer, not a storage key).
   */
  private async storedState(artifactId: string | null): Promise<boolean | null> {
    if (!artifactId) return null;
    const artifact = this.deps.store.repositories.artifacts.getById(artifactId);
    if (!artifact || !artifact.sha256 || !artifact.source) return null;
    try {
      return await this.deps.blobExists(artifact.source);
    } catch {
      return null;
    }
  }

  private requireTask(taskId: string): PrintTask {
    const task = this.deps.store.repositories.tasks.getById(taskId);
    if (!task) throw new NotFoundError(`Задание «${taskId}»`);
    return task;
  }

  private audit(input: {
    entityType: AuditEntityType;
    entityId: string;
    action: string;
    to?: string;
    actor: string;
    detail?: Metadata;
  }): void {
    recordAuditEvent(this.deps.store, () => this.now().toISOString(), this.defaultActor, input);
  }
}

/** The task states a slice can still be promoted onto (mirrors promotion). */
function isPromotable(state: PrintTaskState): boolean {
  return state === "DRAFT" || state === "QUEUED" || state === "PLANNED" || state === "NEEDS_REVIEW";
}

/** The run that happened last: the newest by start (or creation) time. */
function latestRun(runs: readonly PrintRun[]): PrintRun | null {
  let best: PrintRun | null = null;
  for (const run of runs) {
    if (!best || (run.startedAt ?? run.createdAt) >= (best.startedAt ?? best.createdAt)) best = run;
  }
  return best;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAGE;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(value)));
}

const CURSOR_SEPARATOR = "~";

function formatCursor(task: PrintTask): string {
  return `${task.updatedAt}${CURSOR_SEPARATOR}${task.id}`;
}

function parseCursor(cursor: string | null): { updatedAt: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.indexOf(CURSOR_SEPARATOR);
  const updatedAt = at > 0 ? cursor.slice(0, at) : "";
  const id = at > 0 ? cursor.slice(at + 1) : "";
  if (!updatedAt || !id || Number.isNaN(Date.parse(updatedAt))) {
    throw new ValidationError("Некорректный курсор истории — начните с первой страницы");
  }
  return { updatedAt, id };
}

function normalizeRequestId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  if (trimmed.length > REQUEST_ID_MAX) {
    throw new ValidationError(`«requestId» длиннее ${REQUEST_ID_MAX} символов`);
  }
  return trimmed;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
