import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import {
  selectLaunchPrinter,
  type DeviceFileState,
  type LaunchCandidate,
  type LaunchCandidateInput
} from "../../domain/launch/selection";
import type { Assignment, PrintTask } from "../../domain/print/types";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { CompatibilityReason } from "../../domain/scheduling/compatibility";
import type { PrinterConfig } from "../../infra/printers/config";
import { capabilitiesOf } from "../../infra/printers/capabilities";
import type { DeviceArtifactService } from "../dispatch/deviceArtifactService";
import type { DispatchResult, DispatchService } from "../dispatch/dispatchService";
import type { RunLifecycleService } from "../dispatch/runLifecycle";
import type { ManualOperationService } from "../operations/manualOperationService";
import type { PrintQueueService } from "../printQueue/printQueueService";
import { formatEta } from "../printQueue/projection";
import type { SchedulerService } from "../scheduling/schedulerService";
import { explainLaunchFailure, primaryProblem, type LaunchProblem } from "./problems";

/**
 * The **one** operation behind the "Запустить печать" button.
 *
 * Everything between "the operator chose a job" and "the printer is running it"
 * — picking a printer, uploading the plate package, confirming the bed, sending
 * the start — used to be separate endpoints the UI had to orchestrate in the
 * right order, and the UI did not. The queue button called a dispatch that
 * assumed the file was already delivered; delivering it meant finding the
 * assignment in the slicing screen; and the transport package could only be
 * launched by hunting for it in the printer's file browser. Each step worked;
 * the sequence existed nowhere.
 *
 * It lives here so the sequence is a single audited transaction-of-intent with
 * one idempotency key, rather than a workflow reconstructed by a browser. Two
 * calls make up the whole surface:
 *
 *   - {@link preview} — what would happen, what is missing, which printer and
 *     why. Pure reads: it never uploads, reserves or starts anything.
 *   - {@link launch} — do it, in order, with the operator's confirmations.
 *
 * It adds **no** admission rules of its own. Every refusal still comes from
 * `evaluateCompatibility` and the dispatch gate; this service only sequences the
 * steps and translates the outcome into something an operator can act on.
 */

/** A physical fact only a human can assert, surfaced as a checkbox before start. */
export interface LaunchConfirmation {
  code: "bed_clear" | "material_loaded";
  /** What the operator is agreeing to. */
  label: string;
  detail: string;
  /** True when the launch is refused without it. */
  required: boolean;
}

/** Where a task stands on the road from "prepared" to "printing". */
export type LaunchState =
  /** The artifact is still being analysed/sliced — nothing to launch yet. */
  | "preparing"
  /** A printer is available and every physical precondition is already satisfied. */
  | "ready"
  /** Startable, but a human must confirm something physical first. */
  | "needs_confirmation"
  /** No printer can run this right now, and no confirmation would change that. */
  | "blocked"
  /** A run for this task is already live. */
  | "running"
  /**
   * A start was dispatched and the printer never confirmed it.
   *
   * Deliberately not folded into `running`: the task genuinely was not printing,
   * and calling it "running" is the specific lie that let an operator watch an
   * idle machine while the UI insisted a job was under way. It is also not
   * `blocked`, because the obstacle is a question this operator can answer.
   */
  | "unconfirmed";

export interface LaunchCandidateView extends LaunchCandidate {
  /** Operator-facing rendering of the blockers/reviews/warnings. */
  problems: LaunchProblem[];
}

export interface LaunchPreview {
  taskId: string;
  title: string;
  /** Title without the source extension — what the operator called the model. */
  displayTitle: string;
  state: LaunchState;
  material: string | null;
  nozzleMm: number | null;
  etaSeconds: number | null;
  etaText: string | null;
  filamentG: number | null;
  /** Where the material fact came from, so the UI can say "внешняя катушка". */
  materialSource: "ams" | "external" | "unknown";
  recommendedPrinterId: string | null;
  candidates: LaunchCandidateView[];
  /** Confirmations required for the recommended printer (or the one asked about). */
  confirmations: LaunchConfirmation[];
  /** The live run holding this task, when one exists. */
  activeRunId: string | null;
  /**
   * The single problem to show as *the* reason the launch is refused, or null.
   * Always one of the focused candidate's own `problems`, so the headline the
   * operator reads and the diagnostics list behind it are the same data.
   */
  primaryProblem: LaunchProblem | null;
  /**
   * The run whose outcome is still unresolved and is holding this task, when
   * there is one. The UI turns it into the "отметьте, что произошло" action, so
   * the way out of a failed attempt is where the attempt failed.
   */
  unresolvedRunId: string | null;
}

