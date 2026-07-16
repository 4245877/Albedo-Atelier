import { JobError, MaterialError, NotFoundError, PrinterOfflineError } from "../core/errors";
import type { Automation, NightCandidate, NightPrint, QueueJob } from "../domain/dashboard/types";
import { env } from "../shared/env";
import { FulfillmentInventoryClient } from "../infra/fulfillment/inventoryClient";
import { loadPrintersConfig, type PrinterConfig, type PrinterConfigSource } from "../infra/printers/config";
import {
  fetchPrinterFiles,
  supportsPrinterFiles,
  type PrinterFilesListing
} from "../infra/printers/files";
import { shutdownPrinterConnections } from "../infra/printers/status";
import { AutomationStore } from "./automationStore";
import { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import { DashboardReadModel } from "./dashboardReadModel";
import { runDriverOperation } from "./driverErrors";
import { EventFeed } from "./eventFeed";
import { FilamentConsumption } from "./filamentConsumption";
import { FilamentSync } from "./filamentSync";
import { materialsIncompatible, type NightPlanEntry } from "./nightPlanner";
import { MonitoringLease } from "./monitoringLease";
import { PrinterPoller } from "./printerPoller";
import type { StoreLogger } from "../shared/logger";
import { QueueStore, type NewQueueJobInput } from "./queueStore";
import { SnapshotStore } from "../infra/persistence/snapshotStore";
import { StateStore } from "../infra/persistence/stateStore";

/**
 * The farm, assembled from real sources: printer configs come from
 * `config/printers.json` (or `PRINTERS_CONFIG_JSON`); live telemetry is polled
 * from the devices (Moonraker HTTP / Bambu MQTT / Creality WebSocket); camera
 * frames are real snapshots; the event feed records transitions the poller saw.
 *
 * This class owns the printer config and wires the collaborators together — the
 * background {@link PrinterPoller}, {@link CameraService}, {@link QueueStore},
 * {@link EventFeed}, {@link PrinterCommandService} and the read-only
 * {@link DashboardReadModel} — then exposes the *actions* as its own API for
 * the HTTP routes. Pure reads are served by the read model directly via
 * {@link FarmStore.reads}; only operations that coordinate several
 * collaborators (commands, queue starts, files, snapshots) live here.
 * The durable slice of the state (queue, event feed, today counters) is loaded
 * from and persisted to a JSON file via {@link StateStore}, so it survives a
 * restart. There is no seed data: anything the farm does not know is returned
 * empty/null and the dashboard shows it as unavailable.
 */
export class FarmStore {
  private configs: PrinterConfig[] = [];
  private configSource: PrinterConfigSource = { kind: "none" };
  private readonly startedAt = Date.now();

  private readonly state: StateStore;
  private readonly events: EventFeed;
  private readonly cameras = new CameraService();
  private readonly snapshots: SnapshotStore;
  private readonly inventory = new FulfillmentInventoryClient();
  private readonly filament: FilamentConsumption;
  private readonly filamentSync: FilamentSync;
  private readonly queue: QueueStore;
  private readonly automations: AutomationStore;
  /** "Operator is watching" lease renewed by the dashboard; in-memory only. */
  private readonly monitoring = new MonitoringLease();
  private readonly poller: PrinterPoller;
  private readonly commands: PrinterCommandService;
  /**
   * Read-only projections of the live farm state — every dashboard/API read
   * goes straight to the read model instead of through one-line delegates
   * here. The read model exposes no mutable internals: it returns fresh
   * arrays/objects computed per call.
   */
  readonly reads: DashboardReadModel;

  /** Current selection in the night-print candidate list (ephemeral UI state). */
  private nightPick = 0;

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

  constructor(
    stateFilePath: string = env.stateFilePath,
    snapshotsDir: string = env.snapshotsDir
  ) {
    this.state = new StateStore(stateFilePath);
    const persisted = this.state.load();
    const persist = (): void => this.state.save();

    this.events = new EventFeed(persisted.feed, persist);
    this.snapshots = new SnapshotStore(snapshotsDir, persisted.snapshots, persist, {
      retainPerPrinter: env.snapshotRetainPerPrinter
    });
    this.queue = new QueueStore(this.events, persisted.queue, persist);
    this.automations = new AutomationStore(persisted.automations, this.events, persist);
    // Deductions fulfillment never confirmed are reloaded into the retry queue,
    // so a restart cannot lose them (delivery stays deduped by idempotencyKey).
    this.filament = new FilamentConsumption(
      this.inventory,
      this.events,
      persist,
      persisted.pendingConsumes
    );
    // Same client as the deduction path: it pushes the live loaded reel so
    // fulfillment binds it to a stock position automatically (no manual entry).
    this.filamentSync = new FilamentSync(this.inventory);
    this.poller = new PrinterPoller(
      () => this.enabledConfigs(),
      this.cameras,
      this.events,
      persist,
      persisted.today,
      () => this.automations.isEnabled("night-lights"),
      this.filament,
      undefined,
      this.filamentSync,
      { monitoringLease: this.monitoring }
    );
    this.commands = new PrinterCommandService(
      (id) => this.configById(id),
      this.poller,
      this.poller.lights,
      this.cameras,
      this.events,
      this.snapshots
    );
    this.reads = new DashboardReadModel(
      () => this.enabledConfigs(),
      (id) => this.configById(id),
      () => this.configSource,
      this.startedAt,
      this.poller,
      this.cameras,
      this.queue,
      this.events,
      this.automations,
      () => this.nightPick,
      this.snapshots
    );

    // Snapshot the whole durable state on every save.
    this.state.bind(() => ({
      version: 1,
      queue: this.queue.serialize(),
      feed: this.events.list(),
      today: this.poller.today.serialize(),
      automations: this.automations.serialize(),
      snapshots: this.snapshots.serialize(),
      pendingConsumes: this.filament.serialize()
    }));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Loads the printer config and starts the background poll loop. */
  async start(logger: StoreLogger = {}): Promise<void> {
    this.state.useLogger(logger);
    if (this.state.loadWarning) {
      logger.warn?.({ warning: this.state.loadWarning }, "state store problem");
    }

    const { printers, source } = await loadPrintersConfig();
    this.configs = printers;
    this.configSource = source;

    if (source.warning) {
      logger.warn?.({ warning: source.warning }, "printers config problem");
    }
    logger.info?.(
      { printers: printers.length, source: source.kind },
      "farm store started with real printer config"
    );
    logger.info?.(
      { enabled: this.inventory.enabled },
      this.inventory.enabled
        ? "fulfillment filament auto-consume enabled"
        : "fulfillment filament auto-consume disabled (set FULFILLMENT_API_URL to enable)"
    );

    this.commands.useLogger(logger);
    await this.poller.start(logger);
  }

  async stop(): Promise<void> {
    // Await the in-flight poll before closing connections and flushing, so no
    // late telemetry write races past the final save.
    await this.poller.stop();
    shutdownPrinterConnections();
    // Persist the tail of accrued printing-hours (checkpointed only ~once a
    // minute while running), then wait for every scheduled write to settle.
    this.state.save();
    await this.state.flush();
  }

  /** Awaits all pending state writes (used on shutdown and in tests). */
  flush(): Promise<void> {
    return this.state.flush();
  }

  pollOnce(): Promise<void> {
    return this.poller.pollOnce();
  }

  // ── Cameras (→ CameraService; facade resolves the config) ────────────────

  /**
   * A real camera frame. With `ensureLight`, the chamber light is switched on
   * first when the night-light schedule would want it on (see
   * {@link LightScheduler.ensureForSnapshot}) so a night snapshot is not
   * captured in the dark; the frame is then re-pulled fresh once the light has
   * had a moment to come up. The light is left on for the schedule to manage — it
   * is never restored to off here.
   */
  async getCameraFrame(id: string, options: { ensureLight?: boolean } = {}) {
    const printer = this.configById(id);
    const turnedOn = options.ensureLight
      ? await this.poller.lights.ensureForSnapshot(printer)
      : false;
    if (turnedOn) {
      await new Promise((resolve) => setTimeout(resolve, env.snapshotLightSettleMs));
    }
    return this.cameras.getFrame(printer, { fresh: turnedOn });
  }
  getCameraStream(id: string) {
    return this.cameras.getStream(this.configById(id));
  }

  // ── Saved snapshots (→ SnapshotStore; facade resolves the config) ────────

  /** Metadata for every saved snapshot of a printer, newest first. */
  listSnapshots(id: string) {
    this.configById(id);
    return this.snapshots.list(id);
  }

  /** Metadata for the most recent saved snapshot; throws when there is none. */
  latestSnapshot(id: string) {
    this.configById(id);
    const meta = this.snapshots.latest(id);
    if (!meta) {
      throw new NotFoundError(`Snapshot for printer "${id}"`);
    }
    return meta;
  }

  /** One saved snapshot's metadata and image bytes; throws when missing. */
  async readSnapshot(id: string, snapshotId: string) {
    this.configById(id);
    const meta = this.snapshots.get(id, snapshotId);
    if (!meta) {
      throw new NotFoundError(`Snapshot "${snapshotId}"`);
    }
    const data = await this.snapshots.read(meta);
    return { meta, data };
  }

  // ── Actions (→ CommandService / QueueStore) ──────────────────────────────

  pausePrinter(id: string) {
    return this.commands.pause(id);
  }
  resumePrinter(id: string) {
    return this.commands.resume(id);
  }
  cancelPrinter(id: string) {
    return this.commands.cancel(id);
  }
  setLight(id: string, on: boolean) {
    return this.commands.setLight(id, on);
  }

  /**
   * Creates or extends the farm-wide monitoring lease (the dashboard renews it
   * while its tab is visible). Idempotent: repeated calls only move the expiry
   * forward. While the lease is live the light policy keeps supported printers
   * lit; there is no explicit release — the lease expires on its own.
   */
  renewMonitoringLease(): { ok: true; ttlSeconds: number; expiresAt: string } {
    const lease = this.monitoring.renew();
    return {
      ok: true,
      ttlSeconds: Math.round(lease.ttlMs / 1000),
      expiresAt: lease.expiresAt.toISOString()
    };
  }
  snapshotPrinter(id: string) {
    return this.commands.snapshot(id);
  }
  addQueueJob(input: NewQueueJobInput) {
    return this.queue.add(input);
  }

  /** Removes a queue job by id (operator action); 404s when the id is unknown. */
  removeQueueJob(id: string): QueueJob {
    return this.queue.removeById(id);
  }

  /** Parks a queue job in `review` so it stops blocking start-next; 404s when unknown. */
  reviewQueueJob(id: string, reason?: string): QueueJob {
    return this.queue.moveToReview(id, reason);
  }

  /**
   * Lists one directory of the printer's on-device files (path relative to the
   * G-code root; "" is the root). Unsupported protocols (Bambu, Creality WS)
   * and offline printers fail honestly before any device call is attempted.
   */
  async listPrinterFiles(id: string, path = ""): Promise<PrinterFilesListing> {
    const printer = this.configById(id);
    if (!supportsPrinterFiles(printer)) {
      throw new JobError(
        `Просмотр файлов на «${printer.name}» пока поддерживается только для Moonraker-принтеров`
      );
    }
    const status = this.poller.getStatus(id);
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
    return this.commands.startPrint(id, file);
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
  startNext(): Promise<{ job: QueueJob; printer: string }> {
    return this.runQueueDispatch(async () => {
      const job = this.queue.findNextReady();
      if (!job) {
        throw new JobError("В очереди нет заданий, готовых к запуску");
      }
      const printer = this.reads.resolvePrinter(job.printer);
      if (!printer) {
        throw new JobError(`Принтер «${job.printer}» не найден в конфигурации фермы`);
      }
      if (!job.file) {
        throw new JobError(
          `У задания «${job.title}» не задан файл — укажите имя .gcode на принтере, чтобы запустить его удалённо`
        );
      }
      // A concrete material contradiction refuses the start (same rule as the
      // night planner); unknown material on either side is not a contradiction.
      if (materialsIncompatible(job.material, printer.material)) {
        throw new MaterialError(
          `Материал задания «${job.title}» (${job.material}) не совпадает с заправленным в «${printer.name}» (${printer.material})`
        );
      }

      await this.commands.startPrint(printer.id, job.file);
      this.queue.remove(job.id);
      return { job, printer: printer.name };
    });
  }

  toggleAutomation(id: string, on?: boolean): Automation {
    return this.automations.toggle(id, on);
  }

  advanceNightPick(): NightPrint {
    const plan = this.reads.getNightPlan();
    if (plan.length === 0) {
      throw new JobError(
        "Нет кандидатов на ночь — добавьте в очередь готовые задания (или включите подсказки ночной печати)"
      );
    }
    this.nightPick = (this.nightPick + 1) % plan.length;
    return this.reads.getNight();
  }

  startNight(): Promise<{ candidate: NightCandidate; window: string }> {
    return this.runQueueDispatch(async () => {
      const plan = this.reads.getNightPlan();
      if (plan.length === 0) {
        throw new JobError(
          "Нет кандидатов на ночь — добавьте в очередь готовые задания (или включите подсказки ночной печати)"
        );
      }

      const entry: NightPlanEntry = plan[Math.min(this.nightPick, plan.length - 1)];
      if (entry.blockers.length > 0) {
        throw new JobError(
          `Нельзя запустить «${entry.job.title}» на ночь: ${entry.blockers.join("; ")}`
        );
      }

      // blockers === [] guarantees a resolved printer and a file (see nightPlanner),
      // but re-narrow for the type checker before dispatch.
      const printer = entry.printer;
      const file = entry.job.file;
      if (!printer || !file) {
        throw new JobError(`Нельзя запустить «${entry.job.title}» на ночь — недостаточно данных`);
      }

      await this.commands.startPrint(printer.id, file);
      this.queue.remove(entry.job.id);
      return { candidate: entry.candidate, window: env.nightWindow };
    });
  }

  // ── Config resolution (shared by the collaborators) ──────────────────────

  private enabledConfigs(): PrinterConfig[] {
    return this.configs.filter((p) => p.enabled);
  }

  private configById(id: string): PrinterConfig {
    const printer = this.configs.find((p) => p.id === id && p.enabled);
    if (!printer) {
      throw new NotFoundError(`Printer "${id}"`);
    }
    return printer;
  }
}

export const farmStore = new FarmStore();
