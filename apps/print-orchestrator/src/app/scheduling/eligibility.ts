import type { PrintTask } from "../../domain/print/types";
import {
  evaluateDispatchEligibility,
  type DeviceFileIdentity,
  type DispatchEligibility,
  type DispatchFacts,
  type DispatchMode,
  type DispatchReservation
} from "../../domain/dispatch/eligibility";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import type { SchedulerContext } from "./context";
import type { EvidenceResolver } from "./evidence";
import type { SchedulerPrinterRef } from "./types";

/** Everything the caller knows that the store does not — the here-and-now of a start. */
export interface EligibilityRequest {
  taskId: string;
  printerId: string;
  mode: DispatchMode;
  /** How far the on-device file check got. Defaults to `unchecked` (a preview). */
  deviceFileIdentity?: DeviceFileIdentity;
  /** The path the dispatch would actually start, when it differs from the task hint. */
  file?: string | null;
  /** Whether that path passes `normalizeStartablePath`. */
  filePathValid?: boolean;
  /** An unresolved durable start guard on the printer, when the caller sees one. */
  startGuard?: { file: string; state: string } | null;
  /** Live active run holding the printer, when the caller has re-read it. */
  activeRun?: { id: string; state: string } | null;
  /** Whether the printer's verified auto-clearing hardware is enabled. */
  automaticContinuationAllowed?: boolean;
}

/**
 * The one place the three call sites of the brief (preview, plan confirmation,
 * physical dispatch) obtain a {@link DispatchEligibility}.
 *
 * It resolves evidence through the *same* {@link EvidenceResolver} the
 * compatibility matrix and the planner use, then hands it to the pure
 * {@link evaluateDispatchEligibility}. There is deliberately no second
 * resolution path: a rule added to the domain is live in all three places at
 * once, and preview/plan/dispatch cannot disagree about why something is refused.
 */
export class EligibilityQueries {
  constructor(
    private readonly ctx: SchedulerContext,
    private readonly evidence: EvidenceResolver
  ) {}

  /** Eligibility for one (task, printer) as the caller sees the world right now. */
  evaluate(request: EligibilityRequest): DispatchEligibility {
    const repos = this.ctx.store.repositories;
    const task = repos.tasks.getById(request.taskId);
    if (!task) {
      throw new Error(`Задание «${request.taskId}» не найдено`);
    }
    const printer = this.ctx.listPrinters().find((p) => p.id === request.printerId);
    if (!printer) {
      throw new Error(`Принтер «${request.printerId}» не найден в конфигурации фермы`);
    }
    return this.evaluateFor(task, printer, request);
  }

