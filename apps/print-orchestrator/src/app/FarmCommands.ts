import type { FarmRuntime } from "../bootstrap/createRuntime";
import {
  JobError,
  NotFoundError,
  PreviewConflictError,
  PrinterOfflineError,
  PrintIdentityConflictError
} from "../core/errors";
import type { Automation, NightCandidate, NightPrint, QueueJob } from "../domain/dashboard/types";
import type { PrintQueueStore } from "../domain/print/repositories";
import { env } from "../shared/env";
import {
  fetchPrinterFiles,
  normalizeStartablePath,
  supportsPrinterFiles,
  type PrinterFilesListing
} from "../infra/printers/files";
import type { DispatchService } from "./dispatch/dispatchService";
import type { RunLifecycleService } from "./dispatch/runLifecycle";
import { runDriverOperation } from "./driverErrors";
import type { NightPlanEntry } from "./nightPlanner";
import { toLegacyQueueJob } from "./printQueue/projection";

/**
 * The body accepted by `POST /api/queue` (the operator "add job" form). Fields
 * are `unknown` and validated in {@link FarmCommands.addQueueJob} before they
 * reach the SQLite model, so a malformed body fails honestly instead of
 * persisting garbage.
 */
export type NewQueueJobInput = {
  title?: unknown;
  printer?: unknown;
  material?: unknown;
  eta?: unknown;
  at?: unknown;
  night?: unknown;
  file?: unknown;
};

/**
 * Every public state-changing operation of the farm, plus the config-resolving
 * reads that back them (cameras, saved snapshots, on-device files). Each method
 * delegates to an already-built specialised service on the {@link FarmRuntime}
 * — the device command service, the SQLite {@link PrintQueueService}, the
 * canonical {@link DispatchService}, the automations/monitoring/filament stores
 * — and never re-implements their business logic. It creates no infrastructure
 * and builds no dashboard projections.
 */
export class FarmCommands {
  constructor(private readonly runtime: FarmRuntime) {}

  /**
   * Serializes queue dispatches (start-next and night start share the queue):
   * two parallel requests can otherwise pick the same job, both see the same
   * idle status and both send a start before the job is removed. The second
   * request re-reads the queue after the first completes, so it either takes
   * the next job or fails honestly with an empty queue.
   */
  private queueDispatchChain: Promise<unknown> = Promise.resolve();

