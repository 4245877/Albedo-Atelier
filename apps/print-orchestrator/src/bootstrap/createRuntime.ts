import path from "node:path";

import { NotFoundError } from "../core/errors";
import type { PrintQueueStore } from "../domain/print/repositories";
import type { PrintRun } from "../domain/print/types";
import { env, slicing, uploads } from "../shared/env";
import type { StoreLogger } from "../shared/logger";
import { importLegacyQueue } from "../infra/db/legacyImport";
import { LEGACY_IMPORT_MARKER } from "../infra/db/legacyImport";
import { openPrintQueueStore } from "../infra/db/store";
import { FulfillmentInventoryClient } from "../infra/fulfillment/inventoryClient";
import { SnapshotStore } from "../infra/persistence/snapshotStore";
import { StateStore, type PersistedQueue } from "../infra/persistence/stateStore";
import type { PrinterConfig, PrinterConfigSource } from "../infra/printers/config";
import { OrcaCatalogSource } from "../infra/slicing/catalogSource";
import { OrcaCliRunner } from "../infra/slicing/orcaCliRunner";
import type { SliceRunner } from "../infra/slicing/sliceRunner";
import { ArtifactStorage } from "../infra/storage/artifactStorage";
import { ArtifactService } from "../app/artifacts/artifactService";
import { AutomationStore } from "../app/automationStore";
import { CameraService } from "../app/cameraService";
import { PrinterCommandService } from "../app/commandService";
import { DashboardReadModel } from "../app/dashboardReadModel";
import { DispatchService } from "../app/dispatch/dispatchService";
import { RunLifecycleService } from "../app/dispatch/runLifecycle";
import { EventFeed } from "../app/eventFeed";
import { FilamentConsumption } from "../app/filamentConsumption";
import { FilamentSync } from "../app/filamentSync";
import { MonitoringLease } from "../app/monitoringLease";
import { PrinterPoller } from "../app/printerPoller";
import { PrintQueueService } from "../app/printQueue/printQueueService";
import { buildNightGateInfo, type NightGateDeps } from "../app/readModels/buildNightGateInfo";
import { buildSchedulerPrinters } from "../app/readModels/buildSchedulerPrinters";
import { buildSlicerPrinters } from "../app/readModels/buildSlicerPrinters";
import { PresetImportService } from "../app/slicing/presetImportService";
import { ProfileService } from "../app/slicing/profileService";
import { SliceService } from "../app/slicing/sliceService";
import {
  SchedulerService,
  type SchedulerPrinterRef
} from "../app/scheduling/schedulerService";
import { classifyDispatchError } from "../app/startGuard";

/** Paths a runtime may override (tests pass isolated temp files). */
export interface RuntimeOptions {
  stateFilePath?: string;
  snapshotsDir?: string;
  dbPath?: string;
}

/**
 * The SQLite-backed application services the print/slicing HTTP routes need,
 * exposed as lazy accessors. Both the {@link FarmRuntime} and the compatibility
 * facade satisfy it, so routes can be handed exactly this surface instead of the
 * whole runtime.
 */
export interface PrintServices {
  readonly printQueue: PrintQueueService;
  readonly artifacts: ArtifactService;
  readonly scheduler: SchedulerService;
  readonly slicing: {
    presets: PresetImportService;
    profiles: ProfileService;
    slices: SliceService;
  };
}

/**
 * The composition root of the print orchestrator. Owns *creation and wiring* of
 * every concrete infrastructure adapter, the SQLite database + repositories, and
 * the application services — nothing else. Lifecycle (start/recovery/shutdown)
 * lives in {@link FarmLifecycle}, state-changing operations in {@link FarmCommands},
 * and dashboard projections in `app/readModels/*`; those collaborators all read
 * the graph this object assembled.
 *
 * The eager collaborators (state, event feed, snapshots, automations, filament,
 * poller, device commands, read model) are built in the constructor. The
 * SQLite-backed services are opened *lazily* on first access ({@link ensureQueue})
 * — never in the constructor — so merely constructing a runtime (as the module
 * singleton and many route/test modules do) opens no database file; the one-time
 * legacy import runs when the store is first initialised.
 */