export interface LaunchRequest {
  /** Explicit operator choice; omitted means "use the recommendation". */
  printerId?: string;
  /** Confirmation codes the operator ticked. */
  confirmations?: string[];
  /** Retry-safe key: the same key never starts a second print. */
  idempotencyKey?: string;
  actor?: string;
}

export interface LaunchOutcome {
  run: DispatchResult;
  printerId: string;
  printerName: string;
  /** Steps actually performed, for the audit trail and the UI's progress copy. */
  steps: string[];
}

export interface LaunchServiceDeps {
  store: PrintQueueStore;
  printQueue: PrintQueueService;
  scheduler: SchedulerService;
  deviceArtifacts: DeviceArtifactService;
  dispatch: () => DispatchService | null;
  runLifecycle: () => RunLifecycleService | null;
  manualOperations: ManualOperationService;
  resolvePrinter: (id: string) => PrinterConfig | undefined;
  automaticContinuationAllowed: (printerId: string) => boolean;
}

export class LaunchService {
  constructor(private readonly deps: LaunchServiceDeps) {}

  // ── Preview ────────────────────────────────────────────────────────────────

  preview(taskId: string, forPrinterId?: string): LaunchPreview {
    const task = this.requireTask(taskId);
    const repos = this.deps.store.repositories;
    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    const analysis = artifact ? repos.artifactAnalyses.latestForArtifact(artifact.id) : null;
    const assignment = this.liveAssignment(task.id);
    const binding = assignment?.binding ?? null;

    const material = binding?.material ?? task.material ?? analysis?.material ?? null;
    const nozzleMm = binding?.nozzleMm ?? analysis?.nozzleDiameterMm ?? null;
    const etaSeconds = binding?.etaS ?? analysis?.estimatedDurationS ?? null;

    const candidates = this.buildCandidates(task, material, nozzleMm);
    const { candidates: ranked, recommendedPrinterId } = selectLaunchPrinter(candidates);
    const views: LaunchCandidateView[] = ranked.map((c) => ({
      ...c,
      problems: explainLaunchFailure(c)
    }));

    const activeRun = repos.printRuns.findActiveByTask(task.id);
    const focusId = forPrinterId ?? recommendedPrinterId;
    const focus = views.find((c) => c.printerId === focusId) ?? null;

    return {
      taskId: task.id,
      title: task.title,
      displayTitle: stripExtension(task.title),
      state: this.resolveState(task, views, recommendedPrinterId, activeRun, focus),
      material,
      nozzleMm,
      etaSeconds,
      etaText: formatEta(etaSeconds),
      filamentG: analysis?.estimatedFilamentG ?? null,
      materialSource: this.materialSourceFor(focus),
      recommendedPrinterId,
      candidates: views,
      confirmations: focus ? this.confirmationsFor(focus, material) : [],
      activeRunId: activeRun?.id ?? null,
      // One cause, chosen from the problems already listed — never a new
      // sentence, so the headline and the diagnostics can never disagree. When
      // nothing is recommended at all, the least-blocked candidate supplies it:
      // "нет подходящего принтера" with no reason is the least useful true
      // statement the screen could make.
      primaryProblem: primaryProblem((focus ?? leastBlocked(views))?.problems ?? []),
      // The exit from an unconfirmed attempt, offered where the operator hits
      // the wall rather than in a separate screen they have no reason to open.
      unresolvedRunId:
        activeRun && activeRun.startedAt === null && activeRun.state !== "RUNNING"
          ? activeRun.id
          : null
    };
  }

  // ── Launch ─────────────────────────────────────────────────────────────────

