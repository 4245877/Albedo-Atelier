import path from "node:path";

import {
  JobError,
  NotFoundError,
  PreviewConflictError,
  PrinterOfflineError,
  PrintIdentityConflictError
} from "../core/errors";
import type { Automation, NightCandidate, NightPrint, QueueJob } from "../domain/dashboard/types";
import type { PrintQueueStore } from "../domain/print/repositories";
import { env, slicing, uploads } from "../shared/env";
import { importLegacyQueue, LEGACY_IMPORT_MARKER } from "../infra/db/legacyImport";
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
  normalizeStartablePath,
  supportsPrinterFiles,
  type PrinterFilesListing
} from "../infra/printers/files";
import { shutdownPrinterConnections } from "../infra/printers/status";
import { AutomationStore } from "./automationStore";
import { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import { DashboardReadModel } from "./dashboardReadModel";
import { DispatchService } from "./dispatch/dispatchService";
import { evaluateDispatchGate } from "./dispatch/dispatchGate";
import { RunLifecycleService } from "./dispatch/runLifecycle";
import { ANALYZER_VERSION } from "./artifacts/analyzers";
import { runDriverOperation } from "./driverErrors";
import { EventFeed } from "./eventFeed";
import { FilamentConsumption } from "./filamentConsumption";
import { FilamentSync } from "./filamentSync";
import { classifyDispatchError } from "./startGuard";
import { supportsPrinterStart } from "../infra/printers/status";
import { toLegacyQueueJob } from "./printQueue/projection";
import { windowLengthMinutes, type NightPlanEntry } from "./nightPlanner";
import { MonitoringLease } from "./monitoringLease";
import { PrinterPoller } from "./printerPoller";
import type { StoreLogger } from "../shared/logger";
import { warnIfPermsTooOpen } from "../shared/filePerms";
import { SnapshotStore } from "../infra/persistence/snapshotStore";
import { StateStore, type PersistedQueue } from "../infra/persistence/stateStore";

/**
 * The body accepted by `POST /api/queue` (the operator "add job" form). Fields
 * are `unknown` and validated in {@link FarmStore.addQueueJob} before they reach
 * the SQLite model, so a malformed body fails honestly instead of persisting
 * garbage.
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
 * The farm, assembled from real sources: printer configs come from
 * `config/printers.json` (or `PRINTERS_CONFIG_JSON`); live telemetry is polled
 * from the devices (Moonraker HTTP / Bambu MQTT / Creality WebSocket); camera
 * frames are real snapshots; the event feed records transitions the poller saw.
 *
 * This class owns the printer config and wires the collaborators together — the
 * background {@link PrinterPoller}, {@link CameraService}, {@link EventFeed},
 * {@link PrinterCommandService} and the read-only {@link DashboardReadModel} —
 * then exposes the *actions* as its own API for the HTTP routes. Pure reads are
 * served by the read model directly via {@link FarmStore.reads}; only operations
 * that coordinate several collaborators (commands, queue starts, files,
 * snapshots) live here.
 *
 * The print queue itself is owned by the SQLite {@link PrintQueueService} — the
 * single source of truth. The remaining durable-but-non-queue state (event feed,
 * today counters, snapshots, pending filament deductions) is loaded from and
 * persisted to a JSON file via {@link StateStore}; the queue is no longer written
 * there (see {@link FarmStore.queueJsonSnapshot}). There is no seed data:
 * anything the farm does not know is returned empty/null and the dashboard shows
 * it as unavailable.
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
   * The canonical dispatch chokepoint (SQLite-transactional) and the run
   * lifecycle reconciler. Every physical start — manual, night, retry, future
   * automatic — goes through {@link DispatchService.dispatch}; the legacy JSON
   * queue can no longer reach a printer.
   */
  private dispatchService: DispatchService | null = null;
  private runLifecycle: RunLifecycleService | null = null;
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
  /**
   * The legacy JSON operator queue captured at load. It feeds the one-time
   * SQLite import; until that import commits (marker set) it is also written
   * back to JSON verbatim by {@link queueJsonSnapshot}, so an interrupted
   * migration can be retried without losing jobs. Once the marker is set SQLite
   * is canonical and the queue is no longer serialized to JSON.
   */
  private readonly legacyQueueState: PersistedQueue;

  private readonly events: EventFeed;
  private readonly cameras = new CameraService();
  private readonly snapshots: SnapshotStore;
  private readonly inventory = new FulfillmentInventoryClient();
  private readonly filament: FilamentConsumption;
  private readonly filamentSync: FilamentSync;
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
    // The event feed lets it surface reel changes / colour mismatches / auth
    // misconfiguration to the operator.
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
          if (this.printQueueStore) this.runLifecycle?.observe(id, prev, next);
        }
      }
    );
    this.commands = new PrinterCommandService(
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
        this.ensurePrintQueue();
        return this.printQueueStore?.repositories.startGuards ?? null;
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
      () => this.nightPick,
      this.snapshots,
      (job) => this.nightGateInfo(job.id),
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

  /**
   * The `queue` section written to the JSON state file. SQLite is the single
   * source of truth for the queue, so once the one-time legacy import has
   * committed (its `app_meta` marker is set — which the store only exposes after
   * a successful transaction) the queue is no longer serialized: an empty
   * section is written and new jobs live only in SQLite.
   *
   * Before that marker exists — the very first boot with a legacy `state.json`,
   * or a boot whose import failed/was interrupted — the original legacy queue is
   * preserved verbatim. That keeps the migration source intact so it can be
   * retried on the next boot without losing jobs, and lets an older binary still
   * read its queue if the deploy is rolled back before the cutover completes.
   */
  private queueJsonSnapshot(): PersistedQueue {
    if (this.printQueueStore?.repositories.meta.get(LEGACY_IMPORT_MARKER)) {
      return { seq: 0, jobs: [] };
    }
    return this.legacyQueueState;
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
        printerClass: config?.printerClass ?? null,
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
        printingTimeLeftMs,
        // The canonical run holding this printer (if any), from the same authoritative
        // query the dispatch path uses. Telemetry `status` alone is not enough: a
        // PENDING reservation or a fail-closed UNKNOWN run holds the printer while the
        // device may still read idle, and the scheduler must not plan onto it.
        activeRunState: this.activeRunForPrinter(view.id)?.state ?? null
      };
    });
  }

  private ensurePrintQueue(logger: StoreLogger = {}): void {
    if (this.printQueueService) return;
    const store = openPrintQueueStore(this.dbPath, logger);
    // Seed the new model from the old JSON queue exactly once. Guarded by an
    // in-DB marker, so this is a no-op on every subsequent boot — there is no
    // ongoing dual-write between the JSON store and SQLite.
    importLegacyQueue(store, this.legacyQueueState.jobs, { logger });
    this.printQueueStore = store;
    this.printQueueService = new PrintQueueService(store, {
      // Refuse a pin to a printer the farm does not know (evaluated lazily, so the
      // config loaded in start() is in place by the time an operator pins).
      isPrinterConfigured: (id) => this.configs.some((c) => c.id === id)
    });
    this.runLifecycle = new RunLifecycleService(store, { logger });
    this.dispatchService = new DispatchService({
      store,
      resolvePrinter: (reference) => {
        const wanted = reference.trim().toLowerCase();
        return this.enabledConfigs().find(
          (p) => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted
        );
      },
      getStatus: (id) => this.poller.getStatus(id),
      startPhysical: async (printerId, file, runId) => {
        await this.commands.startPrint(printerId, file, runId, { runId });
      },
      classifyError: classifyDispatchError,
      nightWindow: env.nightWindow,
      nightSafetyBufferRatio: env.nightEtaSafetyBuffer,
      logger
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
      maxStoredBytes: uploads.maxStoredBytes,
      maxArtifactCount: uploads.maxArtifactCount,
      minFreeDiskBytes: uploads.minFreeDiskBytes,
      analysisMaxQueue: uploads.analysisMaxQueue,
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
      logger,
      // Every runtime report the slicing tab requests re-probes OrcaSlicer; fold that
      // fresh result back into the shared flag the scheduler gates on, so a runtime
      // that crashed or recovered since boot can't leave the two showing opposite
      // decisions until the next restart.
      onRuntimeProbed: (available) => {
        this.sliceRuntimeAvailable = available;
      }
    });
    this.sliceService = new SliceService(store, this.artifactStorage, this.artifactService, this.sliceRunner, {
      tmpRoot: slicing.tmpRoot,
      timeoutMs: slicing.timeoutMs,
      concurrency: slicing.concurrency,
      logger,
      // For validating a concrete targetPrinterId against a class-scoped set before
      // slicing (a known-undispatchable target must never reach `ready`).
      listPrinters: () => this.slicerPrinters()
    });
    // Recover slice variants left `pending`/`running` by a crash. The one-time
    // catalog import is driven from start() (awaited there) so the profiles are
    // ready before the server accepts traffic; a lazy init (no start) imports on
    // the first explicit POST /slicing/presets/import instead.
    this.sliceService.recover();
  }

  /**
   * Boot-time reconciliation of durable start guards, now run-aware:
   *
   *  - a guard bound to a canonical run whose run is already terminal (or gone)
   *    protects nothing — dropped;
   *  - a guard bound to a live/unreconciled run is kept together with the run
   *    (fail-closed): the printer stays held until device evidence or the
   *    operator resolves it;
   *  - a legacy `ACKED` guard (no runId) can no longer be re-dispatched by
   *    anything — the legacy JSON queue lost its dispatch path — so it is
   *    dropped; legacy `SENT`/`UNKNOWN` guards are kept (physical outcome
   *    unknown, reconcile against the live device first).
   */
  private sweepStartGuards(logger: StoreLogger): void {
    const store = this.printQueueStore;
    if (!store) return;
    const guards = store.repositories.startGuards.list();
    if (guards.length === 0) return;
    const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
    for (const guard of guards) {
      if (guard.runId) {
        const run = store.repositories.printRuns.getById(guard.runId);
        if (!run || TERMINAL.has(run.state)) {
          store.repositories.startGuards.delete(guard.printerId);
          continue;
        }
      } else if (guard.state === "ACKED") {
        store.repositories.startGuards.delete(guard.printerId);
        continue;
      }
      logger.warn?.(
        { printer: guard.printerId, state: guard.state, file: guard.file, runId: guard.runId },
        "unconfirmed start guard retained — printer held until reconciled with the live device"
      );
    }
  }

  /** The farm printers projected into the shape the slicing compatibility checks use. */
  private slicerPrinters(): SlicerPrinterRef[] {
    return this.configs.map((c) => ({
      id: c.id,
      name: c.name,
      model: c.model ?? null,
      material: c.material ?? null,
      protocol: c.protocol ?? null,
      nozzleMm: c.nozzleDiameterMm ?? null,
      printerClass: c.printerClass ?? null
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

    // Reconcile durable start guards left by a previous run: drop those whose
    // job is already gone (nothing to re-dispatch); keep unconfirmed ones so the
    // next start attempt reconciles them against the live device (fail-closed).
    this.sweepStartGuards(logger);

    // Recover pending/unknown dispatches guard-and-run together: a PENDING run
    // whose command provably never left is unwound and re-queued; anything
    // ambiguous is held (never re-dispatched) until reconciled by observation.
    if (this.runLifecycle) {
      const recovered = this.runLifecycle.recover();
      if (recovered.held + recovered.unwound + recovered.running > 0) {
        logger.info?.(recovered, "canonical run recovery after restart");
      }
    }

    // Probe the OrcaSlicer runtime once so the scheduler can gate un-sliced work
    // synchronously, AND surface its availability at boot. An unconfigured runtime
    // is a common deployment gap — the production image ships the preset catalog but
    // no OrcaSlicer binary — so it is logged loudly here instead of only being
    // discovered later when a slice silently blocks.
    if (this.sliceRunner) {
      try {
        const runtime = await this.sliceRunner.probe();
        this.sliceRuntimeAvailable = runtime.available;
        if (runtime.available) {
          logger.info?.(
            {
              binary: runtime.binaryPath,
              version: runtime.detectedVersion,
              pinned: runtime.pinnedVersion,
              versionMatches: runtime.versionMatches,
              networkIsolated: runtime.networkIsolated
            },
            "orca slicing runtime available"
          );
        } else {
          logger.warn?.(
            { reason: runtime.error, pinned: runtime.pinnedVersion },
            "orca slicing runtime UNAVAILABLE — slicing stays blocked until ORCA_SLICER_CMD points at an OrcaSlicer binary or container runtime (see .env.example / config/slicers/orca/README.md); monitoring and dispatch are unaffected"
          );
        }
      } catch (error) {
        this.sliceRuntimeAvailable = false;
        logger.warn?.({ err: error }, "orca slicing runtime probe failed — slicing unavailable");
      }
    }

    // Import the OrcaSlicer catalog once, before accepting traffic — best-effort so
    // a missing/broken catalog can never stop the farm from starting.
    if (slicing.autoImport && this.presetImportService) {
      try {
        const result = await this.presetImportService.import("system");
        // Re-validate any sets carried over from a previous run against the freshly
        // imported revisions, so a set the new catalog invalidated can't linger as
        // approved/valid (mirrors the operator-triggered import path).
        this.profileService?.revalidateSets("system");
        logger.info?.(
          { active: result.counts.active, quarantined: result.counts.quarantined, invalid: result.counts.invalid },
          "orca preset catalog imported"
        );
        // Make the "catalog can't form a working set" gap loud, not silent: the
        // shipped catalog quarantines everything that inherits an un-redistributed
        // OrcaSlicer system parent, so slicing has no complete set until those are
        // installed under vendor/ (scripts/install-orca-vendor-profiles.mjs).
        if (result.missingParents.length > 0) {
          logger.warn?.(
            {
              missingParents: result.missingParents,
              active: result.counts.active,
              quarantined: result.counts.quarantined
            },
            "orca catalog is missing inheritance parents — quarantined presets cannot form a working profile set until the vendor/ parents are installed (apps/print-orchestrator: pnpm slicing:vendor:install --orca-resources <dir>; see config/slicers/orca/vendor/README.md)"
          );
        }
      } catch (error) {
        logger.warn?.({ err: error }, "orca preset import on boot failed");
      }
    }

    const { printers, source } = await loadPrintersConfig();
    this.configs = printers;
    this.configSource = source;

    // Advisory: the printer config carries device secrets (API keys, access
    // codes). Warn if it is group/world-readable — never fatal (see helper).
    warnIfPermsTooOpen(process.env.PRINTERS_CONFIG_PATH ?? "", logger);

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
    // Misconfiguration is loud at startup, not discovered print-by-print: an
    // enabled client with NO inter-service token will be refused (401) by
    // fulfillment once its temporary AUTH_OPTIONAL mode is off. The token value
    // itself is never logged.
    if (this.inventory.enabled && !this.inventory.hasServiceToken) {
      logger.warn?.(
        {},
        "ATELIER_FULFILLMENT_TOKEN is not set — fulfillment will refuse filament consume/sync with 401 unless its ATELIER_FULFILLMENT_AUTH_OPTIONAL compatibility mode is enabled"
      );
    }

    this.commands.useLogger(logger);
    await this.poller.start(logger);
  }

  /** In-progress shutdown, so a repeated stop() awaits the same sequence (idempotent). */
  private stopping: Promise<void> | null = null;

  /**
   * Graceful shutdown in strict order — the database is closed LAST, after
   * every producer of writes has stopped and the in-flight work has settled:
   *
   *  1. stop the poll loop (and await the in-flight poll);
   *  2. close device connections — no new telemetry/dispatch can start;
   *  3. stop the analysis/slice workers accepting new jobs;
   *  4. await the jobs already running, up to a bounded deadline; whatever is
   *     still unfinished is reported explicitly (its `running` rows are
   *     recovered to `pending` on the next boot — nothing is lost silently);
   *  5. flush the JSON state;
   *  6. only then close SQLite.
   *
   * Idempotent: a second call (double signal, test teardown after a signal)
   * awaits the same shutdown instead of racing a second one into a closed DB.
   */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      // 1–2. No new polls, no device connections.
      await this.poller.stop();
      shutdownPrinterConnections();

      // 3. Workers stop accepting new jobs (queued-but-not-started are dropped;
      // they live as pending rows in SQLite and are re-queued on next boot).
      this.artifactService?.close();
      this.sliceService?.close();

      // 4. Bounded drain of the jobs already executing, so their final writes
      // land BEFORE the database closes ("database is not open" can no longer
      // happen on the normal path).
      const drains: Promise<void>[] = [];
      if (this.artifactService) drains.push(this.artifactService.whenIdle());
      if (this.sliceService) drains.push(this.sliceService.whenIdle());
      if (drains.length > 0) {
        const drained = await Promise.race([
          Promise.all(drains).then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), env.shutdownDrainTimeoutMs).unref?.()
          )
        ]);
        if (!drained) {
          // Forced shutdown: report exactly what is being abandoned.
          const unfinished = this.printQueueStore?.repositories.artifactAnalyses
            .listUnfinished()
            .map((a) => a.id);
          // eslint-disable-next-line no-console
          console.error(
            JSON.stringify({
              msg: "shutdown drain deadline hit — unfinished work will be recovered on next boot",
              unfinishedAnalyses: unfinished ?? []
            })
          );
        }
      }

      // 5. Persist the tail of accrued printing-hours and settle every write.
      this.state.save();
      await this.state.flush();

      // 6. Close the queue database last.
      this.printQueueStore?.close();
      this.printQueueStore = null;
      this.printQueueService = null;
      this.dispatchService = null;
      this.runLifecycle = null;
      this.artifactService = null;
      this.artifactStorage = null;
      this.sliceRunner = null;
      this.presetImportService = null;
      this.profileService = null;
      this.sliceService = null;
    })();
    return this.stopping;
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

  // ── Actions (→ CommandService / PrintQueueService) ───────────────────────

  pausePrinter(id: string) {
    return this.commands.pause(id);
  }
  resumePrinter(id: string) {
    return this.commands.resume(id);
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
      const active = this.activeRunForPrinter(id);
      if ((expect.runId ?? null) !== (active?.id ?? null)) {
        throw new PrintIdentityConflictError(
          this.configById(id).name,
          expect.runId ?? null,
          active?.id ?? null
        );
      }
    }
    return this.commands.cancel(id, expect);
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
  /**
   * Observability for the filament-deduction retry queue: backlog size and the
   * per-reason counters of finally-dropped deductions (overflow/expired/rejected).
   */
  filamentQueueStats(): {
    pending: number;
    dropped: Record<"overflow" | "expired" | "rejected", number>;
  } {
    return this.filament.metrics();
  }

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
    const detail = this.printQueue.createTask({
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
    this.events.push("＋", `Задание «${detail.task.title}» добавлено в очередь`, "info");
    return job;
  }

  /** Resolves a projection job id (task id, or a legacy `qN` id) to the task. */
  private taskByQueueJobId(id: string) {
    const repos = (this.printQueueStore as PrintQueueStore).repositories;
    return repos.tasks.getById(id) ?? repos.tasks.findByLegacyRef(id);
  }

  /**
   * Removes a queue job by id (operator action) — the task is CANCELLED in the
   * canonical model (kept as history), never physically deleted. Refuses for a
   * task already dispatching/printing: cancelling a live print goes through the
   * printer cancel flow with run identity, not through a queue row delete.
   */
  removeQueueJob(id: string): QueueJob {
    this.ensurePrintQueue();
    const task = this.taskByQueueJobId(id);
    if (!task) throw new NotFoundError(`Задание очереди «${id}»`);
    if (task.state === "DISPATCHING" || task.state === "PRINTING") {
      throw new JobError(
        `Задание «${task.title}» уже запущено — отмените печать на принтере, а не строку очереди`
      );
    }
    const entry = (this.printQueueStore as PrintQueueStore).repositories.queue.findByTaskId(task.id);
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
      artifact: task.artifactId
        ? (this.printQueueStore as PrintQueueStore).repositories.artifacts.getById(task.artifactId)
        : null
    });
    this.printQueue.cancelTask(task.id, "удалено оператором из очереди");
    this.events.push("✕", `Задание «${task.title}» удалено из очереди`, "info");
    return snapshot;
  }

  /** Parks a queue job in `review` so it stops blocking start-next; 404s when unknown. */
  reviewQueueJob(id: string, reason?: string): QueueJob {
    this.ensurePrintQueue();
    const task = this.taskByQueueJobId(id);
    if (!task) throw new NotFoundError(`Задание очереди «${id}»`);
    const held = this.printQueue.holdTask(task.id, reason);
    const repos = (this.printQueueStore as PrintQueueStore).repositories;
    const entry = repos.queue.findByTaskId(held.id);
    this.events.push("⚑", `Задание «${held.title}» отложено на проверку`, "info");
    return toLegacyQueueJob({
      entry: entry as NonNullable<typeof entry>,
      task: held,
      artifact: held.artifactId ? repos.artifacts.getById(held.artifactId) : null
    });
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
  startNext(): Promise<{ job: QueueJob; printer: string; runId: string }> {
    return this.runQueueDispatch(async () => {
      this.ensurePrintQueue();
      const rows = this.printQueue
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
      const result = await (this.dispatchService as DispatchService).dispatch({
        taskId: row.task.id,
        mode: "manual"
      });
      // The run is durably RUNNING and the queue entry RELEASED — the guard has
      // nothing left to protect.
      this.commands.resolveStartGuard(result.printerId);
      return { job, printer: result.printerName, runId: result.runId };
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
      this.ensurePrintQueue();
      const plan = this.reads.getNightPlan();
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
        entry = plan[Math.min(this.nightPick, plan.length - 1)];
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
      const result = await (this.dispatchService as DispatchService).dispatch({
        taskId: entry.job.id,
        mode: "night",
        expectedTaskVersion:
          preview.expectedTaskVersion ?? entry.candidate.taskVersion ?? undefined,
        expectedArtifactSha256:
          preview.artifactSha256 !== undefined
            ? preview.artifactSha256
            : entry.candidate.artifactSha256
      });
      this.commands.resolveStartGuard(result.printerId);
      return { candidate: entry.candidate, window: env.nightWindow, runId: result.runId };
    });
  }

  /**
   * The canonical night-gate decoration for one projected queue job: the same
   * fail-closed blockers {@link DispatchService} will enforce, computed against
   * the SQLite task/artifact/analysis — plus the immutable preview identity.
   */
  private nightGateInfo(taskId: string): {
    blockers: string[];
    taskId: string;
    taskVersion: number | null;
    artifactSha256: string | null;
  } | null {
    const store = this.printQueueStore;
    if (!store) return null;
    const repos = store.repositories;
    const task = repos.tasks.getById(taskId) ?? repos.tasks.findByLegacyRef(taskId);
    if (!task) return null;
    const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
    const analysis = artifact ? repos.artifactAnalyses.latestForArtifact(artifact.id) : null;
    const printerRef = task.pinnedPrinterId ?? task.targetPrinter;
    const printer = printerRef ? this.reads.resolvePrinter(printerRef) : undefined;
    if (!printer) {
      // This gate is now the SOLE source of night blockers (the dashboard night
      // section projects it verbatim), so it must report a missing/unresolvable
      // printer itself rather than defer to a second heuristic. A night start
      // would otherwise have nothing to dispatch to.
      return {
        blockers: [
          printerRef
            ? `принтер «${printerRef}» не найден в конфигурации`
            : "принтер не назначен — закрепите принтер для ночного запуска"
        ],
        taskId: task.id,
        taskVersion: task.version,
        artifactSha256: artifact?.sha256 ?? null
      };
    }
    const blockers = evaluateDispatchGate({
      mode: "night",
      task,
      entry: repos.queue.findByTaskId(task.id),
      artifact,
      analysis,
      printer,
      status: this.poller.getStatus(printer.id),
      remoteStartSupported: supportsPrinterStart(printer),
      nightWindowMinutes: windowLengthMinutes(env.nightWindow),
      nightSafetyBufferRatio: env.nightEtaSafetyBuffer,
      currentAnalyzerVersion: ANALYZER_VERSION
    });
    return {
      blockers: blockers.map((b) => b.message),
      taskId: task.id,
      taskVersion: task.version,
      artifactSha256: artifact?.sha256 ?? null
    };
  }

  /**
   * Operator resolution of a run stuck in UNKNOWN (lost completion, restart
   * mid-print) after physically checking the printer. Refused while the device
   * is observably printing the run's file.
   */
  resolveRun(runId: string, outcome: "SUCCEEDED" | "FAILED" | "CANCELLED", reason?: string) {
    this.ensurePrintQueue();
    const lifecycle = this.runLifecycle as RunLifecycleService;
    const run = (this.printQueueStore as PrintQueueStore).repositories.printRuns.getById(runId);
    return lifecycle.resolveRun(runId, outcome, {
      status: run ? this.poller.getStatus(run.printerId) : undefined,
      reason,
      actor: "operator"
    });
  }

  /** The active canonical run holding a printer, if any (identity for dangerous commands). */
  activeRunForPrinter(printerId: string) {
    if (!this.printQueueStore) return null;
    return this.runLifecycle?.activeRun(printerId) ?? null;
  }

  /**
   * Operator override to lift a held start guard after physically checking the
   * printer (e.g. a start whose response was lost and the print did not run).
   * Refuses while the printer is actually printing.
   */
  clearStartGuard(id: string) {
    return this.commands.clearStartGuard(id);
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
