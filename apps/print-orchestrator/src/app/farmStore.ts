import path from "node:path";

import { JobError, MaterialError, NotFoundError, PrinterOfflineError } from "../core/errors";
import type { Automation, NightCandidate, NightPrint, QueueJob } from "../domain/dashboard/types";
import type { PrintQueueStore } from "../domain/print/repositories";
import { env, slicing, uploads } from "../shared/env";
import { importLegacyQueue } from "../infra/db/legacyImport";
import { openPrintQueueStore } from "../infra/db/store";
import { ArtifactStorage } from "../infra/storage/artifactStorage";
import { OrcaCatalogSource } from "../infra/slicing/catalogSource";
import { OrcaCliRunner } from "../infra/slicing/orcaCliRunner";
import type { SliceRunner } from "../infra/slicing/sliceRunner";
import { ArtifactService } from "./artifacts/artifactService";
import { PresetImportService } from "./slicing/presetImportService";
import { ProfileService, type SlicerPrinterRef } from "./slicing/profileService";
import { SliceService } from "./slicing/sliceService";
import { PrintQueueService } from "./printQueue/printQueueService";
import {
  SchedulerService,
  type SchedulerPrinterRef
} from "./scheduling/schedulerService";
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
  /**
   * The persistent print-queue backbone (SQLite). Opened lazily on first use —
   * never in the constructor — so merely importing the {@link farmStore}
   * singleton (as many tests and route modules do) opens no database file. The
   * one-time legacy import runs when this is first initialised.
   */
  private readonly dbPath: string;
  private readonly storageRoot: string;
  private readonly uploadTmpDir: string;
  private printQueueStore: PrintQueueStore | null = null;
  private printQueueService: PrintQueueService | null = null;
  /**
   * Content-addressed blob store + upload/analysis service for the file-upload
   * feature, opened lazily alongside {@link printQueueService}. Both write only
   * into the SQLite model — never the legacy JSON queue.
   */
  private artifactStorage: ArtifactStorage | null = null;
  private artifactService: ArtifactService | null = null;
  /**
   * OrcaSlicer preset import + profile/slice services, opened lazily alongside the
   * artifact service. The slice runner spawns the pinned OrcaSlicer CLI (or reports
   * it unavailable); all three write only into the SQLite model.
   */
  private sliceRunner: SliceRunner | null = null;
  private presetImportService: PresetImportService | null = null;
  private profileService: ProfileService | null = null;
  private sliceService: SliceService | null = null;
  /**
   * Cached OrcaSlicer runtime availability, probed on start and re-probed by the
   * slicing runtime report. The manual scheduler reads it synchronously to gate
   * un-sliced work (no runtime → honest blocker, never a faked slice).
   */
  private sliceRuntimeAvailable = false;
  /** Legacy queue snapshot captured at load, fed once into the SQLite import. */
  private readonly legacyQueueJobs: QueueJob[];

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
    snapshotsDir: string = env.snapshotsDir,
    // Default the queue DB next to the state file. For the singleton (default
    // state path) this is env.queueDbPath, honouring QUEUE_DB_PATH; a test that
    // passes its own temp state file gets an isolated sibling queue.db.
    dbPath: string = stateFilePath === env.stateFilePath
      ? env.queueDbPath
      : path.resolve(path.dirname(stateFilePath), "queue.db")
  ) {
    this.dbPath = dbPath;
    // Blob storage lives next to the queue DB. The singleton uses the configured
    // roots (honouring ARTIFACT_STORAGE_ROOT/UPLOAD_TMP_DIR); a test store with a
    // custom state file gets isolated siblings so uploads never touch real data.
    const usingDefaults = stateFilePath === env.stateFilePath;
    this.storageRoot = usingDefaults
      ? uploads.storageRoot
      : path.resolve(path.dirname(stateFilePath), "artifacts");
    this.uploadTmpDir = usingDefaults
      ? uploads.tmpDir
      : path.resolve(this.storageRoot, ".tmp");
    this.state = new StateStore(stateFilePath);
    const persisted = this.state.load();
    this.legacyQueueJobs = persisted.queue.jobs;
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

  /**
   * The persistent print-queue service (SQLite-backed), opened on first access.
   * Idempotent: the database is opened, migrated and the legacy queue imported
   * exactly once, on the first call.
   */
  get printQueue(): PrintQueueService {
    this.ensurePrintQueue();
    return this.printQueueService as PrintQueueService;
  }

  /**
   * The upload/analysis service (SQLite + content-addressed blobs), opened on
   * first access together with {@link printQueue}. Unfinished analyses are
   * re-queued once when the store is first initialised.
   */
  get artifacts(): ArtifactService {
    this.ensurePrintQueue();
    return this.artifactService as ArtifactService;
  }

  /**
   * The OrcaSlicer preset/slicing services (SQLite-backed), opened on first access
   * together with {@link printQueue}. Exposes the preset importer, the profile/set
   * management service and the slice pipeline. Unfinished slice variants are
   * recovered and (when enabled) the catalog is imported once on first init.
   */
  get slicing(): {
    presets: PresetImportService;
    profiles: ProfileService;
    slices: SliceService;
  } {
    this.ensurePrintQueue();
    return {
      presets: this.presetImportService as PresetImportService,
      profiles: this.profileService as ProfileService,
      slices: this.sliceService as SliceService
    };
  }

  /**
   * The manual-scheduler service (SQLite-backed), built on each access over the
   * lazily-opened store with the *current* printer telemetry and runtime flag. It
   * reads live evidence and delegates decisions to the pure `domain/scheduling`;
   * it never touches the legacy `/api/queue` or `state.json`.
   */
  get scheduler(): SchedulerService {
    this.ensurePrintQueue();
    const store = this.printQueueStore as PrintQueueStore;
    return new SchedulerService(store, () => this.schedulerPrinters(), {
      now: () => new Date(),
      runtimeAvailable: this.sliceRuntimeAvailable,
      nightSafetyBufferRatio: env.nightEtaSafetyBuffer,
      nightWindow: env.nightWindow,
      compatibility: { telemetryStaleMs: env.schedulerTelemetryStaleMs },
      unknownEtaAssumptionS: 4 * 60 * 60
    });
  }

  /** The live printer telemetry + config joined into the shape the scheduler needs. */
  private schedulerPrinters(): SchedulerPrinterRef[] {
    const now = Date.now();
    return this.reads.listPrinters().map((view) => {
      const config = this.configs.find((c) => c.id === view.id) ?? null;
      const updatedMs = view.updatedAt ? Date.parse(view.updatedAt) : NaN;
      // Remaining print time is only meaningful while the device reports printing.
      const printing = view.status === "printing" || view.status === "paused";
      const printingTimeLeftMs =
        printing && view.minutesLeft !== null ? Math.max(0, view.minutesLeft) * 60_000 : null;
      return {
        id: view.id,
        name: view.name,
        model: view.model,
        protocol: config?.protocol ?? null,
        material: view.liveMaterial ?? view.material,
        nozzleMm: view.nozzleDiameter,
        // Explicit config build volume (priority); the scheduler otherwise reads the
        // approved machine profile bound to this printer.
        buildVolume: config?.buildVolume ?? null,
        online: view.online,
        status: view.status,
        remoteStartSupported: view.remoteStartSupported,
        ams: null,
        telemetryAgeMs: Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : null,
        // Remaining-material telemetry does not exist; the scheduler resolves
        // sufficiency from operator material overrides instead.
        materialRemainingSufficient: null,
        printingTimeLeftMs
      };
    });
  }

  private ensurePrintQueue(logger: StoreLogger = {}): void {
    if (this.printQueueService) return;
    const store = openPrintQueueStore(this.dbPath, logger);
    // Seed the new model from the old JSON queue exactly once. Guarded by an
    // in-DB marker, so this is a no-op on every subsequent boot — there is no
    // ongoing dual-write between the JSON store and SQLite.
    importLegacyQueue(store, this.legacyQueueJobs, { logger });
    this.printQueueStore = store;
    this.printQueueService = new PrintQueueService(store, {
      // Refuse a pin to a printer the farm does not know (evaluated lazily, so the
      // config loaded in start() is in place by the time an operator pins).
      isPrinterConfigured: (id) => this.configs.some((c) => c.id === id)
    });

    this.artifactStorage = new ArtifactStorage({
      root: this.storageRoot,
      tmpDir: this.uploadTmpDir
    });
    this.artifactService = new ArtifactService(store, this.artifactStorage, {
      limits: {
        zipMaxEntries: uploads.zipMaxEntries,
        zipMaxEntryBytes: uploads.zipMaxEntryBytes,
        zipMaxTotalBytes: uploads.zipMaxTotalBytes,
        zipMaxRatio: uploads.zipMaxRatio,
        xmlMaxBytes: uploads.xmlMaxBytes
      },
      maxFileBytes: uploads.maxFileBytes,
      timeoutMs: uploads.analysisTimeoutMs,
      concurrency: uploads.analysisConcurrency,
      logger
    });
    // Re-queue analyses left `pending`/`running` by a previous crash/restart.
    this.artifactService.recover();

    // OrcaSlicer preset + slicing services. The runner spawns the pinned CLI when
    // configured; with none, slices honestly block (nothing is faked).
    this.sliceRunner = new OrcaCliRunner({
      command: slicing.command,
      baseArgs: slicing.baseArgs,
      extraArgs: slicing.extraArgs,
      pinnedVersion: slicing.pinnedVersion,
      workerVersion: slicing.workerVersion,
      networkIsolated: slicing.networkIsolated,
      logger
    });
    this.presetImportService = new PresetImportService(
      store,
      new OrcaCatalogSource(slicing.catalogDir),
      { logger }
    );
    this.profileService = new ProfileService(store, this.sliceRunner, () => this.slicerPrinters(), {
      logger
    });
    this.sliceService = new SliceService(store, this.artifactStorage, this.artifactService, this.sliceRunner, {
      tmpRoot: slicing.tmpRoot,
      timeoutMs: slicing.timeoutMs,
      concurrency: slicing.concurrency,
      logger
    });
    // Recover slice variants left `pending`/`running` by a crash. The one-time
    // catalog import is driven from start() (awaited there) so the profiles are
    // ready before the server accepts traffic; a lazy init (no start) imports on
    // the first explicit POST /slicing/presets/import instead.
    this.sliceService.recover();
  }

  /** The farm printers projected into the shape the slicing compatibility checks use. */
  private slicerPrinters(): SlicerPrinterRef[] {
    return this.configs.map((c) => ({
      id: c.id,
      name: c.name,
      model: c.model ?? null,
      material: c.material ?? null,
      protocol: c.protocol ?? null
    }));
  }

  /** Loads the printer config and starts the background poll loop. */
  async start(logger: StoreLogger = {}): Promise<void> {
    this.state.useLogger(logger);
    if (this.state.loadWarning) {
      logger.warn?.({ warning: this.state.loadWarning }, "state store problem");
    }

    // Open the queue database and run the one-time import at startup (with the
    // real logger), rather than lazily on the first API hit.
    this.ensurePrintQueue(logger);

    // Probe the OrcaSlicer runtime once so the scheduler can gate un-sliced work
    // synchronously; best-effort — a failed probe just leaves it unavailable.
    if (this.sliceRunner) {
      try {
        this.sliceRuntimeAvailable = (await this.sliceRunner.probe()).available;
      } catch {
        this.sliceRuntimeAvailable = false;
      }
    }

    // Import the OrcaSlicer catalog once, before accepting traffic — best-effort so
    // a missing/broken catalog can never stop the farm from starting.
    if (slicing.autoImport && this.presetImportService) {
      try {
        const result = await this.presetImportService.import("system");
        logger.info?.(
          { active: result.counts.active, quarantined: result.counts.quarantined, invalid: result.counts.invalid },
          "orca preset catalog imported"
        );
      } catch (error) {
        logger.warn?.({ err: error }, "orca preset import on boot failed");
      }
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
    // Stop accepting new analysis/slice work (in-flight jobs finish on their own).
    this.artifactService?.close();
    this.sliceService?.close();
    // Close the queue database last, after all writes have settled.
    this.printQueueStore?.close();
    this.printQueueStore = null;
    this.printQueueService = null;
    this.artifactService = null;
    this.artifactStorage = null;
    this.sliceRunner = null;
    this.presetImportService = null;
    this.profileService = null;
    this.sliceService = null;
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
