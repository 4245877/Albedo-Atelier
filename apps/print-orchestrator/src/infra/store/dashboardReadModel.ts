import type {
  AutomationsSection,
  CameraView,
  CriticalEvent,
  DashboardSnapshot,
  FeedEvent,
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
import type { PrinterView } from "../../domain/printers/types";
import { env } from "../../shared/env";
import { hhmm } from "../../shared/time";
import { hasCameraSource } from "../printers/camera";
import type { PrinterConfig, PrinterConfigSource } from "../printers/config";
import type { AutomationStore } from "./automationStore";
import type { CameraService } from "./cameraService";
import type { EventFeed } from "./eventFeed";
import { buildNightPlan, type NightPlanEntry } from "./nightPlanner";
import { buildPrinterView, isBusyStatus } from "./printerView";
import type { PrinterPoller } from "./printerPoller";
import type { QueueStore } from "./queueStore";

const MS_PER_MIN = 60 * 1000;

/** Real readiness, derived from whether the poll loop is running and fresh. */
export interface FarmReadiness {
  /** false → the service should return 503. */
  ready: boolean;
  status: "ready" | "degraded" | "starting" | "stale";
  service: string;
  startedAt: string;
  lastPollAt: string | null;
  lastPollAgeSeconds: number | null;
  printers: { total: number; online: number };
}

/** Real farm counters exposed as Prometheus metrics. */
export interface FarmMetrics {
  up: number;
  uptimeSeconds: number;
  lastPollAgeSeconds: number | null;
  degraded: number;
  printersTotal: number;
  printersOnline: number;
  printersPrinting: number;
  printersError: number;
  camerasTotal: number;
  camerasOnline: number;
  queueJobs: number;
  completedToday: number;
  failedToday: number;
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

/**
 * Projects the live farm state into the exact JSON shapes the dashboard renders.
 * Reads only — everything the farm genuinely does not know (material stock,
 * maintenance history, schedule) is returned empty/null, never invented.
 */
export class DashboardReadModel {
  constructor(
    private readonly enabledConfigs: () => PrinterConfig[],
    private readonly configById: (id: string) => PrinterConfig,
    private readonly getConfigSource: () => PrinterConfigSource,
    private readonly startedAt: number,
    private readonly poller: PrinterPoller,
    private readonly cameras: CameraService,
    private readonly queue: QueueStore,
    private readonly events: EventFeed,
    private readonly automations: AutomationStore,
    private readonly getNightPick: () => number
  ) {}

  private view(printer: PrinterConfig): PrinterView {
    return buildPrinterView(printer, this.poller.getStatus(printer.id), this.cameras.getEntry(printer.id));
  }

  listPrinters(): PrinterView[] {
    return this.enabledConfigs().map((p) => this.view(p));
  }

  listActivePrinters(): PrinterView[] {
    return this.listPrinters().filter((p) => isBusyStatus(p.status));
  }

  getPrinter(id: string): PrinterView {
    return this.view(this.configById(id));
  }

  getService(): ServiceStatus {
    const views = this.listPrinters();
    const troubled =
      views.some((p) => p.status === "error" || p.status === "offline" || p.status === "unknown") ||
      Boolean(this.getConfigSource().warning);
    return {
      status: troubled ? "degraded" : "ok",
      backend: "ok",
      version: env.serviceVersion,
      startedHoursAgo: Math.round((Date.now() - this.startedAt) / (60 * MS_PER_MIN))
    };
  }

  /**
   * Real readiness for `GET /ready`. Not ready (→ 503) until the first poll has
   * completed, or again if the poll loop has gone stale (no successful poll for
   * 3× the interval) — which means live telemetry can no longer be trusted.
   * A merely degraded farm (some printers offline) is still ready and serving.
   */
  getReadiness(): FarmReadiness {
    const now = Date.now();
    const lastPollAt = this.poller.getLastPollAt();
    const lastPollAgeSeconds = lastPollAt === null ? null : Math.round((now - lastPollAt) / 1000);
    const staleThresholdSec = Math.max(30, Math.round((env.printerPollIntervalMs * 3) / 1000));

    let status: FarmReadiness["status"];
    let ready: boolean;
    if (lastPollAt === null) {
      status = "starting";
      ready = false;
    } else if (lastPollAgeSeconds !== null && lastPollAgeSeconds > staleThresholdSec) {
      status = "stale";
      ready = false;
    } else if (this.getService().status === "degraded") {
      status = "degraded";
      ready = true;
    } else {
      status = "ready";
      ready = true;
    }

    const enabled = this.enabledConfigs();
    return {
      ready,
      status,
      service: env.serviceName,
      startedAt: new Date(this.startedAt).toISOString(),
      lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
      lastPollAgeSeconds,
      printers: {
        total: enabled.length,
        online: enabled.filter((p) => this.poller.getStatus(p.id)?.online).length
      }
    };
  }

  /** Real farm counters for `GET /metrics` (Prometheus). */
  getMetricsSnapshot(): FarmMetrics {
    const enabled = this.enabledConfigs();
    const views = this.listPrinters();
    const lastPollAt = this.poller.getLastPollAt();
    return {
      up: 1,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      lastPollAgeSeconds: lastPollAt === null ? null : Math.round((Date.now() - lastPollAt) / 1000),
      degraded: this.getService().status === "degraded" ? 1 : 0,
      printersTotal: enabled.length,
      printersOnline: enabled.filter((p) => this.poller.getStatus(p.id)?.online).length,
      printersPrinting: views.filter((p) => p.status === "printing").length,
      printersError: views.filter((p) => p.status === "error").length,
      camerasTotal: enabled.filter((p) => hasCameraSource(p)).length,
      camerasOnline: enabled.filter((p) => this.cameras.getEntry(p.id)?.state === "online").length,
      queueJobs: this.queue.size(),
      completedToday: this.poller.getTodayDone(),
      failedToday: this.poller.getTodayFailed()
    };
  }

  getQueue(): QueueJob[] {
    return this.queue.list();
  }

  /**
   * The night-print plan: ranked candidates drawn from the queue with their
   * blockers, gated by the `night-queue` automation. When the rule is off the
   * plan is empty — the toggle genuinely suppresses the suggestions.
   */
  getNightPlan(): NightPlanEntry[] {
    if (!this.automations.isEnabled("night-queue")) return [];
    return buildNightPlan(this.queue.list(), {
      window: env.nightWindow,
      resolvePrinter: (job) => this.resolvePrinter(job.printer),
      getStatus: (id) => this.poller.getStatus(id)
    });
  }

  /** Resolves a queue job's free-text printer field to a config by id or name. */
  resolvePrinter(reference: string): PrinterConfig | undefined {
    const wanted = reference.trim().toLowerCase();
    if (!wanted || wanted === "—") return undefined;
    return this.enabledConfigs().find(
      (p) => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted
    );
  }

  getNight(): NightPrint {
    const candidates = this.getNightPlan().map((entry) => entry.candidate);
    const pick = candidates.length === 0 ? 0 : Math.min(this.getNightPick(), candidates.length - 1);
    return { window: env.nightWindow, candidates, pick };
  }

  getCritical(): CriticalEvent[] {
    const critical: CriticalEvent[] = [];
    for (const printer of this.enabledConfigs()) {
      const status = this.poller.getStatus(printer.id);
      const time =
        this.poller.getChangedAt(printer.id) ?? (status ? hhmm(new Date(status.updatedAt)) : "—");
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

      const camera = this.cameras.getEntry(printer.id);
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
    return {
      done: this.poller.getTodayDone(),
      active: this.listActivePrinters().length,
      failed: this.poller.getTodayFailed(),
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
    return { automations: this.automations.list(), lastRun: this.automations.getLastRun() };
  }

  getSystem(): SystemComponent[] {
    const enabled = this.enabledConfigs();
    const source = this.getConfigSource();
    const lastPollAt = this.poller.getLastPollAt();
    const online = enabled.filter((p) => this.poller.getStatus(p.id)?.online).length;
    const camsConfigured = enabled.filter((p) => hasCameraSource(p)).length;
    const camsOnline = enabled.filter((p) => this.cameras.getEntry(p.id)?.state === "online").length;

    const configVal =
      source.kind === "file"
        ? `${source.path ?? "файл"} · ${enabled.length} принтеров`
        : source.kind === "env"
          ? `PRINTERS_CONFIG_JSON · ${enabled.length} принтеров`
          : "не настроена";

    return [
      { name: "Версия сервиса", val: `${env.serviceVersion} · ${env.nodeEnv}`, ok: "ok" },
      { name: "Запуск сервиса", val: humanizeSince(Date.now() - this.startedAt), ok: "ok" },
      {
        name: "Конфигурация принтеров",
        val: source.warning ? `${configVal} — ${source.warning}` : configVal,
        ok: source.warning ? "err" : enabled.length > 0 ? "ok" : "warn"
      },
      {
        name: "Опрос принтеров",
        val: lastPollAt
          ? `каждые ${Math.round(env.printerPollIntervalMs / 1000)} с · последний в ${hhmm(new Date(lastPollAt))}`
          : "ещё не выполнялся",
        ok: lastPollAt ? "ok" : "warn"
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
      { name: "Очередь", val: `${this.queue.size()} заданий · сохраняется на диск`, ok: "ok" },
      {
        name: "База данных",
        val: "JSON-файл · очередь, события и счётчики переживают рестарт",
        ok: "ok"
      }
    ];
  }

  getFeed(): FeedEvent[] {
    return this.events.list();
  }

  getWarnings(): Warning[] {
    const warnings: Warning[] = [];

    const source = this.getConfigSource();
    if (source.warning) {
      warnings.push({
        icon: "⚙",
        text: "Проблема с конфигурацией принтеров",
        hint: source.warning,
        level: "err"
      });
    }

    const enabled = this.enabledConfigs();
    if (enabled.length === 0) {
      warnings.push({
        icon: "⚙",
        text: "Принтеры не настроены",
        hint: "добавьте config/printers.json или переменную PRINTERS_CONFIG_JSON",
        level: "warn"
      });
    }

    for (const printer of enabled) {
      const status = this.poller.getStatus(printer.id);
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
      } else if (this.cameras.getEntry(printer.id)?.state === "offline") {
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
    return this.enabledConfigs()
      .filter((p) => hasCameraSource(p))
      .map((p) => {
        const view = this.view(p);
        return {
          id: p.id,
          name: p.name,
          camera: view.camera,
          cameraStream: view.cameraStream,
          cameraSrc: view.cameraSrc,
          light: view.light ?? false,
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
}
