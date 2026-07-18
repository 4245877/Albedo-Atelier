import {
  JobError,
  NotFoundError,
  PreviewConflictError,
  ValidationError
} from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import {
  ASSIGNMENT_TRANSITIONS,
  assertTransition,
  BED_CYCLE_TRANSITIONS,
  DISPATCH_ATTEMPT_TRANSITIONS,
  PRINT_RUN_TRANSITIONS,
  PRINT_TASK_TRANSITIONS,
  QUEUE_ENTRY_TRANSITIONS
} from "../../domain/print/states";
import type {
  Assignment,
  AuditEntityType,
  BedCycle,
  DispatchAttempt,
  Metadata,
  PrintRun,
  PrintTask,
  QueueEntry
} from "../../domain/print/types";
import type { PrinterConfig } from "../../infra/printers/config";
import {
  fetchPrinterFiles,
  normalizeStartablePath,
  supportsPrinterFiles,
  type PrinterFilesListing
} from "../../infra/printers/files";
import { supportsPrinterStart, type PrinterLiveStatus } from "../../infra/printers/status";
import type { StoreLogger } from "../../shared/logger";
import { windowLengthMinutes } from "../nightPlanner";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import {
  evaluateDispatchGate,
  resolveDispatchFile,
  type DispatchBlocker,
  type DispatchMode
} from "./dispatchGate";

export interface DispatchRequest {
  taskId: string;
  mode: DispatchMode;
  /** Optimistic preview guard: the task version the operator saw; mismatch → 409. */
  expectedTaskVersion?: number;
  /** Preview identity guard: the artifact hash the operator saw; mismatch → 409. */
  expectedArtifactSha256?: string | null;
  /** Repeating the same key returns the original run — never a second command. */
  idempotencyKey?: string;
  actor?: string;
}

export interface DispatchResult {
  runId: string;
  taskId: string;
  assignmentId: string;
  attemptId: string;
  printerId: string;
  printerName: string;
  file: string;
  /** True when the idempotency key matched an existing run — nothing new was sent. */
  deduplicated: boolean;
}

export interface DispatchDeps {
  store: PrintQueueStore;
  /** Resolves a task's printer hint (name or id) to the farm config. */
  resolvePrinter(reference: string): PrinterConfig | undefined;
  /** Poll-cache live status (the physical layer re-reads fresh before sending). */
  getStatus(printerId: string): PrinterLiveStatus | undefined;
  /**
   * Sends the physical start through the per-printer serialized command path
   * (guard reconciliation, fresh idle re-check, durable start guard). Throws on
   * refusal/failure; {@link classifyDispatchError} decides rejected vs unknown.
   */
  startPhysical(printerId: string, file: string, runId: string): Promise<void>;
  /** Classifier for a failed startPhysical (injected so tests need no drivers). */
  classifyError(error: unknown): "rejected" | "unknown";
  /** On-device file listing (identity pre-flight); defaults to the Moonraker adapter. */
  listFiles?: (printer: PrinterConfig, dir: string) => Promise<PrinterFilesListing>;
  now?: () => Date;
  nightWindow: string;
  nightSafetyBufferRatio?: number;
  logger?: StoreLogger;
}

/**
 * The single server-side operation every physical print start goes through —
 * manual start-next, night start, retries and (future) automatic scheduling.
 * The legacy JSON queue can no longer reach a printer: only a SQLite task with
 * a queue entry, an (optionally) analysed artifact and a passing
 * {@link evaluateDispatchGate} can produce a start command.
 *
 * Protocol (fail-closed at every seam):
 *
 *  1. **Pre-flight** (network, outside any transaction): when the driver
 *     supports file listing, the on-device file is verified against the
 *     artifact identity (name + size today; hash is not readable over
 *     Moonraker — the strongest available identity is recorded honestly on the
 *     run as `identityLevel`).
 *  2. **Reserve transaction**: the task/entry/artifact/analysis are re-read,
 *     the gate re-evaluated, preview versions checked (`409` on drift), and in
 *     ONE transaction the assignment, bed cycle, dispatch attempt and a
 *     `PENDING` run are created and the task moves `QUEUED → ASSIGNED →
 *     DISPATCHING`. If this commit fails, no command is ever sent.
 *  3. **Physical send** through the command service, which writes the durable
 *     start guard (now carrying the `runId`) before dispatch.
 *  4. **Finalize transaction**: ACK → run `RUNNING`, attempt `ACKED`, task
 *     `PRINTING`, entry `RELEASED`, bed `RUNNING`, then the guard is released
 *     (only after the durable commit). Definitive rejection → run `CANCELLED`,
 *     attempt `FAILED`, task re-queued with the reason. Lost outcome → run
 *     `UNKNOWN`, guard kept, printer held until reconciled — never auto-retried.
 */
