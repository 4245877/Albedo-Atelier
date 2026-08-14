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
import type { DeviceFileIdentity, DispatchEligibility } from "../../domain/dispatch/eligibility";
import { REASON } from "../../domain/dispatch/reasons";
import {
  blockersOf,
  remainingBlockers,
  resolveDispatchFile,
  type DispatchBlocker,
  type DispatchMode
} from "./dispatchGate";
import { bindingMatchesTask, profileRevisionsIntact, resolveTaskBinding } from "./binding";

/**
 * An explicit, audited operator decision to proceed despite non-hard warnings.
 * Hard rules (occupied bed, wrong target printer, unverified file, busy printer,
 * model that does not fit…) are NOT clearable by it — see `NON_OVERRIDABLE`.
 */
export interface DispatchOverride {
  /** Reason codes the operator explicitly accepts. */
  codes: string[];
  /** Free-text justification; required — an override with no reason is not one. */
  reason: string;
  /** Who is accountable. */
  operator: string;
}

export interface DispatchRequest {
  taskId: string;
  mode: DispatchMode;
  /**
   * Execute exactly this assignment. Set by {@link DispatchService.startAssignment};
   * when present the printer, slice and file come from the assignment's binding and
   * the task's `pinnedPrinterId`/`targetPrinter` hints may not override them.
   */
  assignmentId?: string;
  /** Optimistic preview guard: the task version the operator saw; mismatch → 409. */
  expectedTaskVersion?: number;
  /** Preview identity guard: the artifact hash the operator saw; mismatch → 409. */
  expectedArtifactSha256?: string | null;
  /** Repeating the same key returns the original run — never a second command. */
  idempotencyKey?: string;
  /** Explicit operator override of overridable warnings (manual mode only). */
  override?: DispatchOverride;
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
  /**
   * The single authoritative admission check (`DispatchEligibility`), shared
   * verbatim with the compatibility preview and plan confirmation. Injected so
   * the dispatch cannot grow a private second rule set — the defect this whole
   * module was rewritten to remove.
   */
  evaluateEligibility(input: {
    taskId: string;
    printerId: string;
    mode: DispatchMode;
    deviceFileIdentity: DeviceFileIdentity;
    file: string | null;
    filePathValid: boolean;
  }): DispatchEligibility;
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

