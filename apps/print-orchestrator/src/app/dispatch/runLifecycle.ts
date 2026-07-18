import { JobError, NotFoundError, StateTransitionError } from "../../core/errors";
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
import type { AuditEntityType, Metadata, PrintRun } from "../../domain/print/types";
import type { PrinterLiveStatus } from "../../infra/printers/status";
import type { StoreLogger } from "../../shared/logger";

const COMPLETE_RE = /complete|finish|done/i;
const CANCEL_RE = /cancel|abort|stop/i;

/** Loose filename match — devices may report a path while the run holds a basename. */
function sameFile(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const baseA = a.split(/[\\/]/).pop() ?? a;
  const baseB = b.split(/[\\/]/).pop() ?? b;
  return baseA === baseB;
}

function looksComplete(status: PrinterLiveStatus): boolean {
  if (status.stateText && CANCEL_RE.test(status.stateText)) return false;
  if (status.stateText && COMPLETE_RE.test(status.stateText)) return true;
  return status.progressPct !== null && status.progressPct >= 99;
}

function looksCancelled(status: PrinterLiveStatus): boolean {
  return Boolean(status.stateText && CANCEL_RE.test(status.stateText));
}

/**
 * Keeps the canonical SQLite {@link PrintRun}s reconciled with the *observed*
 * printer reality, across polls, disconnects and orchestrator restarts. The
 * rules are deliberately asymmetric and fail-closed:
 *
 *  - a run only becomes `RUNNING` on **positive** evidence (the device is
 *    printing the run's file);
 *  - a run only completes on an **observed** finish edge (printing → idle with
 *    a complete/cancel signal) — and exactly once (the terminal state machine
 *    refuses a second completion);
 *  - anything ambiguous (reconnect found the printer idle, the file changed
 *    under a live run, an end that looks neither complete nor cancelled) moves
 *    the run to `UNKNOWN` for the operator — it is never auto-completed, never
 *    auto-failed, and never spawns a second run;
 *  - restart recovery: a `PENDING` run whose start guard is gone means the
 *    start command provably never left (the guard is written before dispatch),
 *    so it unwinds and re-queues; a `PENDING`/`UNKNOWN` run WITH a guard is
 *    held untouched until device evidence or the operator resolves it.
 */
export class RunLifecycleService {
  constructor(
    private readonly store: PrintQueueStore,
    private readonly options: { now?: () => Date; logger?: StoreLogger } = {}
  ) {}

  private get logger(): StoreLogger {
    return this.options.logger ?? {};
  }

  /** The active canonical run holding a printer, if any (for identity checks/UI). */
  activeRun(printerId: string): PrintRun | null {
    return this.store.repositories.printRuns.findActiveByPrinter(printerId);
  }

  /**
   * Poll-loop hook: reconciles the printer's active run with the freshly read
   * status. Never throws — a reconciliation failure is logged and retried on
   * the next poll.
   */
  observe(
    printerId: string,
    prev: PrinterLiveStatus | undefined,
    next: PrinterLiveStatus
  ): void {
    try {
      this.reconcile(printerId, prev, next);
    } catch (error) {
      if (error instanceof StateTransitionError) return; // lost a benign race
      this.logger.error?.({ err: error, printer: printerId }, "run reconciliation failed");
    }
  }