  /**
   * Runs the whole sequence: choose → assign → deliver → confirm → start.
   *
   * Ordering is deliberate and each step is skipped when already satisfied, so a
   * retry after a lost response re-enters at the right place instead of
   * re-uploading a verified file or opening a second assignment. The physical
   * start is last and goes through `DispatchService`, so the authoritative gate
   * runs against rows re-read inside its own transaction — nothing decided during
   * this method's earlier steps is trusted at the moment of dispatch.
   */
  async launch(taskId: string, request: LaunchRequest = {}): Promise<LaunchOutcome> {
    const dispatch = this.deps.dispatch();
    if (!dispatch) throw new JobError("Служба запуска ещё не инициализирована");

    const actor = request.actor?.trim() || "operator";
    const steps: string[] = [];
    const task = this.requireTask(taskId);

    // 1 ── Choose the printer. An explicit choice is honoured but still admitted
    //      through the same eligibility check; "I picked it" is not an override.
    const preview = this.preview(task.id, request.printerId);
    const chosenId = request.printerId ?? preview.recommendedPrinterId;
    if (!chosenId) {
      throw new JobError(
        "Нет принтера, готового принять это задание",
        { blockers: firstBlockers(preview.candidates) }
      );
    }
    const candidate = preview.candidates.find((c) => c.printerId === chosenId);
    if (!candidate) throw new NotFoundError(`Принтер «${chosenId}»`);
    if (!candidate.eligible) {
      // A safety blocker is not confirmable and not overridable from here: the
      // operator may choose *among* startable printers, never past a refusal.
      throw new JobError(candidate.reason, {
        blockers: candidate.blockers.map((b) => ({ code: b.code, message: b.message }))
      });
    }
    const printer = this.deps.resolvePrinter(chosenId);
    if (!printer) throw new NotFoundError(`Принтер «${chosenId}»`);

    // 2 ── Physical confirmations, before anything is uploaded or reserved.
    const given = new Set(request.confirmations ?? []);
    const required = this.confirmationsFor(candidate, preview.material).filter((c) => c.required);
    const missing = required.filter((c) => !given.has(c.code));
    if (missing.length > 0) {
      throw new ValidationError(
        `Требуется подтверждение: ${missing.map((c) => c.label).join("; ")}`,
        { confirmations: missing }
      );
    }

    // 3 ── The bed. Recorded as an operator assertion *before* the start, so the
    //      dispatch gate sees a real CLEAR cycle rather than being asked to trust
    //      this method's say-so.
    if (given.has("bed_clear")) {
      const lifecycle = this.deps.runLifecycle();
      if (!lifecycle) throw new JobError("Служба запуска ещё не инициализирована");
      lifecycle.clearBed(printer.id, {
        confirmation: "part_removed",
        actor,
        note: `подтверждено при запуске «${task.title}»`,
        automaticContinuationAllowed: this.deps.automaticContinuationAllowed(printer.id)
      });
      steps.push("bed_confirmed");
    }

    // 4 ── An assignment for THIS printer. An existing live one on the same
    //      printer is reused (its binding is the identity the file was built
    //      against); one pointing elsewhere is withdrawn rather than silently
    //      redirected, so the ledger never shows a placement that did not happen.
    const assignment = this.ensureAssignment(task, printer.id, actor, steps);

    // 5 ── Deliver the file. `prepare` is idempotent and reconciles against the
    //      device: a VERIFIED copy is left alone, a stale or missing one is
    //      (re-)uploaded. This is the step the old UI made the operator do by
    //      hand in the printer's file browser.
    const delivery = await this.deps.deviceArtifacts.prepare(assignment.id, actor);
    if (!delivery.ready) {
      // Not ready means either a transfer that did not verify, or an adapter that
      // cannot upload at all — in which case `manualInstruction` tells the
      // operator exactly what to copy where, and is far more useful than the state name.
      throw new JobError(
        delivery.manualInstruction ??
          `Файл не подтверждён на принтере «${printer.name}» (${delivery.deviceArtifact.state}) — запуск отменён`,
        {
          blockers: [
            { code: "device_file_unverified", message: delivery.deviceArtifact.state }
          ]
        }
      );
    }
    steps.push("file_verified_on_device");

    // 6 ── Start. The idempotency key is the caller's, so a double click or a
    //      refresh-and-retry returns the original run instead of a second print.
    const run = await dispatch.startAssignment(assignment.id, {
      mode: "manual",
      actor,
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {})
    });
    steps.push(run.deduplicated ? "already_started" : "started");