  /**
   * **The canonical launch operation.** Executes one confirmed/manual assignment
   * verbatim: its printer, its slice, its file — never a printer re-derived from
   * `task.pinnedPrinterId` or `task.targetPrinter`.
   *
   * Every start path funnels here or through {@link dispatch} (which resolves the
   * task's executable assignment first and then behaves identically), so there is
   * exactly one place that reaches a printer and exactly one eligibility check in
   * front of it.
   */
  async startAssignment(
    assignmentId: string,
    options: Omit<DispatchRequest, "taskId" | "assignmentId" | "mode"> & { mode?: DispatchMode } = {}
  ): Promise<DispatchResult> {
    const assignment = this.deps.store.repositories.assignments.getById(assignmentId);
    if (!assignment) throw new NotFoundError(`Назначение «${assignmentId}»`);
    this.assertExecutable(assignment);
    return this.dispatch({
      ...options,
      mode: options.mode ?? "manual",
      taskId: assignment.taskId,
      assignmentId: assignment.id
    });
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const repos = this.deps.store.repositories;

    // Request shape first: a malformed or illegal override is rejected before
    // anything is read, listed over the network, or reserved. An override is
    // *only* ever an attended decision — an unattended start has nobody to be
    // accountable for it, so night mode refuses one outright.
    if (request.override && request.mode !== "manual") {
      throw new ValidationError("Override допустим только для ручного запуска");
    }
    normalizeOverride(request.override);

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
    const reservation = this.executableAssignment(task.id, request.assignmentId);
    // A reservation's expected path is authoritative: the plan/operator confirmed
    // THAT file, so a task edited afterwards cannot redirect the start elsewhere.
    const file = reservation?.binding.expectedRemotePath ?? resolveDispatchFile(task, artifact);
    if (!file) throw new JobError(`У задания «${task.title}» не задан файл для запуска`);

    // The printer is resolved BEFORE the path is validated, and this order is
    // load-bearing: what counts as a startable file is a property of the target
    // adapter (`capabilitiesOf(printer).startableExtensions`), not a global. A
    // printer-less check silently falls back to the Klipper G-code set and
    // refuses the very Bambu `.gcode.3mf` plate package this service itself
    // built, uploaded and verified — the file browser (which does pass the
    // printer) would list it as `printable: true` while every start path threw
    // "не похож на файл печати".
    const printer = this.resolveTargetPrinter(task, reservation);
    const target = normalizeStartablePath(file, printer);
    // What we expect to SEE on the device — which is not always the artifact.
    //
    // A Bambu is handed a `.gcode.3mf` plate package wrapping the sliced G-code,
    // so the bytes on its SD card are legitimately a different size from the
    // artifact's. Comparing the listing against `artifact.sizeBytes` therefore
    // refuses every correctly-delivered Bambu package as "содержимое не то, что
    // проверялось". The delivery record is the authority on what was actually
    // put there (and verified there); the artifact is only the fallback for a
    // file no delivery of ours created — an operator-adopted one.
    const delivered = repos.deviceArtifacts.findBySlot(printer.id, target);
    const expected = {
      sha256: artifact?.sha256 ?? null,
      sizeBytes: delivered ? delivered.sizeBytes : (artifact?.sizeBytes ?? null)
    };
    const identity = await this.verifyOnDeviceFile(printer, target, expected, request.mode);

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

  /**
   * The printer a dispatch may target.
   *
   * A **confirmed** (ACTIVE-plan) assignment is executable data, not a hint: when
   * one exists it decides, and `task.pinnedPrinterId` / `task.targetPrinter` may
   * not silently override it. Previously the task hints were read directly, so a
   * task edited after a plan was confirmed would start on a printer the plan never
   * approved — with a compatibility answer computed for a different machine.
   *
   * A divergence between the confirmed assignment and the task hints does not
   * pick a winner: it refuses, so the operator replans or clears the assignment.
   */
  private resolveTargetPrinter(task: PrintTask, reservation: Assignment | null): PrinterConfig {
    const hint = task.pinnedPrinterId ?? task.targetPrinter;

    if (reservation) {
      const assigned = this.deps.resolvePrinter(reservation.printerId);
      if (!assigned) {
        throw new JobError(
          `Принтер «${reservation.printerId}» из подтверждённого плана не найден в конфигурации фермы`
        );
      }
      if (hint) {
        const hinted = this.deps.resolvePrinter(hint);
        if (hinted && hinted.id !== assigned.id) {
          throw new JobError(
            `Задание «${task.title}» подтверждено в плане на «${assigned.name}», но закреплено за «${hinted.name}» — расхождение назначения, требуется перепланирование или ручная проверка`,
            {
              blockers: [
                {
                  code: REASON.ASSIGNMENT_PRINTER_MISMATCH,
                  message: `план: ${assigned.id}, задание: ${hinted.id}`
                }
              ],
              assignmentId: reservation.id,
              planId: reservation.planId
            }
          );
        }
      }
      return assigned;
    }

    if (!hint) throw new JobError(`У задания «${task.title}» не задан принтер`);
    const printer = this.deps.resolvePrinter(hint);
    if (!printer) throw new JobError(`Принтер «${hint}» не найден в конфигурации фермы`);
    return printer;
  }

  /**
   * Refuses the start unless the authoritative eligibility permits it.
   *
   * An operator override may clear only *overridable* reasons, only in `manual`
   * mode, and only with a stated reason and an operator id — every override is
   * written to the audit trail with the exact codes it waved through. Hard rules
   * (bed not clear, wrong target printer, unverified file, busy printer, model
   * does not fit…) are refused regardless: there is no request shape that starts
   * a print over them.
   */
  private enforceEligibility(
    task: PrintTask,
    eligibility: DispatchEligibility,
    request: DispatchRequest
  ): void {
    // Shape and mode were validated up front in `dispatch`; re-normalizing here
    // keeps this method correct on its own terms.
    const override = request.mode === "manual" ? normalizeOverride(request.override) : null;

    const remaining = remainingBlockers(eligibility, override?.codes ?? []);
    if (remaining.length > 0) {
      throw new JobError(
        `Нельзя запустить «${task.title}»: ${remaining.map((r) => r.message).join("; ")}`,
        { blockers: remaining.map((r) => ({ code: r.code, message: r.message })), status: eligibility.status }
      );
    }

    if (override) {
      const cleared = eligibility.reasons.filter((r) => override.codes.includes(r.code));
      if (cleared.length === 0) {
        throw new ValidationError(
          "Override не относится ни к одному из предупреждений — обновите предпросмотр"
        );
      }
      this.audit("print_task", task.id, "eligibility_override", override.operator, {
        detail: {
          reason: override.reason,
          operator: override.operator,
          overridden: cleared.map((r) => ({ code: r.code, message: r.message })),
          at: this.nowIso()
        }
      });
    }
  }

  /**
   * The task's **executable** assignment: the one a start must run verbatim.
   *
   * Two kinds qualify — an assignment under a confirmed (`ACTIVE`) plan, and an
   * explicit manual placement. A proposal on a *draft* plan is a recommendation
   * and binds nothing. When `wantedId` is given (the `startAssignment` path) that
   * exact assignment is required, so a caller can never be silently handed a
   * different one.
   */
  private executableAssignment(taskId: string, wantedId?: string): Assignment | null {
    const repos = this.deps.store.repositories;
    if (wantedId) {
      const assignment = repos.assignments.getById(wantedId);
      if (!assignment) throw new NotFoundError(`Назначение «${wantedId}»`);
      if (assignment.taskId !== taskId) {
        throw new JobError(
          `Назначение ${wantedId} принадлежит другому заданию (${assignment.taskId})`
        );
      }
      this.assertExecutable(assignment);
      return assignment;
    }
    for (const assignment of repos.assignments.listByTask(taskId)) {
      if (assignment.state === "CANCELLED" || assignment.state === "RELEASED") continue;
      if (assignment.invalidatedAt) continue;
      if (assignment.planId) {
        const plan = repos.plans.getById(assignment.planId);
        if (plan?.state === "ACTIVE") return assignment;
        continue;
      }
      if (assignment.source === "manual") return assignment;
    }
    return null;
  }

  /**
   * Refuses an assignment that may not be executed: closed, invalidated, or a
   * proposal on a plan nobody confirmed. Fail-closed — an assignment whose plan
   * cannot be read is not executable either.
   */
  private assertExecutable(assignment: Assignment): void {
    if (assignment.state === "RELEASED" || assignment.state === "CANCELLED") {
      throw new JobError(`Назначение ${assignment.id} закрыто (${assignment.state}) — запуск невозможен`, {
        blockers: [{ code: REASON.ASSIGNMENT_STALE, message: assignment.state }]
      });
    }
    if (assignment.invalidatedAt) {
      throw new JobError(
        `Назначение ${assignment.id} устарело${assignment.invalidatedReason ? `: ${assignment.invalidatedReason}` : ""} — требуется перепланирование`,
        {
          blockers: [
            { code: REASON.ASSIGNMENT_STALE, message: assignment.invalidatedReason ?? "invalidated" }
          ]
        }
      );
    }
    if (assignment.planId) {
      const plan = this.deps.store.repositories.plans.getById(assignment.planId);
      if (!plan || plan.state !== "ACTIVE") {
        throw new JobError(
          `Назначение ${assignment.id} принадлежит неподтверждённому плану (${plan?.state ?? "нет плана"}) — подтвердите план перед запуском`,
          {
            blockers: [
              { code: REASON.ASSIGNMENT_NOT_CONFIRMED, message: plan?.state ?? "plan missing" }
            ]
          }
        );
      }
    } else if (assignment.source !== "manual") {
      throw new JobError(
        `Назначение ${assignment.id} не подтверждено ни планом, ни оператором — запуск невозможен`,
        { blockers: [{ code: REASON.ASSIGNMENT_NOT_CONFIRMED, message: assignment.source }] }
      );
    }
  }

  /**
   * The assignment's binding must still describe the task, and every profile
   * revision it pinned must still exist and be `active`.
   *
   * This is the check that stops a confirmed placement being executed against
   * changed data: the task was re-sliced, re-promoted onto a different variant, or
   * a preset re-import quarantined a profile the approved set pinned. Each is a
   * refusal with a concrete reason — never a silent substitution.
   */
  private assertBindingCurrent(assignment: Assignment, task: PrintTask): void {
    if (!bindingMatchesTask(assignment.binding, task)) {
      throw new JobError(
        `Назначение ${assignment.id} больше не соответствует заданию «${task.title}» — задание изменилось после подтверждения, требуется перепланирование`,
        {
          blockers: [
            {
              code: REASON.ASSIGNMENT_STALE,
              message: `confirmed slice=${assignment.binding.sliceVariantId ?? "—"}, task slice=${task.sliceVariantId ?? "—"}`
            }
          ],
          assignmentId: assignment.id,
          planId: assignment.planId
        }
      );
    }
    const revisions = profileRevisionsIntact(this.deps.store.repositories, assignment.binding);
    if (!revisions.ok) {
      throw new JobError(
        `Нельзя запустить «${task.title}»: ${revisions.reason} — перепроверьте профили и перепланируйте`,
        {
          blockers: [{ code: REASON.PROFILE_REVISION_MISMATCH, message: revisions.reason }],
          assignmentId: assignment.id
        }
      );
    }
  }

  private reserve(
    request: DispatchRequest,
    printer: PrinterConfig,
    target: string,
    identity: { level: DeviceFileIdentity; note: string | null }
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

    // The reservation is resolved and checked FIRST, so a binding that no longer
    // describes the task refuses with that specific reason rather than surfacing
    // as a confusing downstream symptom (a "profile drift" that is really a task
    // pointed at a different slice).
    const reserved = this.executableAssignment(task.id, request.assignmentId);
    if (reserved) this.assertBindingCurrent(reserved, task);

    // The ONE authoritative admission check, re-run here against rows just
    // re-read inside the transaction — never against anything a client sent and
    // never against the preview's snapshot.
    const eligibility = this.deps.evaluateEligibility({
      taskId: task.id,
      printerId: printer.id,
      mode: request.mode,
      deviceFileIdentity: identity.level,
      file: target,
      filePathValid: true
    });
    this.enforceEligibility(task, eligibility, request);

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
    // The confirmed plan's (or the operator's) own assignment for THIS task is the
    // reservation this dispatch is executing (resolved above) — it is consumed
    // below, not treated as a rival. Any *other* live assignment still blocks.
    const openAssignment = repos.assignments.findOpenByPrinter(printer.id);
    if (openAssignment && openAssignment.id !== reserved?.id) {
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

    // Bed occupancy: fail-closed, with NO presumption path.
    //
    // A dispatch never clears a bed. `AWAITING_CLEARANCE` means the previous
    // part is still on the plate as far as the system knows, and only an
    // explicit clearance event (operator removal, plate swap, or a *verified*
    // automatic mechanism — see `PrintQueueService.clearBed`) may move it to
    // `CLEAR`. Neither an attended start nor `unattendedAllowed` substitutes for
    // one: "печать без присмотра" is permission to run one print unwatched, not
    // permission to continue the queue onto an occupied bed. The eligibility
    // check above already refuses this case; the throw here is the last-resort
    // backstop in case a caller is ever wired with a laxer evaluator.
    const openBed = repos.bedCycles.findOpenByPrinter(printer.id);
    if (openBed) {
      throw new JobError(
        openBed.state === "AWAITING_CLEARANCE"
          ? `На столе «${printer.name}» осталась готовая модель — снимите её и подтвердите очистку стола перед запуском`
          : `Стол принтера «${printer.name}» не подтверждён свободным (${openBed.state}) — очистите стол и подтвердите`,
        {
          blockers: [
            {
              code:
                openBed.state === "AWAITING_CLEARANCE"
                  ? REASON.BED_NOT_CLEAR
                  : REASON.BED_STATE_UNKNOWN,
              message: `bed cycle ${openBed.id} = ${openBed.state}`
            }
          ]
        }
      );
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

    // A confirmed plan's assignment is *consumed* (PROPOSED → RESERVED), never
    // duplicated: the run then traces back to the very reservation the operator
    // confirmed, and the plan's placement is not shadowed by a second, unplanned
    // assignment for the same task. Without a confirmed plan a fresh assignment
    // is minted as before.
    let assignment: Assignment;
    if (reserved) {
      assertTransition("назначение", ASSIGNMENT_TRANSITIONS, reserved.state, "RESERVED");
      assignment = repos.assignments.update({
        ...reserved,
        state: "RESERVED",
        bedCycleId: bed.id,
        updatedAt: iso,
        metadata: { ...reserved.metadata, via: "dispatch", mode: request.mode }
      });
    } else {
      // No plan and no manual placement: the dispatch mints its own assignment so
      // the run still traces to one. It carries the same typed binding every other
      // path records, so the file that was started is reconstructable afterwards.
      assignment = {
        id: newId(ID_PREFIX.assignment),
        taskId: task.id,
        printerId: printer.id,
        planId: null,
        bedCycleId: bed.id,
        state: "RESERVED",
        source: "dispatch",
        reason: `прямой запуск (${request.mode})`,
        createdBy: actor,
        binding: {
          ...resolveTaskBinding(repos, task).binding,
          expectedRemotePath: target
        },
        invalidatedAt: null,
        invalidatedReason: null,
        createdAt: iso,
        updatedAt: iso,
        version: 1,
        legacyRef: null,
        metadata: { via: "dispatch", mode: request.mode }
      };
      repos.assignments.insert(assignment);
    }
    repos.bedCycles.update({ ...bed, assignmentId: assignment.id, updatedAt: iso });
    this.audit("assignment", assignment.id, "reserved", actor, {
      from: reserved?.state,
      to: "RESERVED",
      detail: {
        taskId: task.id,
        printerId: printer.id,
        mode: request.mode,
        ...(reserved?.planId ? { planId: reserved.planId } : {})
      }
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
   * Verifies the on-device file against the expected identity with the
   * strongest evidence the adapter offers. Moonraker exposes name + size (no
   * content hash over the API) — a size mismatch on a same-named file is a hard
   * refusal. Adapters with no file API at all are recorded honestly as
   * `name-only`; for a *night* dispatch that weakness is itself a refusal.
   *
   * `expected.sizeBytes` is the size **on the device**, which the caller resolves
   * from the delivery record — not the artifact's own size. The two differ
   * whenever the adapter wraps the artifact for transport (a Bambu plate
   * package), and using the artifact's size there fails a healthy delivery.
   */
  private async verifyOnDeviceFile(
    printer: PrinterConfig,
    target: string,
    expected: { sha256: string | null; sizeBytes: number | null } | null,
    mode: DispatchMode
  ): Promise<{ level: DeviceFileIdentity; note: string | null }> {
    if (!supportsPrinterFiles(printer)) {
      if (mode === "night") {
        throw new JobError(
          `Протокол «${printer.protocol}» не позволяет проверить файл на устройстве — ночной запуск запрещён`,
          { blockers: [{ code: REASON.DEVICE_FILE_NOT_VERIFIED, message: "listing unsupported" }] }
        );
      }
      return {
        level: "unsupported",
        note: `протокол ${printer.protocol} не поддерживает листинг файлов`
      };
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
          `Не удалось проверить файл на «${printer.name}» перед ночным запуском — запуск запрещён`,
          { blockers: [{ code: REASON.DEVICE_FILE_NOT_VERIFIED, message: "listing failed" }] }
        );
      }
      this.logger.warn?.({ err: error, printer: printer.id }, "on-device file pre-flight failed");
      return { level: "name-only", note: "листинг файлов недоступен во время pre-flight" };
    }

    const entry = listing.entries.find((e) => e.type === "file" && e.path === target);
    if (!entry) {
      throw new JobError(`Файл «${target}» не найден на «${printer.name}»`, {
        blockers: [{ code: REASON.DEVICE_FILE_MISSING, message: `${target} @ ${printer.name}` }]
      });
    }
    if (expected?.sizeBytes != null && typeof entry.size === "number") {
      if (entry.size !== expected.sizeBytes) {
        throw new JobError(
          `Файл «${target}» на «${printer.name}» отличается от проанализированного (размер ${entry.size} ≠ ${expected.sizeBytes}) — содержимое не то, что проверялось`
        );
      }
      return {
        level: "name+size",
        note: "хеш недоступен через API принтера — идентичность подтверждена именем и размером"
      };
    }
    if (mode === "night" && expected) {
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

/** Validates an operator override; an override without accountability is not one. */
function normalizeOverride(override: DispatchOverride | undefined): DispatchOverride | null {
  if (!override) return null;
  const codes = (override.codes ?? []).map((c) => c.trim()).filter(Boolean);
  const reason = override.reason?.trim() ?? "";
  const operator = override.operator?.trim() ?? "";
  if (codes.length === 0) throw new ValidationError("Override должен перечислять коды предупреждений");
  if (!reason) throw new ValidationError("Override требует указания причины");
  if (!operator) throw new ValidationError("Override требует идентификатор оператора");
  return { codes, reason, operator };
}

export type { DispatchBlocker, DispatchMode };
export { blockersOf, resolveDispatchFile };

/** Narrow re-export so callers get one import site for validation errors. */
export { ValidationError };