  private reconcile(
    printerId: string,
    prev: PrinterLiveStatus | undefined,
    next: PrinterLiveStatus
  ): void {
    const repos = this.store.repositories;
    const run = repos.printRuns.findActiveByPrinter(printerId);
    if (!run) return;

    if (!next.online) return; // offline says nothing about the print

    const busy = next.status === "printing" || next.status === "paused";
    if (busy) {
      if (sameFile(next.currentFile, run.file)) {
        if (run.state === "PENDING" || run.state === "UNKNOWN") {
          // Positive evidence: the dispatched print IS running. Attach — never mint
          // a second run for a print that survived a restart/reconnect.
          this.attachRun(run, "device observed printing the dispatched file");
        } else if (run.state === "RUNNING" && next.status === "paused") {
          this.transitionRun(run, "PAUSED", {}, "paused (observed)");
        } else if (run.state === "PAUSED" && next.status === "printing") {
          this.transitionRun(run, "RUNNING", {}, "resumed (observed)");
        } else if (run.state === "RUNNING" && typeof next.progressPct === "number") {
          this.updateProgress(run, next.progressPct / 100);
        }
      } else if (next.currentFile) {
        // The device prints a DIFFERENT file than the active run's. Identity is
        // lost — flag for the operator; never guess which print this is.
        if (run.state === "RUNNING" || run.state === "PAUSED" || run.state === "PENDING") {
          this.transitionRun(
            run,
            "UNKNOWN",
            { metadata: { ...run.metadata, identityLost: next.currentFile } },
            `на принтере печатается «${next.currentFile}», ожидалось «${run.file ?? "—"}»`
          );
        }
      }
      return;
    }

    if (next.status === "error") {
      if (run.state === "RUNNING" || run.state === "PAUSED") {
        this.completeRun(run.id, "FAILED", { reason: next.error ?? "принтер сообщил об ошибке" });
      }
      return;
    }

    // Device is idle/unknown-state and online.
    if (run.state === "RUNNING" || run.state === "PAUSED") {
      const watchedEnd = prev && prev.online && (prev.status === "printing" || prev.status === "paused");
      if (watchedEnd) {
        if (looksCancelled(next)) {
          this.completeRun(run.id, "CANCELLED", {});
        } else if (looksComplete(next)) {
          this.completeRun(run.id, "SUCCEEDED", {});
        } else {
          this.transitionRun(
            run,
            "UNKNOWN",
            {},
            "печать завершилась без явного признака успеха/отмены — требуется проверка"
          );
        }
      } else {
        // Reconnect/restart found the printer already idle: the ending was not
        // observed. Ambiguous — the operator (or stronger evidence) resolves it;
        // completion is NOT auto-recorded, so it can never be recorded twice.
        this.transitionRun(
          run,
          "UNKNOWN",
          {},
          "завершение печати не наблюдалось (обрыв связи/рестарт) — требуется проверка"
        );
      }
    }
    // PENDING/UNKNOWN + idle stays held: the start guard keeps the printer
    // blocked until the operator (or positive evidence) reconciles.
  }

  /**
   * Boot-time recovery, run together with the start-guard sweep: pending
   * dispatches whose command provably never left are unwound and re-queued;
   * everything else active is kept and reported, to be reconciled by
   * observation. Never re-dispatches anything.
   */
  recover(): { held: number; unwound: number; running: number } {
    const repos = this.store.repositories;
    let held = 0;
    let unwound = 0;
    let running = 0;
    for (const run of repos.printRuns.listActive()) {
      if (run.state === "RUNNING" || run.state === "PAUSED") {
        running += 1;
        continue; // poller observation will complete or flag it
      }
      const guard = repos.startGuards.get(run.printerId);
      const guardIsOurs = guard !== null && (guard.runId === run.id || sameFile(guard.file, run.file));
      if (run.state === "PENDING" && !guardIsOurs) {
        // The durable guard is written BEFORE the physical command leaves; its
        // absence proves the command was never sent. Safe to unwind.
        this.store.transaction(() => this.unwindNeverSent(run));
        unwound += 1;
        continue;
      }
      held += 1;
      this.logger.warn?.(
        { run: run.id, printer: run.printerId, state: run.state },
        "unreconciled dispatch held after restart — printer blocked until reconciled"
      );
    }
    return { held, unwound, running };
  }