export class DispatchService {
  private readonly now: () => Date;
  private readonly listFiles: (printer: PrinterConfig, dir: string) => Promise<PrinterFilesListing>;
  private readonly logger: StoreLogger;

  constructor(private readonly deps: DispatchDeps) {
    this.now = deps.now ?? (() => new Date());
    this.listFiles = deps.listFiles ?? fetchPrinterFiles;
    this.logger = deps.logger ?? {};
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const repos = this.deps.store.repositories;

    // Idempotency: the same key returns the original run, whatever its state —
    // the caller retried a request whose first instance already acted.
    if (request.idempotencyKey) {
      const existing = repos.printRuns.findByIdempotencyKey(request.idempotencyKey);
      if (existing) return this.describeExisting(existing);
    }

    // ── Pre-flight (reads + network; authoritative re-check happens in the tx) ──
    const task = repos.tasks.getById(request.taskId);
    if (!task) throw new NotFoundError(`Задание «${request.taskId}»`);
    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    const file = resolveDispatchFile(task, artifact);
    if (!file) throw new JobError(`У задания «${task.title}» не задан файл для запуска`);
    const target = normalizeStartablePath(file);

    const printerRef = task.pinnedPrinterId ?? task.targetPrinter;
    if (!printerRef) throw new JobError(`У задания «${task.title}» не задан принтер`);
    const printer = this.deps.resolvePrinter(printerRef);
    if (!printer) throw new JobError(`Принтер «${printerRef}» не найден в конфигурации фермы`);

    const identity = await this.verifyOnDeviceFile(printer, target, artifact, request.mode);

    // ── Reserve transaction ──────────────────────────────────────────────────
    const reserved = this.deps.store.transaction(() =>
      this.reserve(request, printer, target, identity)
    );

    // ── Physical send (per-printer serialized; durable guard inside) ────────
    try {
      await this.deps.startPhysical(printer.id, target, reserved.run.id);
    } catch (error) {
      const outcome = this.deps.classifyError(error);
      this.deps.store.transaction(() => this.finalizeFailure(reserved, outcome, error, request.actor));
      throw error;
    }

    // ── Finalize (durable) — only then release the guard via the caller ─────
    this.deps.store.transaction(() => this.finalizeSuccess(reserved, request.actor));
    return {
      runId: reserved.run.id,
      taskId: reserved.task.id,
      assignmentId: reserved.assignment.id,
      attemptId: reserved.attempt.id,
      printerId: printer.id,
      printerName: printer.name,
      file: target,
      deduplicated: false
    };
  }

  // ── Phase helpers ──────────────────────────────────────────────────────────

