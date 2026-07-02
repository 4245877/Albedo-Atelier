import { JobError, NotFoundError } from "../../core/errors";
import type { Automation, NightPrint } from "../../domain/dashboard/types";
import { loadPrintersConfig, type PrinterConfig, type PrinterConfigSource } from "../printers/config";
import { shutdownPrinterConnections } from "../printers/status";
import { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import { DashboardReadModel } from "./dashboardReadModel";
import { EventFeed } from "./eventFeed";
import { PrinterPoller, type StoreLogger } from "./printerPoller";
import { QueueStore, type NewQueueJobInput } from "./queueStore";

export type { NewQueueJobInput } from "./queueStore";
export type { FarmReadiness, FarmMetrics } from "./dashboardReadModel";

/**
 * The farm, assembled from real sources: printer configs come from
 * `config/printers.json` (or `PRINTERS_CONFIG_JSON`); live telemetry is polled
 * from the devices (Moonraker HTTP / Bambu MQTT / Creality WebSocket); camera
 * frames are real snapshots; the event feed records transitions the poller saw.
 *
 * This class owns the printer config and wires the collaborators together — the
 * background {@link PrinterPoller}, {@link CameraService}, in-memory
 * {@link QueueStore}, {@link EventFeed}, {@link PrinterCommandService} and the
 * read-only {@link DashboardReadModel} — then exposes them as one API for the
 * HTTP routes. There is no seed data: anything the farm does not know is
 * returned empty/null and the dashboard shows it as unavailable.
 */
export class FarmStore {
  private configs: PrinterConfig[] = [];
  private configSource: PrinterConfigSource = { kind: "none" };
  private readonly startedAt = Date.now();

  private readonly events = new EventFeed();
  private readonly cameras = new CameraService();
  private readonly queue = new QueueStore(this.events);
  private readonly poller = new PrinterPoller(() => this.enabledConfigs(), this.cameras, this.events);
  private readonly commands = new PrinterCommandService(
    (id) => this.configById(id),
    this.poller,
    this.cameras,
    this.events
  );
  private readonly readModel = new DashboardReadModel(
    () => this.enabledConfigs(),
    (id) => this.configById(id),
    () => this.configSource,
    this.startedAt,
    this.poller,
    this.cameras,
    this.queue,
    this.events
  );

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Loads the printer config and starts the background poll loop. */
  async start(logger: StoreLogger = {}): Promise<void> {
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

  stop(): void {
    this.poller.stop();
    shutdownPrinterConnections();
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
  startNext() {
    return this.queue.startNext();
  }

  // ── Not wired up yet (honest failures, not fabricated data) ──────────────

  toggleAutomation(id: string, _on?: boolean): Automation {
    throw new NotFoundError(`Automation "${id}"`);
  }

  advanceNightPick(): NightPrint {
    throw new JobError("Планировщик ночной печати пока не подключён — нет кандидатов");
  }

  startNight(): { candidate: NightPrint["candidates"][number]; window: string } {
    throw new JobError("Планировщик ночной печати пока не подключён — нет кандидатов");
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