  /**
   * Operator resolution of an UNKNOWN/stuck run after physically checking the
   * printer. Refused while the device is observably printing the run's file.
   */
  resolveRun(
    runId: string,
    outcome: "SUCCEEDED" | "FAILED" | "CANCELLED",
    options: { status?: PrinterLiveStatus; actor?: string; reason?: string } = {}
  ): PrintRun {
    const repos = this.store.repositories;
    const run = repos.printRuns.getById(runId);
    if (!run) throw new NotFoundError(`Печать «${runId}»`);
    const status = options.status;
    if (
      status &&
      (status.status === "printing" || status.status === "paused") &&
      sameFile(status.currentFile, run.file)
    ) {
      throw new JobError(
        `Принтер сейчас печатает «${status.currentFile}» — разрешать эту печать вручную нельзя`
      );
    }
    return this.completeRun(runId, outcome, { reason: options.reason, actor: options.actor });
  }

  // ── State movers (each wraps its own transaction) ─────────────────────────

  /** Positive-evidence attach: PENDING/UNKNOWN run → RUNNING, cascading the chain. */
  private attachRun(run: PrintRun, why: string): void {
    this.store.transaction(() => {
      const repos = this.store.repositories;
      const iso = this.nowIso();
      const current = repos.printRuns.getById(run.id);
      if (!current || (current.state !== "PENDING" && current.state !== "UNKNOWN")) return;

      assertTransition("печать", PRINT_RUN_TRANSITIONS, current.state, "RUNNING");
      repos.printRuns.update({
        ...current,
        state: "RUNNING",
        startedAt: current.startedAt ?? iso,
        updatedAt: iso
      });
      this.audit("print_run", current.id, "reconciled_running", { detail: { why } });

      if (current.dispatchAttemptId) {
        const attempt = repos.dispatchAttempts.getById(current.dispatchAttemptId);
        if (attempt && (attempt.state === "PENDING" || attempt.state === "SENT")) {
          let cur = attempt;
          if (cur.state === "PENDING") {
            assertTransition("попытка запуска", DISPATCH_ATTEMPT_TRANSITIONS, cur.state, "SENT");
            cur = repos.dispatchAttempts.update({ ...cur, state: "SENT", updatedAt: iso });
          }
          assertTransition("попытка запуска", DISPATCH_ATTEMPT_TRANSITIONS, cur.state, "ACKED");
          repos.dispatchAttempts.update({ ...cur, state: "ACKED", completedAt: iso, updatedAt: iso });
        }
      }

      const task = repos.tasks.getById(current.taskId);
      if (task && (task.state === "DISPATCHING" || task.state === "ASSIGNED")) {
        let cur = task;
        if (cur.state === "ASSIGNED") {
          assertTransition("задание", PRINT_TASK_TRANSITIONS, cur.state, "DISPATCHING");
          cur = repos.tasks.update({ ...cur, state: "DISPATCHING", updatedAt: iso });
        }
        assertTransition("задание", PRINT_TASK_TRANSITIONS, cur.state, "PRINTING");
        repos.tasks.update({ ...cur, state: "PRINTING", updatedAt: iso });
      }

      const entry = repos.queue.findByTaskId(current.taskId);
      if (entry && entry.state !== "RELEASED") {
        assertTransition("запись очереди", QUEUE_ENTRY_TRANSITIONS, entry.state, "RELEASED");
        repos.queue.update({ ...entry, state: "RELEASED", updatedAt: iso });
      }

      const assignment = repos.assignments.getById(current.assignmentId);
      if (assignment && assignment.state === "RESERVED") {
        assertTransition("назначение", ASSIGNMENT_TRANSITIONS, assignment.state, "ACTIVE");
        repos.assignments.update({ ...assignment, state: "ACTIVE", updatedAt: iso });
      }
      if (current.bedCycleId) {
        const bed = repos.bedCycles.getById(current.bedCycleId);
        if (bed && bed.state === "RESERVED") {
          assertTransition("цикл стола", BED_CYCLE_TRANSITIONS, bed.state, "RUNNING");
          repos.bedCycles.update({ ...bed, state: "RUNNING", updatedAt: iso });
        }
      }

      // The dispatched start is confirmed and durably RUNNING — the guard has
      // done its job and is released with the same evidence.
      const guard = repos.startGuards.get(current.printerId);
      if (guard && (guard.runId === current.id || sameFile(guard.file, current.file))) {
        repos.startGuards.delete(current.printerId);
      }
    });
  }