export class FarmRuntime implements PrintServices {
  private configs: PrinterConfig[] = [];
  private configSource: PrinterConfigSource = { kind: "none" };
  readonly startedAt = Date.now();

  readonly state: StateStore;
  readonly events: EventFeed;
  readonly cameras = new CameraService();
  readonly snapshots: SnapshotStore;
  readonly inventory = new FulfillmentInventoryClient();
  readonly filament: FilamentConsumption;
  readonly filamentSync: FilamentSync;
  readonly automations: AutomationStore;
  /** "Operator is watching" lease renewed by the dashboard; in-memory only. */
  readonly monitoring = new MonitoringLease();
  readonly poller: PrinterPoller;
  /** The real-device command choke point (pause/resume/cancel/start/light/snapshot). */
  readonly deviceCommands: PrinterCommandService;
  /** Read-only projections of the live farm state for every dashboard/API read. */
  readonly reads: DashboardReadModel;

  private readonly dbPath: string;
  private readonly storageRoot: string;
  private readonly uploadTmpDir: string;
  /** The legacy JSON operator queue captured at load; feeds the one-time import. */
  private readonly legacyQueueState: PersistedQueue;

  private printQueueStoreRef: PrintQueueStore | null = null;
  private printQueueServiceRef: PrintQueueService | null = null;
  private dispatchServiceRef: DispatchService | null = null;
  private runLifecycleRef: RunLifecycleService | null = null;
  private artifactStorageRef: ArtifactStorage | null = null;
  private artifactServiceRef: ArtifactService | null = null;
  private sliceRunnerRef: SliceRunner | null = null;
  private presetImportServiceRef: PresetImportService | null = null;
  private profileServiceRef: ProfileService | null = null;
  private sliceServiceRef: SliceService | null = null;

  /** OrcaSlicer runtime availability, probed on start and re-probed by reports. */
  private sliceRuntimeAvailableFlag = false;
  /** Current selection in the night-print candidate list (ephemeral UI state). */
  private nightPickIndex = 0;

  constructor(options: RuntimeOptions = {}) {
    const stateFilePath = options.stateFilePath ?? env.stateFilePath;
    const snapshotsDir = options.snapshotsDir ?? env.snapshotsDir;
    // Default the queue DB next to the state file. For the singleton (default
    // state path) this is env.queueDbPath, honouring QUEUE_DB_PATH; a test that
    // passes its own temp state file gets an isolated sibling queue.db.
    const dbPath =
      options.dbPath ??
      (stateFilePath === env.stateFilePath
        ? env.queueDbPath
        : path.resolve(path.dirname(stateFilePath), "queue.db"));
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
    this.legacyQueueState = persisted.queue;
    const persist = (): void => this.state.save();

    this.events = new EventFeed(persisted.feed, persist);
    this.snapshots = new SnapshotStore(snapshotsDir, persisted.snapshots, persist, {
      retainPerPrinter: env.snapshotRetainPerPrinter
    });
    this.automations = new AutomationStore(persisted.automations, this.events, persist);
    // Deductions fulfillment never confirmed are reloaded into the retry queue,
    // so a restart cannot lose them (delivery stays deduped by idempotencyKey);
    // the sub-gram carry survives restarts the same way.
    this.filament = new FilamentConsumption(
      this.inventory,
      this.events,
      persist,
      persisted.pendingConsumes,
      { initialCarry: persisted.filamentCarry }
    );
    // Same client as the deduction path: it pushes the live loaded reel so
    // fulfillment binds it to a stock position automatically (no manual entry).
    this.filamentSync = new FilamentSync(this.inventory, { events: this.events });
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
      {
        monitoringLease: this.monitoring,
        // Canonical-run reconciliation: every poll compares the SQLite runs
        // with the observed device state. Only when the store is already open —
        // the poll loop must never force a lazy DB open.
        runObserver: (id, prev, next) => {
          if (this.printQueueStoreRef) this.runLifecycleRef?.observe(id, prev, next);
        }
      }
    );
    this.deviceCommands = new PrinterCommandService(
      (id) => this.configById(id),
      this.poller,
      this.poller.lights,
      this.cameras,
      this.events,
      this.snapshots,
      // Keep the default live-status source (real device poll).
      undefined,
      // Durable start-idempotency guard, resolved lazily: the SQLite store opens
      // after this service is constructed. Ensures the DB is open on first use.
      () => {
        this.ensureQueue();
        return this.printQueueStoreRef?.repositories.startGuards ?? null;
      }
    );
    this.reads = new DashboardReadModel(
      () => this.enabledConfigs(),
      (id) => this.configById(id),
      () => this.configSource,
      this.startedAt,
      this.poller,
      this.cameras,
      // The queue the dashboard sees IS the SQLite projection — the legacy
      // JSON queue no longer feeds any read (or dispatch) path.
      {
        list: () => this.printQueue.projectLegacyQueue(),
        size: () => this.printQueue.projectLegacyQueue().length
      },
      this.events,
      this.automations,
      () => this.nightPickIndex,
      this.snapshots,
      (job) => buildNightGateInfo(this.nightGateDeps(), job.id),
      (printerId) => this.activeRunForPrinter(printerId)?.id ?? null
    );