  private runQueueDispatch<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queueDispatchChain.catch(() => {}).then(task);
    this.queueDispatchChain = next.catch(() => {});
    return next;
  }

  // ── Cameras (→ CameraService; the runtime resolves the config) ─────────────

  /**
   * A real camera frame. With `ensureLight`, the chamber light is switched on
   * first when the night-light schedule would want it on (see
   * {@link LightScheduler.ensureForSnapshot}) so a night snapshot is not
   * captured in the dark; the frame is then re-pulled fresh once the light has
   * had a moment to come up. The light is left on for the schedule to manage.
   */
  async getCameraFrame(id: string, options: { ensureLight?: boolean } = {}) {
    const printer = this.runtime.configById(id);
    const turnedOn = options.ensureLight
      ? await this.runtime.poller.lights.ensureForSnapshot(printer)
      : false;
    if (turnedOn) {
      await new Promise((resolve) => setTimeout(resolve, env.snapshotLightSettleMs));
    }
    return this.runtime.cameras.getFrame(printer, { fresh: turnedOn });
  }

  getCameraStream(id: string) {
    return this.runtime.cameras.getStream(this.runtime.configById(id));
  }

  // ── Saved snapshots (→ SnapshotStore; the runtime resolves the config) ─────

  /** Metadata for every saved snapshot of a printer, newest first. */
  listSnapshots(id: string) {
    this.runtime.configById(id);
    return this.runtime.snapshots.list(id);
  }

  /** Metadata for the most recent saved snapshot; throws when there is none. */
  latestSnapshot(id: string) {
    this.runtime.configById(id);
    const meta = this.runtime.snapshots.latest(id);
    if (!meta) {
      throw new NotFoundError(`Snapshot for printer "${id}"`);
    }
    return meta;
  }

  /** One saved snapshot's metadata and image bytes; throws when missing. */
  async readSnapshot(id: string, snapshotId: string) {
    this.runtime.configById(id);
    const meta = this.runtime.snapshots.get(id, snapshotId);
    if (!meta) {
      throw new NotFoundError(`Snapshot "${snapshotId}"`);
    }
    const data = await this.runtime.snapshots.read(meta);
    return { meta, data };
  }

  // ── Printer commands (→ PrinterCommandService) ─────────────────────────────

  pausePrinter(id: string) {
    return this.runtime.deviceCommands.pause(id);
  }
  resumePrinter(id: string) {
    return this.runtime.deviceCommands.resume(id);
  }
  /**
   * Cancels the print on a device. Identity is verified at TWO levels before
   * anything is sent: the canonical `runId` (when the caller snapshotted one)
   * against the SQLite active run — this catches a *different run of the same
   * file name* — and the on-device file name against a fresh device read (in
   * the command service). Either mismatch is a 409, nothing is cancelled.
   */
  cancelPrinter(id: string, expect?: { job?: string | null; runId?: string | null }) {
    if (expect && expect.runId !== undefined) {
      const active = this.runtime.activeRunForPrinter(id);
      if ((expect.runId ?? null) !== (active?.id ?? null)) {
        throw new PrintIdentityConflictError(
          this.runtime.configById(id).name,
          expect.runId ?? null,
          active?.id ?? null
        );
      }
    }
    return this.runtime.deviceCommands.cancel(id, expect);
  }
  setLight(id: string, on: boolean) {
    return this.runtime.deviceCommands.setLight(id, on);
  }
  snapshotPrinter(id: string) {
    return this.runtime.deviceCommands.snapshot(id);
  }
  /**
   * Operator override to lift a held start guard after physically checking the
   * printer (e.g. a start whose response was lost and the print did not run).
   * Refuses while the printer is actually printing.
   */
  clearStartGuard(id: string) {
    return this.runtime.deviceCommands.clearStartGuard(id);
  }

  // ── Monitoring / filament observability ────────────────────────────────────

  /**
   * Creates or extends the farm-wide monitoring lease (the dashboard renews it
   * while its tab is visible). Idempotent: repeated calls only move the expiry
   * forward. While the lease is live the light policy keeps supported printers
   * lit; there is no explicit release — the lease expires on its own.
   */
  renewMonitoringLease(): { ok: true; ttlSeconds: number; expiresAt: string } {
    const lease = this.runtime.monitoring.renew();
    return {
      ok: true,
      ttlSeconds: Math.round(lease.ttlMs / 1000),
      expiresAt: lease.expiresAt.toISOString()
    };
  }

  /**
   * Observability for the filament-deduction retry queue: backlog size and the
   * per-reason counters of finally-dropped deductions (overflow/expired/rejected).
   */
  filamentQueueStats(): {
    pending: number;
    dropped: Record<"overflow" | "expired" | "rejected", number>;
  } {
    return this.runtime.filament.metrics();
  }

  // ── Queue operations (→ PrintQueueService / DispatchService) ───────────────

  /**
   * Adds an operator job — into the canonical SQLite queue (the legacy JSON
   * queue is no longer written). Field validation mirrors the legacy rules: a
   * file is normalized at the door, an empty title refuses.
   */
  addQueueJob(input: NewQueueJobInput): QueueJob {
    const file =
      typeof input.file === "string" && input.file.trim()
        ? normalizeStartablePath(input.file)
        : undefined;
    const detail = this.runtime.printQueue.createTask({
      title: typeof input.title === "string" ? input.title : "",
      printer: typeof input.printer === "string" ? input.printer : undefined,
      material: typeof input.material === "string" ? input.material : undefined,
      eta: typeof input.eta === "string" ? input.eta : undefined,
      at: typeof input.at === "string" ? input.at : undefined,
      night: input.night === true,
      file
    });
    const job = toLegacyQueueJob({
      entry: detail.queueEntry as NonNullable<typeof detail.queueEntry>,
      task: detail.task,
      artifact: detail.artifact
    });
    this.runtime.events.push("＋", `Задание «${detail.task.title}» добавлено в очередь`, "info");
    return job;
  }

  /** Resolves a projection job id (task id, or a legacy `qN` id) to the task. */
  private taskByQueueJobId(id: string) {
    const repos = (this.runtime.printQueueStore as PrintQueueStore).repositories;
    return repos.tasks.getById(id) ?? repos.tasks.findByLegacyRef(id);
  }

  /**
   * Removes a queue job by id (operator action) — the task is CANCELLED in the
   * canonical model (kept as history), never physically deleted. Refuses for a
   * task already dispatching/printing: cancelling a live print goes through the
   * printer cancel flow with run identity, not through a queue row delete.
   */
  removeQueueJob(id: string): QueueJob {
    this.runtime.ensureQueue();
    const task = this.taskByQueueJobId(id);
    if (!task) throw new NotFoundError(`Задание очереди «${id}»`);
    if (task.state === "DISPATCHING" || task.state === "PRINTING") {
      throw new JobError(
        `Задание «${task.title}» уже запущено — отмените печать на принтере, а не строку очереди`
      );
    }
    const repos = (this.runtime.printQueueStore as PrintQueueStore).repositories;
    const entry = repos.queue.findByTaskId(task.id);
    const snapshot = toLegacyQueueJob({
      entry: entry ?? {
        id: "",
        taskId: task.id,
        position: 0,
        state: "RELEASED",
        enqueuedAt: task.createdAt,
        updatedAt: task.updatedAt,
        version: 1
      },
      task,
      artifact: task.artifactId ? repos.artifacts.getById(task.artifactId) : null
    });
    this.runtime.printQueue.cancelTask(task.id, "удалено оператором из очереди");
    this.runtime.events.push("✕", `Задание «${task.title}» удалено из очереди`, "info");
    return snapshot;
  }

  /** Parks a queue job in `review` so it stops blocking start-next; 404s when unknown. */
  reviewQueueJob(id: string, reason?: string): QueueJob {
    this.runtime.ensureQueue();
    const task = this.taskByQueueJobId(id);
    if (!task) throw new NotFoundError(`Задание очереди «${id}»`);
    const held = this.runtime.printQueue.holdTask(task.id, reason);
    const repos = (this.runtime.printQueueStore as PrintQueueStore).repositories;
    const entry = repos.queue.findByTaskId(held.id);
    this.runtime.events.push("⚑", `Задание «${held.title}» отложено на проверку`, "info");
    return toLegacyQueueJob({
      entry: entry as NonNullable<typeof entry>,
      task: held,
      artifact: held.artifactId ? repos.artifacts.getById(held.artifactId) : null
    });
  }

  // ── On-device files (→ printer drivers) ────────────────────────────────────

  /**
   * Lists one directory of the printer's on-device files (path relative to the
   * G-code root; "" is the root). Unsupported protocols (Bambu, Creality WS)
   * and offline printers fail honestly before any device call is attempted.
   */
  async listPrinterFiles(id: string, path = ""): Promise<PrinterFilesListing> {
    const printer = this.runtime.configById(id);
    if (!supportsPrinterFiles(printer)) {
      throw new JobError(
        `Просмотр файлов на «${printer.name}» пока поддерживается только для Moonraker-принтеров`
      );
    }
    const status = this.runtime.poller.getStatus(id);
    if (!status || !status.online) {
      throw new PrinterOfflineError(id);
    }
    // Path validation errors (AppError) pass through runDriverOperation untouched.
    return runDriverOperation(printer.id, () => fetchPrinterFiles(printer, path));
  }

  /**
   * Starts an on-device file picked in the file browser.
   * {@link PrinterCommandService.startPrint} is the single choke point: it
   * normalizes the path (no `..`/absolute/non-G-code paths reach the device)
   * and re-checks the live offline/busy/unsupported state at start time,
   * because the printer may have changed state since the file list was fetched.
   */
  startPrinterFile(id: string, file: string) {
    return this.runtime.deviceCommands.startPrint(id, file);
  }

  /**
   * Starts the next ready queue job on its target printer. Resolves the printer
   * from the job's printer field, dispatches a real remote start (Moonraker),
   * and drops the job from the queue once the device has accepted it. Fails
   * honestly when the job has no file or an invalid file path, the printer is
   * unknown/offline/busy, or the protocol does not support remote start.
   * Serialized via {@link runQueueDispatch} so two parallel requests cannot
   * dispatch the same job twice.
   */
  startNext(): Promise<{ job: QueueJob; printer: string; runId: string }> {
    return this.runQueueDispatch(async () => {
      this.runtime.ensureQueue();
      const rows = this.runtime.printQueue
        .listOpenQueue()
        .filter((row) => row.entry.state === "WAITING" && row.task.state === "QUEUED");
      if (rows.length === 0) {
        throw new JobError("В очереди нет заданий, готовых к запуску");
      }
      const row = rows[0];
      const job = toLegacyQueueJob(row);
      // The canonical dispatch: one SQLite transaction reserves the run,
      // assignment and guard; only then is the physical command sent. The gate
      // inside re-checks printer/material/file — no legacy pre-checks needed.
      const result = await (this.runtime.dispatchService as DispatchService).dispatch({
        taskId: row.task.id,
        mode: "manual"
      });
      // The run is durably RUNNING and the queue entry RELEASED — the guard has
      // nothing left to protect.
      this.runtime.deviceCommands.resolveStartGuard(result.printerId);
      return { job, printer: result.printerName, runId: result.runId };
    });
  }

  // ── Automations & night mode ───────────────────────────────────────────────

  toggleAutomation(id: string, on?: boolean): Automation {
    return this.runtime.automations.toggle(id, on);
  }

  advanceNightPick(): NightPrint {
    const plan = this.runtime.reads.getNightPlan();
    if (plan.length === 0) {
      throw new JobError(
        "Нет кандидатов на ночь — добавьте в очередь готовые задания (или включите подсказки ночной печати)"
      );
    }
    this.runtime.nightPick = (this.runtime.nightPick + 1) % plan.length;
    return this.runtime.reads.getNight();
  }

  /**
   * Launches the confirmed night candidate through the canonical dispatch.
   * `preview` is the immutable identity the operator confirmed (taskId + task
   * version + artifact hash from GET /night): any drift — queue change, task
   * edit, re-analysis, file change — refuses with 409 instead of starting
   * something the operator did not see.
   */
  startNight(
    preview: { taskId?: string; expectedTaskVersion?: number; artifactSha256?: string | null } = {}
  ): Promise<{ candidate: NightCandidate; window: string; runId: string }> {
    return this.runQueueDispatch(async () => {
      this.runtime.ensureQueue();
      const plan = this.runtime.reads.getNightPlan();
      if (plan.length === 0) {
        throw new JobError(
          "Нет кандидатов на ночь — добавьте в очередь готовые задания (или включите подсказки ночной печати)"
        );
      }

      let entry: NightPlanEntry;
      if (preview.taskId) {
        const found = plan.find((e) => e.job.id === preview.taskId);
        if (!found) {
          throw new PreviewConflictError(
            "Подтверждённый ночной кандидат исчез из плана — обновите список и подтвердите заново",
            { taskId: preview.taskId }
          );
        }
        entry = found;
      } else {
        entry = plan[Math.min(this.runtime.nightPick, plan.length - 1)];
      }

      // Fail-closed defence in depth: an unattended launch is only ever for a
      // job the operator explicitly marked for night. Even if the plan logic
      // changed, a non-night job can never be physically started here.
      if (entry.job.night !== true) {
        throw new JobError(
          `«${entry.job.title}» не отмечено для печати без присмотра — отметьте задание ночным и подтвердите запуск`
        );
      }
      if (entry.blockers.length > 0) {
        throw new JobError(
          `Нельзя запустить «${entry.job.title}» на ночь: ${entry.blockers.join("; ")}`
        );
      }

      // Preview identity: prefer what the CLIENT confirmed; fall back to the
      // server-built plan entry (still a real guard — the dispatch transaction
      // re-reads and compares). The dispatch gate re-verifies everything else.
      const result = await (this.runtime.dispatchService as DispatchService).dispatch({
        taskId: entry.job.id,
        mode: "night",
        expectedTaskVersion:
          preview.expectedTaskVersion ?? entry.candidate.taskVersion ?? undefined,
        expectedArtifactSha256:
          preview.artifactSha256 !== undefined
            ? preview.artifactSha256
            : entry.candidate.artifactSha256
      });
      this.runtime.deviceCommands.resolveStartGuard(result.printerId);
      return { candidate: entry.candidate, window: env.nightWindow, runId: result.runId };
    });
  }

  /**
   * Operator resolution of a run stuck in UNKNOWN (lost completion, restart
   * mid-print) after physically checking the printer. Refused while the device
   * is observably printing the run's file.
   */
  resolveRun(runId: string, outcome: "SUCCEEDED" | "FAILED" | "CANCELLED", reason?: string) {
    this.runtime.ensureQueue();
    const lifecycle = this.runtime.runLifecycle as RunLifecycleService;
    const run = (this.runtime.printQueueStore as PrintQueueStore).repositories.printRuns.getById(runId);
    return lifecycle.resolveRun(runId, outcome, {
      status: run ? this.runtime.poller.getStatus(run.printerId) : undefined,
      reason,
      actor: "operator"
    });
  }
}