  /**
   * Completes a run exactly once (terminal transitions refuse a repeat) and
   * cascades: task → COMPLETED/FAILED/CANCELLED, assignment → RELEASED, bed →
   * AWAITING_CLEARANCE, attempt closed, guard dropped.
   */
  completeRun(
    runId: string,
    outcome: "SUCCEEDED" | "FAILED" | "CANCELLED",
    options: { reason?: string; actor?: string } = {}
  ): PrintRun {
    return this.store.transaction(() => {
      const repos = this.store.repositories;
      const iso = this.nowIso();
      const run = repos.printRuns.getById(runId);
      if (!run) throw new NotFoundError(`Печать «${runId}»`);
      assertTransition("печать", PRINT_RUN_TRANSITIONS, run.state, outcome);

      const startedMs = run.startedAt ? Date.parse(run.startedAt) : NaN;
      const durationS =
        run.durationS ??
        (Number.isFinite(startedMs) ? Math.max(0, Math.round((this.now().getTime() - startedMs) / 1000)) : null);

      const saved = repos.printRuns.update({
        ...run,
        state: outcome,
        endedAt: iso,
        durationS,
        progress: outcome === "SUCCEEDED" ? 1 : run.progress,
        updatedAt: iso,
        metadata: options.reason ? { ...run.metadata, endReason: options.reason } : run.metadata
      });
      this.audit("print_run", run.id, "completed", {
        from: run.state,
        to: outcome,
        actor: options.actor,
        detail: options.reason ? { reason: options.reason } : {}
      });

      if (run.dispatchAttemptId) {
        const attempt = repos.dispatchAttempts.getById(run.dispatchAttemptId);
        if (attempt && (attempt.state === "PENDING" || attempt.state === "SENT")) {
          let cur = attempt;
          if (cur.state === "PENDING") {
            cur = repos.dispatchAttempts.update({ ...cur, state: "SENT", updatedAt: iso });
          }
          repos.dispatchAttempts.update({ ...cur, state: "ACKED", completedAt: iso, updatedAt: iso });
        }
      }

      const taskTarget =
        outcome === "SUCCEEDED" ? "COMPLETED" : outcome === "FAILED" ? "FAILED" : "CANCELLED";
      const task = repos.tasks.getById(run.taskId);
      if (task && !["COMPLETED", "FAILED", "CANCELLED"].includes(task.state)) {
        if (task.state === "PRINTING") {
          repos.tasks.update({ ...task, state: taskTarget, reason: options.reason ?? task.reason, updatedAt: iso });
        } else if (task.state === "DISPATCHING") {
          // DISPATCHING → PRINTING → terminal keeps the machine honest.
          const printing = repos.tasks.update({ ...task, state: "PRINTING", updatedAt: iso });
          repos.tasks.update({ ...printing, state: taskTarget, reason: options.reason ?? task.reason, updatedAt: iso });
        }
        this.audit("print_task", run.taskId, "finished", { to: taskTarget, actor: options.actor });
      }

      const entry = repos.queue.findByTaskId(run.taskId);
      if (entry && entry.state !== "RELEASED") {
        repos.queue.update({ ...entry, state: "RELEASED", updatedAt: iso });
      }

      const assignment = repos.assignments.getById(run.assignmentId);
      if (assignment && (assignment.state === "ACTIVE" || assignment.state === "RESERVED")) {
        repos.assignments.update({ ...assignment, state: "RELEASED", updatedAt: iso });
      }
      if (run.bedCycleId) {
        const bed = repos.bedCycles.getById(run.bedCycleId);
        if (bed && (bed.state === "RUNNING" || bed.state === "RESERVED")) {
          const to = bed.state === "RUNNING" ? "AWAITING_CLEARANCE" : "CLEAR";
          repos.bedCycles.update({
            ...bed,
            state: to,
            clearedAt: to === "CLEAR" ? iso : bed.clearedAt,
            updatedAt: iso
          });
        }
      }

      const guard = repos.startGuards.get(run.printerId);
      if (guard && (guard.runId === run.id || sameFile(guard.file, run.file))) {
        repos.startGuards.delete(run.printerId);
      }
      return saved;
    });
  }

