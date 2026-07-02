import {
  CameraError,
  JobError,
  NotFoundError,
  PrinterConnectionError,
  PrinterOfflineError,
  ValidationError
} from "../../core/errors";
import type {
  Automation,
  AutomationsSection,
  CameraView,
  CriticalEvent,
  DashboardSnapshot,
  FeedEvent,
  FeedKind,
  MaintenanceRow,
  MaterialsSection,
  NightPrint,
  PerformanceSection,
  PlanSection,
  QueueJob,
  ServiceStatus,
  SystemComponent,
  TodaySection,
  Warning
} from "../../domain/dashboard/types";
import type { CameraState, PrinterView } from "../../domain/printers/types";
import { loadPrintersConfig, type PrinterConfig, type PrinterConfigSource } from "../printers/config";
import {
  getPrinterLiveStatus,
  PrinterCommandError,
  sendPrinterCommand,
  shutdownPrinterConnections,
  type PrinterCommand,
  type PrinterLiveStatus
} from "../printers/status";
import {
  captureCameraFrame,
  hasCameraSource,
  hasCameraStream,
  openCameraStream,
  type CameraFrame,
  type CameraStream
} from "../printers/snapshot";
import { env } from "../../shared/env";
import { hhmm } from "../../shared/time";

const MS_PER_MIN = 60 * 1000;
// A camera frame older than this is re-fetched on demand; between polls the
// cached frame doubles as the "is the camera reachable" probe result.
const CAMERA_PROBE_INTERVAL_MS = 30 * 1000;
const CAMERA_FRAME_FRESH_MS = 5 * 1000;

const COMPLETE_RE = /complete|finish|done/i;
const CANCEL_RE = /cancel|abort|stop/i;

type StoreLogger = {
  info?: (obj: unknown, message?: string) => void;
  warn?: (obj: unknown, message?: string) => void;
  error?: (obj: unknown, message?: string) => void;
};

interface CameraEntry {
  state: CameraState;
  snapshotAt: string | null;
  frame: CameraFrame | null;
  fetchedAt: number;
}

/** Human "N дн M ч назад" / "M ч N м назад" from a duration in ms. */
function humanizeSince(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / MS_PER_MIN));
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin - days * 60 * 24) / 60);
  if (days > 0) {
    return `${days} дн ${hours} ч назад`;
  }
  const mins = totalMin - hours * 60;
  if (hours > 0) {
    return `${hours} ч ${mins} м назад`;
  }
  return `${mins} м назад`;
}

function isBusyStatus(status: PrinterView["status"]): boolean {
  return status === "printing" || status === "paused";
}

function looksComplete(status: PrinterLiveStatus): boolean {
  if (status.stateText && CANCEL_RE.test(status.stateText)) return false;
  if (status.stateText && COMPLETE_RE.test(status.stateText)) return true;
  return status.progressPct !== null && status.progressPct >= 99;
}

function looksCancelled(status: PrinterLiveStatus): boolean {
  return Boolean(status.stateText && CANCEL_RE.test(status.stateText));
}

function dateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export type NewQueueJobInput = {
  title?: unknown;
  printer?: unknown;
  material?: unknown;
  eta?: unknown;
  at?: unknown;
  night?: unknown;
};

/**
 * The farm state, built from real sources: printer configs come from
 * `config/printers.json` (or `PRINTERS_CONFIG_JSON`), live telemetry is polled
 * from the devices (Moonraker HTTP / Bambu MQTT / Creality WebSocket — see
 * `../printers/status`, ported from apps/fulfillment), camera frames are real
 * snapshots, and the event feed records transitions the poller observed.
 *
 * There is no seed data. Anything the farm genuinely does not know — material
 * stock, maintenance history, print schedule — is returned empty/null and the
 * dashboard shows it as unavailable instead of inventing numbers.
 */
export class FarmStore {
  private configs: PrinterConfig[] = [];
  private configSource: PrinterConfigSource = { kind: "none" };
  private statuses = new Map<string, PrinterLiveStatus>();
  private cameras = new Map<string, CameraEntry>();
  /** hh:mm of the last observed state change per printer. */
  private changedAt = new Map<string, string>();
  private feed: FeedEvent[] = [];

  /** Operator-created jobs (in memory; starts empty — never seeded). */
  private queue: QueueJob[] = [];
  private queueSeq = 0;

  private startedAt = Date.now();
  private lastPollAt: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private logger: StoreLogger = {};