    return { run, printerId: printer.id, printerName: printer.name, steps };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private requireTask(taskId: string): PrintTask {
    const task = this.deps.store.repositories.tasks.getById(taskId);
    if (!task) throw new NotFoundError(`Задание «${taskId}»`);
    return task;
  }

  /** The newest assignment that still describes a real placement. */
  private liveAssignment(taskId: string): Assignment | null {
    return (
      this.deps.store.repositories.assignments
        .listByTask(taskId)
        .filter(
          (a) => a.invalidatedAt === null && a.state !== "CANCELLED" && a.state !== "RELEASED"
        )
        .at(-1) ?? null
    );
  }

  private ensureAssignment(
    task: PrintTask,
    printerId: string,
    actor: string,
    steps: string[]
  ): Assignment {
    const existing = this.liveAssignment(task.id);
    if (existing && existing.printerId === printerId) {
      steps.push("assignment_reused");
      return existing;
    }
    if (existing) {
      this.deps.printQueue.invalidateAssignment(
        existing.id,
        `оператор выбрал другой принтер (${printerId})`
      );
      steps.push("assignment_replaced");
    }
    const created = this.deps.printQueue.assignTask(
      task.id,
      printerId,
      { reason: "запуск из очереди" },
      actor
    );
    steps.push("assignment_created");
    return created;
  }

  /** What the device already holds for this (printer, task). */
  private deviceFileStateFor(task: PrintTask, printerId: string): DeviceFileState {
    const assignment = this.liveAssignment(task.id);
    if (!assignment || assignment.printerId !== printerId) return "missing";
    const record = this.deps.deviceArtifacts.forAssignment(assignment);
    if (!record) return "missing";
    // The artifact the task points at *now* decides staleness: a copy verified
    // against a superseded slice is not a copy of this job.
    if (task.artifactId && record.artifactId !== task.artifactId) return "stale";
    if (record.state === "VERIFIED") return "verified";
    if (record.state === "PRESENT_UNVERIFIED") return "unverified";
    return "missing";
  }

  private buildCandidates(
    task: PrintTask,
    requiredMaterial: string | null,
    requiredNozzleMm: number | null
  ): LaunchCandidateInput[] {
    const openByPrinter = this.openQueueDepth();
    return this.deps.scheduler.compatibilityForTask(task).map(({ printer, result }) => {
      const config = this.deps.resolvePrinter(printer.id);
      return {
        printerId: printer.id,
        printerName: printer.name,
        verdict: result.verdict,
        blockers: result.blockers,
        reviews: result.reviews,
        warnings: result.warnings,
        online: printer.online,
        status: printer.status,
        loadedMaterial: printer.material,
        requiredMaterial,
        printerNozzleMm: printer.nozzleMm,
        requiredNozzleMm,
        deviceFile: this.deviceFileStateFor(task, printer.id),
        queueLength: openByPrinter.get(printer.id) ?? 0,
        pendingManualOperations: this.deps.manualOperations.openBlockingFor(printer.id).length,
        remoteStartSupported:
          printer.remoteStartSupported && (config ? capabilitiesOf(config).supportsUpload : false)
      };
    });
  }

  /** Open queue rows already pointing at each printer — the tie-break depth. */
  private openQueueDepth(): Map<string, number> {
    const depth = new Map<string, number>();
    for (const row of this.deps.printQueue.listOpenQueue()) {
      const target = row.task.pinnedPrinterId ?? row.task.targetPrinter;
      if (!target) continue;
      depth.set(target, (depth.get(target) ?? 0) + 1);
    }
    return depth;
  }

