import { operationMinutes } from "../../domain/operations/planning";
import { resolveFarmAvailability, type OperatorScheduleInput } from "../../domain/operations/schedule";
import { OPERATION_LABELS } from "../../domain/operations/states";
import { OPEN_OPERATION_STATES } from "../../domain/operations/types";
import type { PrintTask } from "../../domain/print/types";
import {
  evaluateDispatchEligibility,
  type DeviceArtifactFacts,
  type DeviceFileIdentity,
  type DispatchEligibility,
  type DispatchFacts,
  type DispatchMode,
  type DispatchReservation
} from "../../domain/dispatch/eligibility";
import { supportsPrinterUpload } from "../../infra/printers/files";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import { profileRevisionIdsOf, resolveTaskBinding } from "../dispatch/binding";
import { expectedDeviceSize, stalenessOf } from "../dispatch/deviceFileIdentity";
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
  /** Override the protocol-derived "can this adapter upload files?" answer (tests/fakes). */
  adapterUploadSupported?: boolean;
  /** The tracked device file, when the caller already read it; `null` = untracked. */
  deviceArtifact?: DeviceArtifactFacts | null;
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

    const file = request.file !== undefined ? request.file : readTaskFile(task, resolved.artifact);

    const facts: DispatchFacts = {
      mode: request.mode,
      taskState: task.state,
      entryState: entry?.state ?? null,
      night: task.night,
      unattendedAllowed: task.unattendedAllowed,

      file,
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

      ...this.operatorFacts(printer.id),

      reservation: this.confirmedReservation(task.id, resolved.variant?.id ?? null),
      targetPrinterId: printer.id,
      sliceVariantId: resolved.variant?.id ?? null,
      currentProfileRevisionIds: profileRevisionIdsOf(resolveTaskBinding(repos, task).binding),
      adapterUploadSupported:
        request.adapterUploadSupported ?? printerUploadSupported(printer.protocol),
      deviceArtifact:
        request.deviceArtifact !== undefined
          ? request.deviceArtifact
          : this.trackedDeviceFile(
              task,
              printer.id,
              file,
              resolved.variant?.id ?? null,
              printer.protocol
            ),

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
   * The operator half of the facts: the blocking interventions still open on
   * this printer, and where the operator is right now.
   *
   * Read straight from the store rather than injected through the config, on
   * purpose: the eligibility check has exactly one implementation and three call
   * sites (preview, plan confirmation, physical dispatch), and a fact resolved
   * from a *different* source in one of them is precisely the divergence this
   * module was built to remove. A farm with no schedule filled in resolves to
   * `UNKNOWN`, which is the correct, fail-closed initial state.
   */
  private operatorFacts(printerId: string): Pick<
    DispatchFacts,
    "blockingOperations" | "operatorPresence" | "operatorScheduleResolved" | "operatorReason"
  > {
    const repos = this.ctx.store.repositories;
    const blockingOperations = repos.manualOperations
      .listByPrinter(printerId, OPEN_OPERATION_STATES)
      .filter((op) => op.blocking)
      .map((op) => ({
        id: op.id,
        type: op.type,
        state: op.state,
        label: OPERATION_LABELS[op.type],
        minutes: operationMinutes(op)
      }));

    const inputs: OperatorScheduleInput[] = repos.operators.listActive().map((operator) => ({
      operator,
      rules: repos.scheduleRules.listByOperator(operator.id),
      exceptions: repos.scheduleExceptions.listByOperator(operator.id),
      absences: repos.operatorAbsences.listByOperator(operator.id)
    }));
    const availability = resolveFarmAvailability(inputs, this.ctx.config.now());

    return {
      blockingOperations,
      operatorPresence: availability.presence,
      operatorScheduleResolved: availability.resolved,
      operatorReason: availability.reason
    };
  }

  /**
   * The tracked device file for the slot this dispatch would start, with its
   * staleness resolved against what the task *currently* resolves to.
   *
   * The staleness half is why this is not a plain repository read: a row can be
   * `VERIFIED` and still describe a superseded slice, another printer or a
   * profile set that has since been re-imported. Computing it here (rather than
   * trusting the stored state) means a start is refused even if nothing got
   * around to marking the row — the same fail-closed shape as
   * {@link DispatchReservation.stale}.
   */
  private trackedDeviceFile(
    task: PrintTask,
    printerId: string,
    file: string | null,
    sliceVariantId: string | null,
    /** Target adapter — decides whether an on-device size may be compared at all. */
    protocol: string | null
  ): DeviceArtifactFacts | null {
    if (file === null) return null;
    const repos = this.ctx.store.repositories;
    const record = repos.deviceArtifacts.findBySlot(printerId, file);
    if (!record) return null;

    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    const reservation = repos.assignments
      .listByTask(task.id)
      .find(
        (a) =>
          a.state !== "CANCELLED" &&
          a.state !== "RELEASED" &&
          a.invalidatedAt === null &&
          a.printerId === printerId
      );
    const staleReason = stalenessOf(record, {
      printerId,
      remotePath: file,
      sliceVariantId,
      artifactId: artifact?.id ?? null,
      artifactSha256: artifact?.sha256 ?? null,
      // Not `artifact.sizeBytes`: a wrapping adapter (Bambu plate package) puts a
      // different byte count on the device, and comparing the two marked every
      // healthy Bambu delivery stale.
      sizeBytes: expectedDeviceSize(artifact?.sizeBytes, protocol),
      assignmentId: reservation?.id ?? null,
      profileRevisionIds: profileRevisionIdsOf(resolveTaskBinding(repos, task).binding)
    });

    return {
      state: record.state,
      transferMode: record.transferMode,
      verification: record.verification,
      remotePath: record.remotePath,
      lastError: record.lastError,
      stale: staleReason !== null,
      staleReason
    };
  }

  /**
   * The **executable** assignment this task must be run under, if any.
   *
   * Two kinds count, and only these two: an assignment under a confirmed
   * (`ACTIVE`) plan, and an explicit manual placement by an operator. A
   * `PROPOSED` assignment on a *draft* plan is a recommendation, not a
   * reservation — a draft binds nothing. An assignment marked invalidated is
   * likewise not a reservation; it reports itself so the caller refuses rather
   * than quietly falling back to the task's printer hints.
   *
   * The binding comes from typed columns (migration 009) written by plan
   * confirmation and manual assignment. Previously these were read out of
   * `assignment.metadata`, which nothing ever wrote — so every reservation rule
   * below (slice, hash, expected path) was dead code.
   */
  private confirmedReservation(taskId: string, sliceVariantId: string | null): DispatchReservation | null {
    const repos = this.ctx.store.repositories;
    for (const assignment of repos.assignments.listByTask(taskId)) {
      if (assignment.state === "CANCELLED" || assignment.state === "RELEASED") continue;

      let planId: string | null = null;
      if (assignment.planId) {
        const plan = repos.plans.getById(assignment.planId);
        if (!plan || plan.state !== "ACTIVE") continue;
        planId = plan.id;
      } else if (assignment.source !== "manual") {
        continue;
      }

      const b = assignment.binding;
      return {
        planId,
        assignmentId: assignment.id,
        printerId: assignment.printerId,
        sliceVariantId: b.sliceVariantId ?? sliceVariantId,
        artifactSha256: b.artifactSha256,
        profileRevisionIds: [b.machineRevisionId, b.processRevisionId, b.filamentRevisionId].filter(
          (id): id is string => typeof id === "string" && id.length > 0
        ),
        expectedRemotePath: b.expectedRemotePath,
        stale: assignment.invalidatedAt !== null,
        staleReason: assignment.invalidatedReason
      };
    }
    return null;
  }
}

function toRunRef(run: { id: string; state: string } | null): { id: string; state: string } | null {
  return run ? { id: run.id, state: run.state } : null;
}

/** Protocol → "can the orchestrator push a file to it?"; unknown protocols answer no. */
function printerUploadSupported(protocol: string | null): boolean {
  return supportsPrinterUpload(protocol);
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