  private reserve(
    request: DispatchRequest,
    printer: PrinterConfig,
    target: string,
    identity: { level: string; note: string | null }
  ): ReservedDispatch {
    const repos = this.deps.store.repositories;
    const iso = this.nowIso();
    const actor = request.actor ?? "operator";

    // Re-read everything inside the transaction — the pre-flight reads may be stale.
    const task = repos.tasks.getById(request.taskId);
    if (!task) throw new NotFoundError(`Задание «${request.taskId}»`);

    if (request.expectedTaskVersion !== undefined && task.version !== request.expectedTaskVersion) {
      throw new PreviewConflictError(
        `Задание «${task.title}» изменилось после предпросмотра (версия ${task.version}, ожидалась ${request.expectedTaskVersion}) — обновите список и подтвердите заново`,
        { taskId: task.id, version: task.version, expected: request.expectedTaskVersion }
      );
    }

    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    if (request.expectedArtifactSha256 !== undefined) {
      const actual = artifact?.sha256 ?? null;
      if (actual !== request.expectedArtifactSha256) {
        throw new PreviewConflictError(
          `Файл задания «${task.title}» изменился после предпросмотра — обновите список и подтвердите заново`,
          { taskId: task.id, expectedSha256: request.expectedArtifactSha256, actualSha256: actual }
        );
      }
    }

    const entry = repos.queue.findByTaskId(task.id);
    const analysis = artifact ? repos.artifactAnalyses.latestForArtifact(artifact.id) : null;

    const blockers = evaluateDispatchGate({
      mode: request.mode,
      task,
      entry,
      artifact,
      analysis,
      printer,
      status: this.deps.getStatus(printer.id),
      remoteStartSupported: supportsPrinterStart(printer),
      nightWindowMinutes: windowLengthMinutes(this.deps.nightWindow),
      nightSafetyBufferRatio: this.deps.nightSafetyBufferRatio ?? 1,
      currentAnalyzerVersion: ANALYZER_VERSION
    });
    if (blockers.length > 0) {
      throw new JobError(
        `Нельзя запустить «${task.title}»: ${blockers.map((b) => b.message).join("; ")}`,
        { blockers }
      );
    }

    // One active run per task / per printer, one live assignment — checked here
    // for an honest message; the 008 partial unique indexes are the backstop.
    const activeTaskRun = repos.printRuns.findActiveByTask(task.id);
    if (activeTaskRun) {
      throw new JobError(
        `У задания «${task.title}» уже есть активная печать (${activeTaskRun.id}, ${activeTaskRun.state})`
      );
    }
    const activePrinterRun = repos.printRuns.findActiveByPrinter(printer.id);
    if (activePrinterRun) {
      throw new JobError(
        `На «${printer.name}» уже есть активная печать (${activePrinterRun.id}, ${activePrinterRun.state})`
      );
    }
    const openAssignment = repos.assignments.findOpenByPrinter(printer.id);
    if (openAssignment) {
      throw new JobError(
        `На «${printer.name}» уже есть живое назначение (${openAssignment.id}, ${openAssignment.state})`
      );
    }
    const guard = repos.startGuards.get(printer.id);
    if (guard) {
      throw new JobError(
        `На «${printer.name}» есть неподтверждённый запуск «${guard.file}» — снимите блокировку после проверки принтера`
      );
    }

    // Bed occupancy: fail-closed for anything unknown/occupied. An attended
    // start (or an unattended one the operator explicitly permitted on an
    // uncleared bed) closes an AWAITING_CLEARANCE cycle with an audit trace.
    const openBed = repos.bedCycles.findOpenByPrinter(printer.id);
    if (openBed) {
      const mayPresumeClear =
        openBed.state === "AWAITING_CLEARANCE" &&
        (request.mode === "manual" || task.unattendedAllowed === true);
      if (!mayPresumeClear) {
        throw new JobError(
          `Стол принтера «${printer.name}» не подтверждён свободным (${openBed.state}) — очистите стол и подтвердите`
        );
      }
      assertTransition("цикл стола", BED_CYCLE_TRANSITIONS, openBed.state, "CLEAR");
      repos.bedCycles.update({ ...openBed, state: "CLEAR", clearedAt: iso, updatedAt: iso });
      this.audit("bed_cycle", openBed.id, "presumed_cleared", actor, {
        from: openBed.state,
        to: "CLEAR",
        detail: { mode: request.mode, reason: "start dispatched over an awaiting-clearance bed" }
      });
    }

    // ── Writes: bed → assignment → attempt → run → task transitions ────────
    const bed: BedCycle = {
      id: newId(ID_PREFIX.bedCycle),
      printerId: printer.id,
      state: "RESERVED",
      assignmentId: null,
      createdAt: iso,
      updatedAt: iso,
      clearedAt: null,
      version: 1,
      metadata: {}
    };
    repos.bedCycles.insert(bed);

    const assignment: Assignment = {
      id: newId(ID_PREFIX.assignment),
      taskId: task.id,
      printerId: printer.id,
      planId: null,
      bedCycleId: bed.id,
      state: "RESERVED",
      createdAt: iso,
      updatedAt: iso,
      version: 1,
      legacyRef: null,
      metadata: { via: "dispatch", mode: request.mode }
    };
    repos.assignments.insert(assignment);
    repos.bedCycles.update({ ...bed, assignmentId: assignment.id, updatedAt: iso });
    this.audit("assignment", assignment.id, "reserved", actor, {
      to: "RESERVED",
      detail: { taskId: task.id, printerId: printer.id, mode: request.mode }
    });

    const attempt: DispatchAttempt = {
      id: newId(ID_PREFIX.dispatchAttempt),
      assignmentId: assignment.id,
      taskId: task.id,
      printerId: printer.id,
      attemptNo: repos.dispatchAttempts.maxAttemptNo(assignment.id) + 1,
      state: "PENDING",
      error: null,
      requestedAt: iso,
      completedAt: null,
      createdAt: iso,
      updatedAt: iso,
      version: 1,
      metadata: { mode: request.mode }
    };
    repos.dispatchAttempts.insert(attempt);
    this.audit("dispatch_attempt", attempt.id, "created", actor, { to: "PENDING" });

    const run: PrintRun = {
      id: newId(ID_PREFIX.printRun),
      taskId: task.id,
      assignmentId: assignment.id,
      dispatchAttemptId: attempt.id,
      printerId: printer.id,
      bedCycleId: bed.id,
      state: "PENDING",
      file: target,
      artifactId: artifact?.id ?? null,
      artifactSha256: artifact?.sha256 ?? null,
      idempotencyKey: request.idempotencyKey ?? null,
      startedAt: null,
      endedAt: null,
      progress: null,
      filamentUsedG: null,
      durationS: null,
      createdAt: iso,
      updatedAt: iso,
      version: 1,
      legacyRef: task.legacyRef,
      metadata: {
        mode: request.mode,
        identityLevel: identity.level,
        ...(identity.note ? { identityNote: identity.note } : {}),
        decidedTaskVersion: task.version,
        decidedAnalysisId: analysis?.id ?? null
      }
    };
    repos.printRuns.insert(run);
    this.audit("print_run", run.id, "reserved", actor, {
      to: "PENDING",
      detail: { file: target, artifactId: run.artifactId, sha256: run.artifactSha256 }
    });

    // QUEUED → ASSIGNED → DISPATCHING, under the task's optimistic version.
    assertTransition("задание", PRINT_TASK_TRANSITIONS, task.state, "ASSIGNED");
    const assigned = repos.tasks.update({
      ...task,
      state: "ASSIGNED",
      targetPrinter: printer.id,
      updatedAt: iso
    });
    assertTransition("задание", PRINT_TASK_TRANSITIONS, assigned.state, "DISPATCHING");
    const dispatching = repos.tasks.update({ ...assigned, state: "DISPATCHING", updatedAt: iso });
    this.audit("print_task", task.id, "dispatching", actor, { from: task.state, to: "DISPATCHING" });

    return { task: dispatching, entry: entry as QueueEntry, assignment, attempt, run };
  }