  /**
   * The physical facts a human must assert for this candidate.
   *
   * Derived from the *reviews* the compatibility check produced, never invented
   * here: a confirmation exists precisely when there is an open question the
   * operator can close. Asking every time regardless — the reflex that trains
   * people to click through safety prompts — is what the `required` flag avoids:
   * a bed already tracked CLEAR and a material read from live telemetry produce
   * no checkbox at all.
   */
  private confirmationsFor(
    candidate: LaunchCandidate,
    requiredMaterial: string | null
  ): LaunchConfirmation[] {
    const out: LaunchConfirmation[] = [];
    const codes = new Set(candidate.reviews.map((r) => r.code));

    if (codes.has("bed_unknown") || codes.has("bed_awaiting_clearance")) {
      out.push({
        code: "bed_clear",
        label: "Стол свободен",
        detail: codes.has("bed_awaiting_clearance")
          ? "На столе осталась готовая модель — снимите её перед запуском."
          : "Система не знает, что сейчас на столе. Проверьте, что он пуст.",
        required: true
      });
    }

    // Only when the material genuinely cannot be read. A printer reporting its
    // filament over telemetry has already answered this question.
    if (requiredMaterial && candidate.loadedMaterial === null) {
      out.push({
        code: "material_loaded",
        label: `Установлен ${requiredMaterial}`,
        detail: `Принтер не сообщает загруженный материал. Убедитесь, что заправлен ${requiredMaterial}.`,
        required: true
      });
    }

    return out;
  }

  /** Whether the material fact comes from an AMS, an external spool, or nowhere. */
  private materialSourceFor(candidate: LaunchCandidateView | null): "ams" | "external" | "unknown" {
    if (!candidate || candidate.loadedMaterial === null) return "unknown";
    const config = this.deps.resolvePrinter(candidate.printerId);
    if (!config) return "unknown";
    // A printer reporting a material with no AMS unit is running a single
    // external spool — worth saying plainly rather than showing an empty slot list.
    return this.deps.scheduler
      .listPrinterRefs()
      .find((p) => p.id === candidate.printerId)?.ams === true
      ? "ams"
      : "external";
  }

  private resolveState(
    task: PrintTask,
    candidates: LaunchCandidateView[],
    recommendedPrinterId: string | null,
    activeRun: { state: string; startedAt: string | null } | null,
    focus: LaunchCandidateView | null
  ): LaunchState {
    // A dispatched start the printer never confirmed. Reported as itself rather
    // than as `running`, because the physical truth is that nothing is printing
    // — and because the operator's next action (resolve the attempt) is
    // different from anything they would do about a live print.
    if (
      activeRun &&
      activeRun.startedAt === null &&
      (activeRun.state === "PENDING" || activeRun.state === "UNKNOWN")
    ) {
      return "unconfirmed";
    }
    if (activeRun || task.state === "PRINTING" || task.state === "DISPATCHING") return "running";
    // DRAFT is the pre-queue state: the artifact is still being analysed/sliced,
    // so there is nothing to launch yet and no printer choice to explain.
    if (task.state === "DRAFT") return "preparing";
    const startable = focus ?? candidates.find((c) => c.printerId === recommendedPrinterId) ?? null;
    if (!startable || !startable.eligible) return "blocked";
    return this.confirmationsFor(startable, null).some((c) => c.required) ||
      startable.reviews.length > 0
      ? "needs_confirmation"
      : "ready";
  }
}

/** The candidate closest to being startable — the most useful "why not". */
function leastBlocked(candidates: LaunchCandidateView[]): LaunchCandidateView | null {
  return [...candidates].sort((a, b) => a.blockers.length - b.blockers.length)[0] ?? null;
}

/** The blockers of the least-blocked candidate — the most useful "why not". */
function firstBlockers(candidates: LaunchCandidateView[]): CompatibilityReason[] {
  return leastBlocked(candidates)?.blockers ?? [];
}

/** `3U-default.3mf` → `3U-default`. The operator named the model, not the container. */
function stripExtension(title: string): string {
  return title.replace(/\.(gcode\.3mf|3mf|stl|gcode|gco|g)$/i, "");
}
