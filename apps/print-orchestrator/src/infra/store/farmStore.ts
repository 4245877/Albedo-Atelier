import { JobError, NotFoundError } from "../../core/errors";
import type { Automation, NightCandidate, NightPrint, QueueJob } from "../../domain/dashboard/types";
import { env } from "../../shared/env";
import { loadPrintersConfig, type PrinterConfig, type PrinterConfigSource } from "../printers/config";
import { shutdownPrinterConnections } from "../printers/status";
import { AutomationStore } from "./automationStore";
import { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import { DashboardReadModel } from "./dashboardReadModel";
import { EventFeed } from "./eventFeed";
import type { NightPlanEntry } from "./nightPlanner";
import { PrinterPoller, type StoreLogger } from "./printerPoller";
import { QueueStore, type NewQueueJobInput } from "./queueStore";
import { StateStore } from "./stateStore";

export type { NewQueueJobInput } from "./queueStore";
export type { FarmReadiness, FarmMetrics } from "./dashboardReadModel";

/**
 * The farm, assembled from real sources: printer configs come from
 * `config/printers.json` (or `PRINTERS_CONFIG_JSON`); live telemetry is polled
 * from the devices (Moonraker HTTP / Bambu MQTT / Creality WebSocket); camera
 * frames are real snapshots; the event feed records transitions the poller saw.
 *
 * This class owns the printer config and wires the collaborators together — the
 * background {@link PrinterPoller}, {@link CameraService}, {@link QueueStore},
 * {@link EventFeed}, {@link PrinterCommandService} and the read-only
 * {@link DashboardReadModel} — then exposes them as one API for the HTTP routes.
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
  private readonly queue: QueueStore;
  private readonly automations: AutomationStore;
  private readonly poller: PrinterPoller;
  private readonly commands: PrinterCommandService;
  private readonly readModel: DashboardReadModel;

  /** Current selection in the night-print candidate list (ephemeral UI state). */
  private nightPick = 0;

  constructor(stateFilePath: string = env.stateFilePath) {
    this.state = new StateStore(stateFilePath);
    const persisted = this.state.load();
    const persist = (): void => this.state.save();

    this.events = new EventFeed(persisted.feed, persist);
    this.queue = new QueueStore(this.events, persisted.queue, persist);
    this.automations = new AutomationStore(persisted.automations, this.events, persist);
    this.poller = new PrinterPoller(
      () => this.enabledConfigs(),
      this.cameras,
      this.events,
      persist,
      persisted.today,
      () => this.automations.isEnabled("night-lights")
    );
    this.commands = new PrinterCommandService(
      (id) => this.configById(id),
      this.poller,
      this.cameras,
      this.events
    );
    this.readModel = new DashboardReadModel(
      () => this.enabledConfigs(),
      (id) => this.configById(id),
      () => this.configSource,
      this.startedAt,
      this.poller,
      this.cameras,
      this.queue,
      this.events,
      this.automations,
      () => this.nightPick
    );

    // Snapshot the whole durable state on every save.
    this.state.bind(() => ({
      version: 1,
      queue: this.queue.serialize(),
      feed: this.events.list(),
      today: this.poller.serializeToday(),
      automations: this.automations.serialize()
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

    this.commands.useLogger(logger);
    await this.poller.start(logger);
  }

  async stop(): Promise<void> {
    this.poller.stop();
    shutdownPrinterConnections();
    await this.state.flush();
  }

  /** Awaits all pending state writes (used on shutdown and in tests). */
  flush(): Promise<void> {
    return this.state.flush();
  }

  pollOnce(): Promise<void> {
    return this.poller.pollOnce();
  }

  // ── Reads (→ DashboardReadModel) ─────────────────────────────────────────

  getService() {
    return this.readModel.getService();
  }
  getReadiness() {
    return this.readModel.getReadiness();
  }
  getMetricsSnapshot() {
    return this.readModel.getMetricsSnapshot();
  }
  listPrinters() {
    return this.readModel.listPrinters();
  }
  listActivePrinters() {
    return this.readModel.listActivePrinters();
  }
  getPrinter(id: string) {
    return this.readModel.getPrinter(id);
  }
  getQueue() {
    return this.readModel.getQueue();
  }
  getNight() {
    return this.readModel.getNight();
  }
  getCritical() {
    return this.readModel.getCritical();
  }
  getMaterials() {
    return this.readModel.getMaterials();
  }
  getToday() {
    return this.readModel.getToday();
  }
  getPerformance() {
    return this.readModel.getPerformance();
  }
  getAutomations() {
    return this.readModel.getAutomations();
  }
  getSystem() {
    return this.readModel.getSystem();
  }
  getFeed() {
    return this.readModel.getFeed();
  }
  getWarnings() {
    return this.readModel.getWarnings();
  }
  getPlan() {
    return this.readModel.getPlan();
  }
  getMaintenance() {
    return this.readModel.getMaintenance();
  }
  getCameras() {
    return this.readModel.getCameras();
  }
  snapshot() {
    return this.readModel.snapshot();
  }

  // ── Cameras (→ CameraService; facade resolves the config) ────────────────

  getCameraFrame(id: string) {
    return this.cameras.getFrame(this.configById(id));
  }
  getCameraStream(id: string) {
    return this.cameras.getStream(this.configById(id));
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
  snapshotPrinter(id: string) {
    return this.commands.snapshot(id);
  }
  addQueueJob(input: NewQueueJobInput) {
    return this.queue.add(input);
  }

  /**
   * Starts the next ready queue job on its target printer. Resolves the printer
   * from the job's printer field, dispatches a real remote start (Moonraker),
   * and drops the job from the queue once the device has accepted it. Fails
   * honestly when the job has no file, the printer is unknown/offline/busy, or
   * the protocol does not support remote start.
   */
  async startNext(): Promise<{ job: QueueJob; printer: string }> {
    const job = this.queue.findNextReady();
    if (!job) {
      throw new JobError("В очереди нет заданий, готовых к запуску");
    }
    const printer = this.readModel.resolvePrinter(job.printer);
    if (!printer) {
      throw new JobError(`Принтер «${job.printer}» не найден в конфигурации фермы`);
    }
    if (!job.file) {
      throw new JobError(
        `У задания «${job.title}» не задан файл — укажите имя .gcode на принтере, чтобы запустить его удалённо`
      );
    }

    await this.commands.startPrint(printer.id, job.file);
    this.queue.remove(job.id);
    return { job, printer: printer.name };
  }

  toggleAutomation(id: string, on?: boolean): Automation {
    return this.automations.toggle(id, on);
  }

  advanceNightPick(): NightPrint {
    const plan = this.readModel.getNightPlan();
    if (plan.length === 0) {
      throw new JobError(
        "Нет кандидатов на ночь — добавьте в очередь готовые задания (или включите подсказки ночной печати)"
      );
    }
    this.nightPick = (this.nightPick + 1) % plan.length;
    return this.readModel.getNight();
  }

  async startNight(): Promise<{ candidate: NightCandidate; window: string }> {
    const plan = this.readModel.getNightPlan();
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