  private finalizeSuccess(reserved: ReservedDispatch, actor?: string): void {
    const repos = this.deps.store.repositories;
    const iso = this.nowIso();
    const who = actor ?? "operator";

    const attempt = repos.dispatchAttempts.getById(reserved.attempt.id);
    if (attempt && attempt.state === "PENDING") {
      assertTransition("попытка запуска", DISPATCH_ATTEMPT_TRANSITIONS, attempt.state, "SENT");
      const sent = repos.dispatchAttempts.update({ ...attempt, state: "SENT", updatedAt: iso });
      assertTransition("попытка запуска", DISPATCH_ATTEMPT_TRANSITIONS, sent.state, "ACKED");
      repos.dispatchAttempts.update({ ...sent, state: "ACKED", completedAt: iso, updatedAt: iso });
    }

    const run = repos.printRuns.getById(reserved.run.id);
    if (run && run.state === "PENDING") {
      assertTransition("печать", PRINT_RUN_TRANSITIONS, run.state, "RUNNING");
      repos.printRuns.update({ ...run, state: "RUNNING", startedAt: iso, progress: 0, updatedAt: iso });
      this.audit("print_run", run.id, "started", who, { from: "PENDING", to: "RUNNING" });
    }

    const task = repos.tasks.getById(reserved.task.id);
    if (task && task.state === "DISPATCHING") {
      assertTransition("задание", PRINT_TASK_TRANSITIONS, task.state, "PRINTING");
      repos.tasks.update({ ...task, state: "PRINTING", updatedAt: iso });
      this.audit("print_task", task.id, "printing", who, { from: "DISPATCHING", to: "PRINTING" });
    }

    const entry = repos.queue.findByTaskId(reserved.task.id);
    if (entry && entry.state !== "RELEASED") {
      assertTransition("запись очереди", QUEUE_ENTRY_TRANSITIONS, entry.state, "RELEASED");
      repos.queue.update({ ...entry, state: "RELEASED", updatedAt: iso });
    }

    const assignment = repos.assignments.getById(reserved.assignment.id);
    if (assignment && assignment.state === "RESERVED") {
      assertTransition("назначение", ASSIGNMENT_TRANSITIONS, assignment.state, "ACTIVE");
      repos.assignments.update({ ...assignment, state: "ACTIVE", updatedAt: iso });
    }

    if (reserved.run.bedCycleId) {
      const bed = repos.bedCycles.getById(reserved.run.bedCycleId);
      if (bed && bed.state === "RESERVED") {
        assertTransition("цикл стола", BED_CYCLE_TRANSITIONS, bed.state, "RUNNING");
        repos.bedCycles.update({ ...bed, state: "RUNNING", updatedAt: iso });
      }
    }
  }