  private unwindNeverSent(run: PrintRun): void {
    const repos = this.store.repositories;
    const iso = this.nowIso();
    const current = repos.printRuns.getById(run.id);
    if (!current || current.state !== "PENDING") return;

    repos.printRuns.update({
      ...current,
      state: "CANCELLED",
      endedAt: iso,
      updatedAt: iso,
      metadata: { ...current.metadata, dispatchOutcome: "never-sent (restart before dispatch)" }
    });
    this.audit("print_run", current.id, "unwound_never_sent", {});

    if (current.dispatchAttemptId) {
      const attempt = repos.dispatchAttempts.getById(current.dispatchAttemptId);
      if (attempt && attempt.state === "PENDING") {
        repos.dispatchAttempts.update({
          ...attempt,
          state: "FAILED",
          error: "рестарт до отправки команды",
          completedAt: iso,
          updatedAt: iso
        });
      }
    }
    const assignment = repos.assignments.getById(current.assignmentId);
    if (assignment && assignment.state === "RESERVED") {
      repos.assignments.update({ ...assignment, state: "CANCELLED", updatedAt: iso });
    }
    if (current.bedCycleId) {
      const bed = repos.bedCycles.getById(current.bedCycleId);
      if (bed && bed.state === "RESERVED") {
        repos.bedCycles.update({ ...bed, state: "CLEAR", clearedAt: iso, updatedAt: iso });
      }
    }
    const task = repos.tasks.getById(current.taskId);
    if (task && task.state === "DISPATCHING") {
      const back = repos.tasks.update({ ...task, state: "ASSIGNED", updatedAt: iso });
      repos.tasks.update({
        ...back,
        state: "QUEUED",
        reason: "рестарт до отправки команды — задание возвращено в очередь",
        updatedAt: iso
      });
    }
  }

  private transitionRun(
    run: PrintRun,
    to: PrintRun["state"],
    patch: Partial<PrintRun>,
    why: string
  ): void {
    this.store.transaction(() => {
      const repos = this.store.repositories;
      const current = repos.printRuns.getById(run.id);
      if (!current || current.state === to) return;
      assertTransition("печать", PRINT_RUN_TRANSITIONS, current.state, to);
      repos.printRuns.update({ ...current, ...patch, state: to, updatedAt: this.nowIso() });
      this.audit("print_run", run.id, "transition", { from: current.state, to, detail: { why } });
    });
  }

  private updateProgress(run: PrintRun, progress: number): void {
    if (!Number.isFinite(progress)) return;
    const clamped = Math.min(1, Math.max(0, progress));
    if (run.progress !== null && Math.abs(clamped - run.progress) < 0.01) return;
    this.store.transaction(() => {
      const repos = this.store.repositories;
      const current = repos.printRuns.getById(run.id);
      if (!current || current.state !== "RUNNING") return;
      repos.printRuns.update({ ...current, progress: clamped, updatedAt: this.nowIso() });
    });
  }

  private audit(
    entityType: AuditEntityType,
    entityId: string,
    action: string,
    extra: { from?: string; to?: string; actor?: string; detail?: Metadata } = {}
  ): void {
    this.store.repositories.audit.insert({
      id: newId(ID_PREFIX.auditEvent),
      at: this.nowIso(),
      entityType,
      entityId,
      action,
      fromState: extra.from ?? null,
      toState: extra.to ?? null,
      actor: extra.actor ?? "system",
      detail: extra.detail ?? {}
    });
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