  /** Same rule set, for a task/printer the caller has already resolved. */
  evaluateFor(
    task: PrintTask,
    printer: SchedulerPrinterRef,
    request: Omit<EligibilityRequest, "taskId" | "printerId">
  ): DispatchEligibility {
    const repos = this.ctx.store.repositories;
    const resolved = this.evidence.resolveEvidence(task, printer);
    const entry = repos.queue.findByTaskId(task.id);

    const activeRun =
      request.activeRun !== undefined
        ? request.activeRun
        : toRunRef(repos.printRuns.findActiveByPrinter(printer.id));

    const facts: DispatchFacts = {
      mode: request.mode,
      taskState: task.state,
      entryState: entry?.state ?? null,
      night: task.night,
      unattendedAllowed: task.unattendedAllowed,

      file: request.file !== undefined ? request.file : readTaskFile(task, resolved.artifact),
      filePathValid: request.filePathValid ?? true,
      artifact: resolved.artifact
        ? {
            id: resolved.artifact.id,
            sha256: resolved.artifact.sha256,
            sizeBytes: resolved.artifact.sizeBytes,
            updatedAt: resolved.artifact.updatedAt
          }
        : null,
      analysis: resolved.analysis
        ? {
            id: resolved.analysis.id,
            state: resolved.analysis.state,
            verdict: resolved.analysis.verdict,
            detectedFormat: resolved.analysis.detectedFormat,
            blockers: resolved.analysis.blockers,
            analyzerVersion: resolved.analysis.analyzerVersion,
            updatedAt: resolved.analysis.updatedAt,
            declaredTargetPrinter: readString(resolved.analysis.data, "printerModel"),
            declaredGcodeFlavor: readString(resolved.analysis.data, "flavor")
          }
        : null,
      currentAnalyzerVersion: ANALYZER_VERSION,
      deviceFileIdentity: request.deviceFileIdentity ?? "unchecked",

      printerLabels: [printer.name, printer.model ?? "", printer.printerClass ?? ""].filter(
        (l) => l.trim().length > 0
      ),
      printerProtocol: printer.protocol,
      remoteStartSupported: printer.remoteStartSupported,
      liveStatus: { online: printer.online, status: printer.status },
      telemetryAgeMs: printer.telemetryAgeMs,
      activeRun,
      startGuard: request.startGuard ?? repos.startGuards.get(printer.id) ?? null,
      bedState: resolved.evidence.bedCycle,
      automaticContinuationAllowed: request.automaticContinuationAllowed ?? false,

      reservation: this.confirmedReservation(task.id, resolved.variant?.id ?? null),
      targetPrinterId: printer.id,
      sliceVariantId: resolved.variant?.id ?? null,

      etaMinutes: etaMinutesOf(resolved.evidence.sliceEtaS, resolved.evidence.gcodeEtaS),
      nightWindow: this.ctx.config.nightWindow,
      farmTimeZone: this.ctx.config.farmTimeZone,
      nightSafetyBufferRatio: this.ctx.config.nightSafetyBufferRatio,
      now: this.ctx.config.now()
    };

    return evaluateDispatchEligibility({
      preflight: {
        task: resolved.taskInput,
        printer: this.evidence.printerInputFor(printer, resolved.buildVolume),
        evidence: resolved.evidence,
        config: this.ctx.compatibilityConfig
      },
      facts
    });
  }

  /**
   * The confirmed (ACTIVE-plan) assignment this task must be executed under, if
   * any. A `PROPOSED` assignment on a DRAFT plan is *not* a reservation — only a
   * confirmed plan binds a dispatch to a printer.
   */
  private confirmedReservation(taskId: string, sliceVariantId: string | null): DispatchReservation | null {
    const repos = this.ctx.store.repositories;
    for (const assignment of repos.assignments.listByTask(taskId)) {
      if (assignment.state === "CANCELLED" || assignment.state === "RELEASED") continue;
      if (!assignment.planId) continue;
      const plan = repos.plans.getById(assignment.planId);
      if (!plan || plan.state !== "ACTIVE") continue;
      const meta = assignment.metadata as Record<string, unknown>;
      return {
        planId: plan.id,
        assignmentId: assignment.id,
        printerId: assignment.printerId,
        sliceVariantId: readString(meta, "sliceVariantId") ?? sliceVariantId,
        artifactSha256: readString(meta, "artifactSha256"),
        profileRevisionIds: readStringArray(meta, "profileRevisionIds"),
        expectedRemotePath: readString(meta, "expectedRemotePath")
      };
    }
    return null;
  }
}

function toRunRef(run: { id: string; state: string } | null): { id: string; state: string } | null {
  return run ? { id: run.id, state: run.state } : null;
}

/** The on-device file a dispatch would start (task hint first, legacy artifact source second). */
function readTaskFile(
  task: PrintTask,
  artifact: { sha256: string | null; source: string | null } | null
): string | null {
  const metaFile = task.metadata.file;
  if (typeof metaFile === "string" && metaFile.trim()) return metaFile.trim();
  if (artifact && artifact.sha256 === null && artifact.source) return artifact.source;
  return null;
}

/** ETA in whole minutes from the slice/analysis seconds; null when neither is usable. */
function etaMinutesOf(sliceEtaS: number | null, gcodeEtaS: number | null): number | null {
  const seconds = positive(sliceEtaS) ?? positive(gcodeEtaS);
  return seconds === null ? null : Math.ceil(seconds / 60);
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function readString(source: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