  private finalizeFailure(
    reserved: ReservedDispatch,
    outcome: "rejected" | "unknown",
    error: unknown,
    actor?: string
  ): void {
    const repos = this.deps.store.repositories;
    const iso = this.nowIso();
    const who = actor ?? "operator";
    const message = error instanceof Error ? error.message : String(error);

    const attempt = repos.dispatchAttempts.getById(reserved.attempt.id);
    const run = repos.printRuns.getById(reserved.run.id);
    const task = repos.tasks.getById(reserved.task.id);

    if (outcome === "rejected") {
      // The device provably never started: unwind everything so a corrected
      // retry can go through; the task returns to the queue with the reason.
      if (attempt && attempt.state === "PENDING") {
        repos.dispatchAttempts.update({
          ...attempt,
          state: "FAILED",
          error: message,
          completedAt: iso,
          updatedAt: iso
        });
      }
      if (run && run.state === "PENDING") {
        repos.printRuns.update({
          ...run,
          state: "CANCELLED",
          endedAt: iso,
          updatedAt: iso,
          metadata: { ...run.metadata, dispatchOutcome: "rejected", error: message }
        });
        this.audit("print_run", run.id, "dispatch_rejected", who, { from: "PENDING", to: "CANCELLED" });
      }
      const assignment = repos.assignments.getById(reserved.assignment.id);
      if (assignment && assignment.state === "RESERVED") {
        repos.assignments.update({ ...assignment, state: "CANCELLED", updatedAt: iso });
      }
      if (reserved.run.bedCycleId) {
        const bed = repos.bedCycles.getById(reserved.run.bedCycleId);
        if (bed && bed.state === "RESERVED") {
          repos.bedCycles.update({ ...bed, state: "CLEAR", clearedAt: iso, updatedAt: iso });
        }
      }
      if (task && task.state === "DISPATCHING") {
        const failed = repos.tasks.update({
          ...task,
          state: "FAILED",
          reason: `запуск отклонён: ${message}`,
          updatedAt: iso
        });
        // FAILED → QUEUED is the legal retry edge; the reason is kept visible.
        repos.tasks.update({ ...failed, state: "QUEUED", updatedAt: iso });
        this.audit("print_task", task.id, "dispatch_rejected", who, {
          from: "DISPATCHING",
          to: "QUEUED",
          detail: { error: message }
        });
      }
      return;
    }

    // Unknown outcome: the print may be running. The run goes UNKNOWN and the
    // durable start guard (already UNKNOWN, carrying this runId) holds the
    // printer. Nothing here may auto-retry or auto-fail — reconciliation against
    // the live device (or the operator) resolves it.
    if (attempt && attempt.state === "PENDING") {
      repos.dispatchAttempts.update({ ...attempt, state: "SENT", error: message, updatedAt: iso });
    }
    if (run && run.state === "PENDING") {
      repos.printRuns.update({
        ...run,
        state: "UNKNOWN",
        updatedAt: iso,
        metadata: { ...run.metadata, dispatchOutcome: "unknown", error: message }
      });
      this.audit("print_run", run.id, "dispatch_unconfirmed", who, { from: "PENDING", to: "UNKNOWN" });
    }
    if (task && task.state === "DISPATCHING") {
      this.audit("print_task", task.id, "dispatch_unconfirmed", who, {
        detail: { error: message, note: "printer held until reconciled" }
      });
    }
  }