  /** Completions/failures the poller itself observed today. */
  private todayKey = dateKey();
  private todayDone = 0;
  private todayFailed = 0;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Loads the printer config and starts the background poll loop. */
  async start(logger: StoreLogger = {}): Promise<void> {
    this.logger = logger;
    const { printers, source } = await loadPrintersConfig();
    this.configs = printers;
    this.configSource = source;

    if (source.warning) {
      this.logger.warn?.({ warning: source.warning }, "printers config problem");
    }
    this.logger.info?.(
      { printers: printers.length, source: source.kind },
      "farm store started with real printer config"
    );

    await this.pollOnce();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, env.printerPollIntervalMs);
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    shutdownPrinterConnections();
  }

  /** Polls every enabled printer once and records observed transitions. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const enabled = this.configs.filter((printer) => printer.enabled);
      await Promise.all(
        enabled.map(async (printer) => {
          const status = await getPrinterLiveStatus(printer);
          this.recordTransition(printer, this.statuses.get(printer.id), status);
          this.statuses.set(printer.id, status);
        })
      );
      await Promise.all(enabled.map((printer) => this.probeCamera(printer)));
      this.lastPollAt = Date.now();
    } catch (error) {
      this.logger.error?.({ err: error }, "printer poll failed");
    } finally {
      this.polling = false;
    }
  }

  // ── Transition tracking (real events only) ──────────────────────────────

  private recordTransition(
    printer: PrinterConfig,
    prev: PrinterLiveStatus | undefined,
    next: PrinterLiveStatus
  ): void {
    this.rolloverToday();

    // First observation is a baseline: report nothing, so a restart does not
    // re-announce pre-existing conditions.
    if (!prev) return;
    if (prev.status === next.status && prev.online === next.online) return;

    this.changedAt.set(printer.id, hhmm());
    const name = `<b>${printer.name}</b>`;
    const job = next.currentFile ?? prev.currentFile;

    if (prev.online && !next.online) {
      this.pushEvent("⛓", `${name} потерял связь${next.error ? ` (${next.error})` : ""}`, "err");
      return;
    }
    if (!prev.online && next.online) {
      this.pushEvent("↺", `${name} снова на связи`, "ok");
      if (prev.status === "offline" && next.status === prev.status) return;
    }

    if (next.status === "error" && prev.status !== "error") {
      this.todayFailed += 1;
      this.pushEvent("⚠", `${name}: ${next.error ?? "ошибка печати"}`, "err");
      return;
    }
    if (next.status === "printing" && prev.status !== "printing" && prev.status !== "paused") {
      this.pushEvent("▶", `${name} начал печать${job ? ` «${job}»` : ""}`, "ok");
      return;
    }
    if (next.status === "paused" && prev.status === "printing") {
      this.pushEvent("⏸", `${name}: печать на паузе${next.stateMessage ? ` — ${next.stateMessage}` : ""}`, "info");
      return;
    }
    if (next.status === "printing" && prev.status === "paused") {
      this.pushEvent("▶", `${name} продолжил печать`, "ok");
      return;
    }
    if (next.status === "idle" && (prev.status === "printing" || prev.status === "paused")) {
      if (looksCancelled(next)) {
        this.pushEvent("✕", `Печать${job ? ` «${job}»` : ""} на ${name} отменена`, "info");
        return;
      }
      if (looksComplete(next)) {
        this.todayDone += 1;
        this.pushEvent("✔", `${name} завершил печать${job ? ` «${job}»` : ""}`, "ok");
        return;
      }
      this.pushEvent("◌", `${name} перешёл в режим ожидания`, "info");
    }
  }

  private rolloverToday(): void {
    const key = dateKey();
    if (key !== this.todayKey) {
      this.todayKey = key;
      this.todayDone = 0;
      this.todayFailed = 0;
    }
  }

  // ── Cameras (real frames) ────────────────────────────────────────────────

  private async probeCamera(printer: PrinterConfig): Promise<void> {
    if (!hasCameraSource(printer)) {
      this.cameras.set(printer.id, {
        state: "none",
        snapshotAt: null,
        frame: null,
        fetchedAt: Date.now()
      });
      return;
    }

    const entry = this.cameras.get(printer.id);
    if (entry && Date.now() - entry.fetchedAt < CAMERA_PROBE_INTERVAL_MS) return;

    const frame = await captureCameraFrame(printer);
    this.cameras.set(printer.id, {
      state: frame ? "online" : "offline",
      snapshotAt: frame ? hhmm() : entry?.snapshotAt ?? null,
      frame: frame ?? entry?.frame ?? null,
      fetchedAt: Date.now()
    });
  }

  /** A real camera frame for `GET /api/printers/:id/camera.jpg`. */
  async getCameraFrame(id: string): Promise<CameraFrame> {
    const printer = this.getConfigOrThrow(id);
    if (!hasCameraSource(printer)) {
      throw new CameraError(id, "камера не настроена");
    }

    const entry = this.cameras.get(id);
    if (entry?.frame && Date.now() - entry.fetchedAt < CAMERA_FRAME_FRESH_MS) {
      return entry.frame;
    }

    const frame = await captureCameraFrame(printer);
    if (!frame) {
      this.cameras.set(id, {
        state: "offline",
        snapshotAt: entry?.snapshotAt ?? null,
        frame: entry?.frame ?? null,
        fetchedAt: Date.now()
      });
      throw new CameraError(id, "нет сигнала");
    }

    this.cameras.set(id, {
      state: "online",
      snapshotAt: hhmm(),
      frame,
      fetchedAt: Date.now()
    });
    return frame;
  }


  /** A live camera stream for `GET /api/printers/:id/camera.mp4`. */
  async getCameraStream(id: string): Promise<CameraStream> {
    const printer = this.getConfigOrThrow(id);
    if (!hasCameraStream(printer)) {
      throw new CameraError(id, "трансляция не настроена");
    }

    const stream = await openCameraStream(printer);
    if (!stream) {
      throw new CameraError(id, "нет видеопотока");
    }

    return stream;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  getService(): ServiceStatus {
    const views = this.listPrinters();
    const troubled =
      views.some((p) => p.status === "error" || p.status === "offline" || p.status === "unknown") ||
      Boolean(this.configSource.warning);
    return {
      status: troubled ? "degraded" : "ok",
      backend: "ok",
      version: env.serviceVersion,
      startedHoursAgo: Math.round((Date.now() - this.startedAt) / (60 * MS_PER_MIN))
    };
  }

  listPrinters(): PrinterView[] {
    return this.configs.filter((p) => p.enabled).map((p) => this.toView(p));
  }

  listActivePrinters(): PrinterView[] {
    return this.listPrinters().filter((p) => isBusyStatus(p.status));
  }

  getPrinter(id: string): PrinterView {
    return this.toView(this.getConfigOrThrow(id));
  }

  getQueue(): QueueJob[] {
    return this.queue.map((job) => ({ ...job }));
  }

  getNight(): NightPrint {
    // The window is config; candidates would come from a risk model that does
    // not exist yet, so the list stays honestly empty.
    return { window: env.nightWindow, candidates: [], pick: 0 };
  }

  getCritical(): CriticalEvent[] {
    const critical: CriticalEvent[] = [];
    for (const printer of this.configs.filter((p) => p.enabled)) {
      const status = this.statuses.get(printer.id);
      const time = this.changedAt.get(printer.id) ?? (status ? hhmm(new Date(status.updatedAt)) : "—");
      if (!status) continue;

      if (status.status === "error") {
        critical.push({
          icon: "⚠",
          text: `${printer.name}: ${status.error ?? "принтер сообщил об ошибке"}`,
          time,
          level: "err"
        });
      } else if (!status.online) {
        critical.push({
          icon: "⛓",
          text: `Нет связи с ${printer.name}${status.error ? ` (${status.error})` : ""}`,
          time,
          level: "err"
        });
      }

      const camera = this.cameras.get(printer.id);
      if (camera?.state === "offline") {
        critical.push({
          icon: "◉",
          text: `Камера ${printer.name} не отвечает`,
          time: camera.snapshotAt ?? time,
          level: "warn"
        });
      }
    }
    return critical;
  }

  getMaterials(): MaterialsSection {
    // No stock tracking is connected: report nothing instead of fake spools.
    // The per-printer loaded material (from config) is visible on the printer
    // views themselves.
    return { filament: [], resin: [], mismatch: [], queueNeeds: [] };
  }

  getToday(): TodaySection {
    this.rolloverToday();
    return {
      done: this.todayDone,
      active: this.listActivePrinters().length,
      failed: this.todayFailed,
      hoursUsed: null,
      hoursQueued: null
    };
  }

  getPerformance(): PerformanceSection {
    const views = this.listPrinters();
    const free = views.filter((p) => p.status === "idle").length;
    const busy = views.filter((p) => isBusyStatus(p.status)).length;
    const maintenance = views.filter((p) => p.status === "maintenance").length;
    return {
      load: views.length > 0 ? Math.round((busy / views.length) * 100) : null,
      free,
      busy,
      maintenance,
      avgPrint: null,
      successRate: null
    };
  }

  getAutomations(): AutomationsSection {
    // No automation engine is wired up yet — an empty list, not demo rules.
    return { automations: [], lastRun: null };
  }

  getSystem(): SystemComponent[] {
    const enabled = this.configs.filter((p) => p.enabled);
    const online = enabled.filter((p) => this.statuses.get(p.id)?.online).length;
    const camsConfigured = enabled.filter((p) => hasCameraSource(p)).length;
    const camsOnline = enabled.filter((p) => this.cameras.get(p.id)?.state === "online").length;

    const configVal =
      this.configSource.kind === "file"
        ? `${this.configSource.path ?? "файл"} · ${enabled.length} принтеров`
        : this.configSource.kind === "env"
          ? `PRINTERS_CONFIG_JSON · ${enabled.length} принтеров`
          : "не настроена";

    const components: SystemComponent[] = [
      { name: "Версия сервиса", val: `${env.serviceVersion} · ${env.nodeEnv}`, ok: "ok" },
      { name: "Запуск сервиса", val: humanizeSince(Date.now() - this.startedAt), ok: "ok" },
      {
        name: "Конфигурация принтеров",
        val: this.configSource.warning ? `${configVal} — ${this.configSource.warning}` : configVal,
        ok: this.configSource.warning ? "err" : enabled.length > 0 ? "ok" : "warn"
      },
      {
        name: "Опрос принтеров",
        val: this.lastPollAt
          ? `каждые ${Math.round(env.printerPollIntervalMs / 1000)} с · последний в ${hhmm(new Date(this.lastPollAt))}`
          : "ещё не выполнялся",
        ok: this.lastPollAt ? "ok" : "warn"
      },
      {
        name: "Связь с принтерами",
        val: enabled.length > 0 ? `${online}/${enabled.length} online` : "нет принтеров",
        ok: enabled.length === 0 ? "warn" : online === enabled.length ? "ok" : "warn"
      },
      {
        name: "Камеры",
        val: camsConfigured > 0 ? `${camsOnline}/${camsConfigured} доступны` : "не настроены",
        ok: camsConfigured === 0 ? "warn" : camsOnline === camsConfigured ? "ok" : "warn"
      },
      { name: "Очередь", val: `${this.queue.length} заданий · в памяти сервиса`, ok: "ok" },
      { name: "База данных", val: "не подключена — состояние хранится в памяти", ok: "warn" }
    ];
    return components;
  }

  getFeed(): FeedEvent[] {
    return [...this.feed];
  }

  getWarnings(): Warning[] {
    const warnings: Warning[] = [];

    if (this.configSource.warning) {
      warnings.push({
        icon: "⚙",
        text: "Проблема с конфигурацией принтеров",
        hint: this.configSource.warning,
        level: "err"
      });
    }

    const enabled = this.configs.filter((p) => p.enabled);
    if (enabled.length === 0) {
      warnings.push({
        icon: "⚙",
        text: "Принтеры не настроены",
        hint: "добавьте config/printers.json или переменную PRINTERS_CONFIG_JSON",
        level: "warn"
      });
    }

    for (const printer of enabled) {
      const status = this.statuses.get(printer.id);
      if (!status || status.status === "unknown") {
        warnings.push({
          icon: "❔",
          text: `Статус ${printer.name} неизвестен`,
          hint: status?.error ?? "принтер ещё не ответил на опрос",
          level: "warn"
        });
      } else if (!status.online) {
        warnings.push({
          icon: "⛓",
          text: `Нет связи с принтером ${printer.name}`,
          hint: status.error ?? "проверьте питание и сеть",
          level: "err"
        });
      }

      if (printer.protocol === "bambu" && (!printer.serial || !printer.accessCode)) {
        warnings.push({
          icon: "🔑",
          text: `${printer.name}: не задан serial/accessCode`,
          hint: "укажите BAMBU access code через переменную окружения",
          level: "warn"
        });
      }

      if (!hasCameraSource(printer)) {
        warnings.push({
          icon: "◉",
          text: `У ${printer.name} не настроена камера`,
          hint: "задайте snapshotUrl в конфигурации принтера",
          level: "info"
        });
      } else if (this.cameras.get(printer.id)?.state === "offline") {
        warnings.push({
          icon: "◉",
          text: `Камера ${printer.name} недоступна`,
          hint: "поток не отвечает — проверьте камеру",
          level: "warn"
        });
      }

      if (!printer.material) {
        warnings.push({
          icon: "🧵",
          text: `Материал в ${printer.name} не указан`,
          hint: "заполните поле material в конфигурации",
          level: "info"
        });
      }
    }

    return warnings;
  }

  getPlan(): PlanSection {
    // No scheduler yet: the plan is honestly empty rather than invented.
    return { next: null, upcoming: [], queueEta: null, nightReady: null, manual: [] };
  }

  getMaintenance(): MaintenanceRow[] {
    // Maintenance history is not tracked anywhere real yet.
    return [];
  }

  getCameras(): CameraView[] {
    return this.configs
      .filter((p) => p.enabled && hasCameraSource(p))
      .map((p) => {
        const view = this.toView(p);
        return {
          id: p.id,
          name: p.name,
          camera: view.camera,
          cameraStream: view.cameraStream,
          light: false,
          status: view.status,
          snapshotAt: view.snapshotAt
        };
      });
  }

  /** The entire board in one payload — mirrors the frontend `state` object. */
  snapshot(): DashboardSnapshot {
    const automations = this.getAutomations();
    return {
      service: this.getService(),
      printers: this.listPrinters(),
      queue: this.getQueue(),
      night: this.getNight(),
      critical: this.getCritical(),
      materials: this.getMaterials(),
      today: this.getToday(),
      perf: this.getPerformance(),
      automations: automations.automations,
      automationLastRun: automations.lastRun,
      system: this.getSystem(),
      feed: this.getFeed(),
      warnings: this.getWarnings(),
      plan: this.getPlan(),
      maintenance: this.getMaintenance()
    };
  }

  // ── Actions (real driver commands) ───────────────────────────────────────

  async pausePrinter(id: string): Promise<PrinterView> {
    const printer = this.getReachableConfig(id);
    const status = this.statuses.get(id);
    if (status?.status !== "printing") {
      throw new JobError(`Принтер «${printer.name}» не печатает — ставить на паузу нечего`);
    }
    await this.dispatchCommand(printer, "pause");
    this.pushEvent("⏸", `Оператор поставил <b>${printer.name}</b> на паузу`, "info");
    return this.refreshPrinter(printer);
  }

  async resumePrinter(id: string): Promise<PrinterView> {
    const printer = this.getReachableConfig(id);
    const status = this.statuses.get(id);
    if (status?.status !== "paused") {
      throw new JobError(`Печать на «${printer.name}» не стоит на паузе`);
    }
    await this.dispatchCommand(printer, "resume");
    this.pushEvent("▶", `<b>${printer.name}</b> продолжил печать`, "ok");
    return this.refreshPrinter(printer);
  }

  async cancelPrinter(id: string): Promise<PrinterView> {
    const printer = this.getReachableConfig(id);
    const status = this.statuses.get(id);
    if (!status || !isBusyStatus(status.status)) {
      throw new JobError(`На «${printer.name}» нет активной печати для отмены`);
    }
    const job = status.currentFile;
    await this.dispatchCommand(printer, "cancel");
    this.pushEvent(
      "✕",
      `Печать «${job ?? "—"}» на <b>${printer.name}</b> отменена оператором`,
      "err"
    );
    return this.refreshPrinter(printer);
  }

  async setLight(id: string, _on: boolean): Promise<PrinterView> {
    const printer = this.getReachableConfig(id);
    throw new JobError(
      `Управление подсветкой для «${printer.name}» пока не поддерживается`
    );
  }

  async snapshotPrinter(id: string): Promise<PrinterView> {
    const printer = this.getConfigOrThrow(id);
    await this.getCameraFrame(printer.id);
    this.pushEvent("◉", `Сделан снимок с камеры <b>${printer.name}</b>`, "info");
    return this.toView(printer);
  }

  toggleAutomation(id: string, _on?: boolean): Automation {
    // Honest: there are no automation rules until a real engine exists.
    throw new NotFoundError(`Automation "${id}"`);
  }

  advanceNightPick(): NightPrint {
    throw new JobError("Планировщик ночной печати пока не подключён — нет кандидатов");
  }

  startNight(): { candidate: NightPrint["candidates"][number]; window: string } {
    throw new JobError("Планировщик ночной печати пока не подключён — нет кандидатов");
  }

  startNext(): QueueJob {
    const next = this.queue.find((job) => job.status === "ready");
    if (!next) {
      throw new JobError("В очереди нет заданий, готовых к запуску");
    }
    // Starting a job requires the print file to be present on the printer;
    // remote upload/start is not implemented, and pretending otherwise would
    // mark queue entries as printing while the device stays idle.
    throw new JobError(
      "Удалённый запуск заданий пока не поддерживается — запустите файл на самом принтере"
    );
  }

  addQueueJob(input: NewQueueJobInput): QueueJob {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) {
      throw new ValidationError("Поле «title» обязательно");
    }

    const printer = typeof input.printer === "string" ? input.printer.trim() : "";
    const job: QueueJob = {
      id: `q${++this.queueSeq}`,
      title,
      printer: printer || "—",
      material:
        typeof input.material === "string" && input.material.trim() ? input.material.trim() : "—",
      eta: typeof input.eta === "string" && input.eta.trim() ? input.eta.trim() : "—",
      at: typeof input.at === "string" && input.at.trim() ? input.at.trim() : "в очереди",
      status: printer ? "ready" : "review",
      ...(input.night === true ? { night: true } : {}),
      ...(printer ? {} : { reason: "не задан принтер" })
    };

    this.queue.push(job);
    this.pushEvent("＋", `Задание «${title}» добавлено в очередь`, "info");
    return { ...job };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private toView(printer: PrinterConfig): PrinterView {
    const status = this.statuses.get(printer.id);
    const camera = this.cameras.get(printer.id);

    const viewStatus: PrinterView["status"] = !status
      ? "unknown"
      : !status.online
        ? status.status === "unknown"
          ? "unknown"
          : "offline"
        : status.status;

    return {
      id: printer.id,
      name: printer.name,
      model: printer.model || null,
      type: printer.type,
      status: viewStatus,
      job: status?.currentFile ?? null,
      progress: status?.progressPct ?? null,
      nozzle: status && status.nozzleTemp !== null ? [status.nozzleTemp, status.nozzleTarget] : null,
      bed: status && status.bedTemp !== null ? [status.bedTemp, status.bedTarget] : null,
      chamber: status?.chamberTemp ?? null,
      minutesLeft: status?.remainingMinutes ?? null,
      material: printer.material || null,
      swatch: printer.swatch || null,
      camera: hasCameraSource(printer) ? camera?.state ?? "offline" : "none",
      cameraStream: hasCameraStream(printer),
      light: null,
      snapshotAt: camera?.snapshotAt ?? null,
      ...(status?.error ? { error: status.error } : {})
    };
  }

  private getConfigOrThrow(id: string): PrinterConfig {
    const printer = this.configs.find((p) => p.id === id && p.enabled);
    if (!printer) {
      throw new NotFoundError(`Printer "${id}"`);
    }
    return printer;
  }

  /** Like {@link getConfigOrThrow} but also rejects unreachable printers. */
  private getReachableConfig(id: string): PrinterConfig {
    const printer = this.getConfigOrThrow(id);
    const status = this.statuses.get(id);
    if (!status || !status.online) {
      throw new PrinterOfflineError(id);
    }
    return printer;
  }

  private async dispatchCommand(printer: PrinterConfig, command: PrinterCommand): Promise<void> {
    try {
      await sendPrinterCommand(printer, command);
    } catch (error) {
      if (error instanceof PrinterCommandError) {
        throw new JobError(error.message);
      }
      throw new PrinterConnectionError(
        printer.id,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /** Re-polls one printer right after a command so the view reflects reality. */
  private async refreshPrinter(printer: PrinterConfig): Promise<PrinterView> {
    const status = await getPrinterLiveStatus(printer);
    this.statuses.set(printer.id, status);
    return this.toView(printer);
  }

  private pushEvent(icon: string, text: string, kind: FeedKind): void {
    this.feed.unshift({ icon, text, time: hhmm(), kind });
    // Keep the live feed bounded so it does not grow without limit.
    if (this.feed.length > 50) {
      this.feed.length = 50;
    }
  }
}

export const farmStore = new FarmStore();