    // Snapshot the whole durable state on every save. The queue section is no
    // longer a live projection — SQLite owns it; see queueJsonSnapshot.
    this.state.bind(() => ({
      version: 1,
      queue: this.queueJsonSnapshot(),
      feed: this.events.list(),
      today: this.poller.today.serialize(),
      automations: this.automations.serialize(),
      snapshots: this.snapshots.serialize(),
      pendingConsumes: this.filament.serialize(),
      filamentCarry: this.filament.serializeCarry()
    }));
  }

  // ── Printer config (owned here; set by the lifecycle on start) ─────────────

  /** The enabled printer configs (the poll loop / reads / dispatch surface). */
  enabledConfigs(): PrinterConfig[] {
    return this.configs.filter((p) => p.enabled);
  }

  /** All printer configs, enabled or not (used by the slicer/scheduler joins). */
  allConfigs(): PrinterConfig[] {
    return this.configs;
  }

  configById(id: string): PrinterConfig {
    const printer = this.configs.find((p) => p.id === id && p.enabled);
    if (!printer) {
      throw new NotFoundError(`Printer "${id}"`);
    }
    return printer;
  }

  /** Records whether a printer id exists in the config (any enabled state). */
  isPrinterConfigured(id: string): boolean {
    return this.configs.some((c) => c.id === id);
  }

  /** Installs the loaded printer config; called once by the lifecycle on start. */
  setConfig(printers: PrinterConfig[], source: PrinterConfigSource): void {
    this.configs = printers;
    this.configSource = source;
  }

  // ── Ephemeral shared state ─────────────────────────────────────────────────

  get nightPick(): number {
    return this.nightPickIndex;
  }
  set nightPick(value: number) {
    this.nightPickIndex = value;
  }

  get sliceRuntimeAvailable(): boolean {
    return this.sliceRuntimeAvailableFlag;
  }
  set sliceRuntimeAvailable(value: boolean) {
    this.sliceRuntimeAvailableFlag = value;
  }

  // ── Lazy SQLite-backed services (opened on first access) ───────────────────

  /** The open queue store, or null before {@link ensureQueue} has run. */
  get printQueueStore(): PrintQueueStore | null {
    return this.printQueueStoreRef;
  }

  /** The persistent print-queue service (SQLite), opened on first access. */
  get printQueue(): PrintQueueService {
    this.ensureQueue();
    return this.printQueueServiceRef as PrintQueueService;
  }

  /** The upload/analysis service (SQLite + content-addressed blobs), lazy. */
  get artifacts(): ArtifactService {
    this.ensureQueue();
    return this.artifactServiceRef as ArtifactService;
  }

  /** The OrcaSlicer preset/profile/slice services (SQLite-backed), lazy. */
  get slicing(): {
    presets: PresetImportService;
    profiles: ProfileService;
    slices: SliceService;
  } {
    this.ensureQueue();
    return {
      presets: this.presetImportServiceRef as PresetImportService,
      profiles: this.profileServiceRef as ProfileService,
      slices: this.sliceServiceRef as SliceService
    };
  }

  /**
   * The manual-scheduler service (SQLite-backed), built on each access over the
   * lazily-opened store with the *current* printer telemetry and runtime flag.
   */
  get scheduler(): SchedulerService {
    this.ensureQueue();
    const store = this.printQueueStoreRef as PrintQueueStore;
    return new SchedulerService(store, () => this.schedulerPrinters(), {
      now: () => new Date(),
      runtimeAvailable: this.sliceRuntimeAvailableFlag,
      nightSafetyBufferRatio: env.nightEtaSafetyBuffer,
      nightWindow: env.nightWindow,
      compatibility: { telemetryStaleMs: env.schedulerTelemetryStaleMs },
      unknownEtaAssumptionS: 4 * 60 * 60
    });
  }

  get dispatchService(): DispatchService | null {
    return this.dispatchServiceRef;
  }
  get runLifecycle(): RunLifecycleService | null {
    return this.runLifecycleRef;
  }
  get artifactService(): ArtifactService | null {
    return this.artifactServiceRef;
  }
  get sliceService(): SliceService | null {
    return this.sliceServiceRef;
  }
  get sliceRunner(): SliceRunner | null {
    return this.sliceRunnerRef;
  }
  get presetImportService(): PresetImportService | null {
    return this.presetImportServiceRef;
  }
  get profileService(): ProfileService | null {
    return this.profileServiceRef;
  }

  /** The active canonical run holding a printer, if any (identity for commands). */
  activeRunForPrinter(printerId: string): PrintRun | null {
    if (!this.printQueueStoreRef) return null;
    return this.runLifecycleRef?.activeRun(printerId) ?? null;
  }

  /** The explicit inputs the night-gate read model needs (no globals). */
  nightGateDeps(): NightGateDeps {
    return {
      store: this.printQueueStoreRef,
      resolvePrinter: (reference) => this.reads.resolvePrinter(reference),
      getStatus: (id) => this.poller.getStatus(id),
      nightWindow: env.nightWindow,
      nightSafetyBufferRatio: env.nightEtaSafetyBuffer
    };
  }

  /** The live printer telemetry + config joined into the shape the scheduler needs. */
  private schedulerPrinters(): SchedulerPrinterRef[] {
    return buildSchedulerPrinters({
      printers: this.reads.listPrinters(),
      configs: this.configs,
      activeRun: (id) => this.activeRunForPrinter(id)
    });
  }

  /**
   * Opens the queue database + repositories and constructs every SQLite-backed
   * service, exactly once (idempotent). The one-time legacy import runs here on
   * the first call; unfinished analyses / slice variants are recovered on init.
   */
  ensureQueue(logger: StoreLogger = {}): void {
    if (this.printQueueServiceRef) return;
    const store = openPrintQueueStore(this.dbPath, logger);
    // Seed the new model from the old JSON queue exactly once. Guarded by an
    // in-DB marker, so this is a no-op on every subsequent boot — there is no
    // ongoing dual-write between the JSON store and SQLite.
    importLegacyQueue(store, this.legacyQueueState.jobs, { logger });
    this.printQueueStoreRef = store;
    this.printQueueServiceRef = new PrintQueueService(store, {
      // Refuse a pin to a printer the farm does not know (evaluated lazily, so the
      // config loaded in start() is in place by the time an operator pins).
      isPrinterConfigured: (id) => this.isPrinterConfigured(id)
    });
    this.runLifecycleRef = new RunLifecycleService(store, { logger });
    this.dispatchServiceRef = new DispatchService({
      store,
      resolvePrinter: (reference) => {
        const wanted = reference.trim().toLowerCase();
        return this.enabledConfigs().find(
          (p) => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted
        );
      },
      getStatus: (id) => this.poller.getStatus(id),
      startPhysical: async (printerId, file, runId) => {
        await this.deviceCommands.startPrint(printerId, file, runId, { runId });
      },
      classifyError: classifyDispatchError,
      nightWindow: env.nightWindow,
      nightSafetyBufferRatio: env.nightEtaSafetyBuffer,
      logger
    });

    this.artifactStorageRef = new ArtifactStorage({
      root: this.storageRoot,
      tmpDir: this.uploadTmpDir
    });
    this.artifactServiceRef = new ArtifactService(store, this.artifactStorageRef, {
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
      maxStoredBytes: uploads.maxStoredBytes,
      maxArtifactCount: uploads.maxArtifactCount,
      minFreeDiskBytes: uploads.minFreeDiskBytes,
      analysisMaxQueue: uploads.analysisMaxQueue,
      logger
    });
    // Re-queue analyses left `pending`/`running` by a previous crash/restart.
    this.artifactServiceRef.recover();

    // OrcaSlicer preset + slicing services. The runner spawns the pinned CLI when
    // configured; with none, slices honestly block (nothing is faked).
    this.sliceRunnerRef = new OrcaCliRunner({
      command: slicing.command,
      baseArgs: slicing.baseArgs,
      extraArgs: slicing.extraArgs,
      pinnedVersion: slicing.pinnedVersion,
      workerVersion: slicing.workerVersion,
      networkIsolated: slicing.networkIsolated,
      logger
    });
    this.presetImportServiceRef = new PresetImportService(
      store,
      new OrcaCatalogSource(slicing.catalogDir),
      { logger }
    );
    this.profileServiceRef = new ProfileService(
      store,
      this.sliceRunnerRef,
      () => buildSlicerPrinters(this.configs),
      {
        logger,
        // Every runtime report the slicing tab requests re-probes OrcaSlicer; fold
        // that fresh result back into the shared flag the scheduler gates on, so a
        // runtime that crashed or recovered since boot can't leave the two showing
        // opposite decisions until the next restart.
        onRuntimeProbed: (available) => {
          this.sliceRuntimeAvailableFlag = available;
        }
      }
    );
    this.sliceServiceRef = new SliceService(
      store,
      this.artifactStorageRef,
      this.artifactServiceRef,
      this.sliceRunnerRef,
      {
        tmpRoot: slicing.tmpRoot,
        timeoutMs: slicing.timeoutMs,
        concurrency: slicing.concurrency,
        logger,
        // For validating a concrete targetPrinterId against a class-scoped set before
        // slicing (a known-undispatchable target must never reach `ready`).
        listPrinters: () => buildSlicerPrinters(this.configs)
      }
    );
    // Recover slice variants left `pending`/`running` by a crash. The one-time
    // catalog import is driven from the lifecycle start() (awaited there) so the
    // profiles are ready before the server accepts traffic; a lazy init (no start)
    // imports on the first explicit POST /slicing/presets/import instead.
    this.sliceServiceRef.recover();
  }

  /**
   * The `queue` section written to the JSON state file. SQLite is the single
   * source of truth for the queue, so once the one-time legacy import has
   * committed (its `app_meta` marker is set) the queue is no longer serialized:
   * an empty section is written and new jobs live only in SQLite. Before that
   * marker exists the original legacy queue is preserved verbatim, so an
   * interrupted migration can be retried without losing jobs.
   */
  private queueJsonSnapshot(): PersistedQueue {
    if (this.printQueueStoreRef?.repositories.meta.get(LEGACY_IMPORT_MARKER)) {
      return { seq: 0, jobs: [] };
    }
    return this.legacyQueueState;
  }

  /** Closes the queue database and drops every SQLite-backed service reference. */
  disposeQueue(): void {
    this.printQueueStoreRef?.close();
    this.printQueueStoreRef = null;
    this.printQueueServiceRef = null;
    this.dispatchServiceRef = null;
    this.runLifecycleRef = null;
    this.artifactServiceRef = null;
    this.artifactStorageRef = null;
    this.sliceRunnerRef = null;
    this.presetImportServiceRef = null;
    this.profileServiceRef = null;
    this.sliceServiceRef = null;
  }
}

/**
 * Builds a fully-wired {@link FarmRuntime}. This is the *only* place concrete
 * infrastructure adapters are chosen and connected; everything outside talks to
 * the runtime through the collaborators it exposes.
 */
export function createRuntime(options: RuntimeOptions = {}): FarmRuntime {
  return new FarmRuntime(options);
}