  // ── On-device identity pre-flight ─────────────────────────────────────────

  /**
   * Verifies the on-device file against the artifact identity with the
   * strongest evidence the adapter offers. Moonraker exposes name + size (no
   * content hash over the API) — a size mismatch on a same-named file is a hard
   * refusal. Adapters with no file API at all are recorded honestly as
   * `name-only`; for a *night* dispatch that weakness is itself a refusal.
   */
  private async verifyOnDeviceFile(
    printer: PrinterConfig,
    target: string,
    artifact: { sha256: string | null; sizeBytes: number | null } | null,
    mode: DispatchMode
  ): Promise<{ level: string; note: string | null }> {
    if (!supportsPrinterFiles(printer)) {
      if (mode === "night") {
        throw new JobError(
          `Протокол «${printer.protocol}» не позволяет проверить файл на устройстве — ночной запуск запрещён`
        );
      }
      return { level: "name-only", note: `протокол ${printer.protocol} не поддерживает листинг файлов` };
    }

    let listing: PrinterFilesListing;
    try {
      const dir = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
      listing = await this.listFiles(printer, dir);
    } catch (error) {
      // The listing endpoint failing is not proof of absence; the start itself
      // re-validates against the device. For unattended mode it IS a refusal.
      if (mode === "night") {
        throw new JobError(
          `Не удалось проверить файл на «${printer.name}» перед ночным запуском — запуск запрещён`
        );
      }
      this.logger.warn?.({ err: error, printer: printer.id }, "on-device file pre-flight failed");
      return { level: "name-only", note: "листинг файлов недоступен во время pre-flight" };
    }

    const entry = listing.entries.find((e) => e.type === "file" && e.path === target);
    if (!entry) {
      throw new JobError(`Файл «${target}» не найден на «${printer.name}»`);
    }
    if (artifact?.sizeBytes != null && typeof entry.size === "number") {
      if (entry.size !== artifact.sizeBytes) {
        throw new JobError(
          `Файл «${target}» на «${printer.name}» отличается от проанализированного (размер ${entry.size} ≠ ${artifact.sizeBytes}) — содержимое не то, что проверялось`
        );
      }
      return {
        level: "name+size",
        note: "хеш недоступен через Moonraker API — идентичность подтверждена именем и размером"
      };
    }
    if (mode === "night" && artifact) {
      // Night dispatch demands the strongest identity we can get; a registered
      // artifact with no recorded size cannot be matched beyond its name.
      throw new JobError(
        `Идентичность файла «${target}» на «${printer.name}» нельзя подтвердить (нет размера) — ночной запуск запрещён`
      );
    }
    return { level: "name-only", note: "размер недоступен для сравнения" };
  }

  // ── Misc ──────────────────────────────────────────────────────────────────

  private describeExisting(run: PrintRun): DispatchResult {
    const printer = this.deps.resolvePrinter(run.printerId);
    return {
      runId: run.id,
      taskId: run.taskId,
      assignmentId: run.assignmentId,
      attemptId: run.dispatchAttemptId ?? "",
      printerId: run.printerId,
      printerName: printer?.name ?? run.printerId,
      file: run.file ?? "",
      deduplicated: true
    };
  }

  private audit(
    entityType: AuditEntityType,
    entityId: string,
    action: string,
    actor: string,
    extra: { from?: string; to?: string; detail?: Metadata } = {}
  ): void {
    this.deps.store.repositories.audit.insert({
      id: newId(ID_PREFIX.auditEvent),
      at: this.nowIso(),
      entityType,
      entityId,
      action,
      fromState: extra.from ?? null,
      toState: extra.to ?? null,
      actor,
      detail: extra.detail ?? {}
    });
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

interface ReservedDispatch {
  task: PrintTask;
  entry: QueueEntry;
  assignment: Assignment;
  attempt: DispatchAttempt;
  run: PrintRun;
}

export type { DispatchBlocker, DispatchMode };
export { evaluateDispatchGate, resolveDispatchFile };

/** Narrow re-export so callers get one import site for validation errors. */
export { ValidationError };
