import {
  CameraError,
  JobError,
  NotFoundError,
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
import { toPrinterView, type PrinterRecord, type PrinterView } from "../../domain/printers/types";
import { hhmm } from "../../shared/time";
import { seedFarmData, type FarmData } from "./seed";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MIN = 60 * 1000;

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

function isBusy(printer: { status: string }): boolean {
  return printer.status === "printing" || printer.status === "paused";
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
 * In-memory, seeded source of truth for the whole farm. It owns the mutable
 * {@link FarmData} and exposes read projections (dashboard DTOs) plus the
 * action mutations the dashboard triggers.
 *
 * This is the single seam to replace with real infrastructure later: reads
 * would query a database + live printer telemetry, and each mutation would
 * dispatch to a printer driver (see apps/fulfillment and
 * src/infra/drivers/*) at the `// TODO(real driver)` markers. The HTTP layer
 * and dashboard contract stay unchanged.
 */
export class FarmStore {
  private data: FarmData;
  private queueSeq: number;

  constructor(data: FarmData = seedFarmData()) {
    this.data = data;
    this.queueSeq = data.queue.length;
  }

  /** Discard all state and re-seed. Handy for tests. */
  reset(): void {
    this.data = seedFarmData();
    this.queueSeq = this.data.queue.length;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  getService(): ServiceStatus {
    const troubled = this.data.printers.some(
      (p) => p.status === "error" || p.status === "offline"
    );
    return {
      status: troubled ? "degraded" : "ok",
      backend: "ok",
      version: this.data.version,
      startedHoursAgo: Math.round((Date.now() - this.data.startedAt) / MS_PER_HOUR)
    };
  }

  listPrinters(): PrinterView[] {
    return this.data.printers.map(toPrinterView);
  }

  listActivePrinters(): PrinterView[] {
    return this.data.printers.filter(isBusy).map(toPrinterView);
  }

  getPrinter(id: string): PrinterView {
    return toPrinterView(this.getRecordOrThrow(id));
  }

  getQueue(): QueueJob[] {
    return [...this.data.queue];
  }

  getNight(): NightPrint {
    return structuredClone(this.data.night);
  }

  getCritical(): CriticalEvent[] {
    return [...this.data.critical];
  }

  getMaterials(): MaterialsSection {
    return structuredClone(this.data.materials);
  }

  getToday(): TodaySection {
    // `active` reflects the live farm; the rest are day totals from the store.
    const active = this.data.printers.filter(isBusy).length;
    return { ...this.data.today, active };
  }

  getPerformance(): PerformanceSection {
    // Instantaneous counts are derived; load / averages are farm history.
    const free = this.data.printers.filter((p) => p.status === "idle").length;
    const busy = this.data.printers.filter(isBusy).length;
    const maintenance = this.data.printers.filter((p) => p.status === "maintenance").length;
    return { ...this.data.perf, free, busy, maintenance };
  }

  getAutomations(): AutomationsSection {
    return {
      automations: this.data.automations.map((a) => ({ ...a })),
      lastRun: this.data.automationLastRun
    };
  }

  getSystem(): SystemComponent[] {
    const uptime = humanizeSince(Date.now() - this.data.startedAt);
    const queueCount = this.data.queue.length;
    const ruleCount = this.data.automations.length;
    // Refresh the entries that reflect live state; keep the rest as configured.
    return this.data.system.map((component) => {
      switch (component.name) {
        case "Запуск сервиса":
          return { ...component, val: uptime };
        case "Очередь":
          return { ...component, val: `${queueCount} заданий · работает` };
        case "Automation worker":
          return { ...component, val: `активен · ${ruleCount} правил` };
        default:
          return { ...component };
      }
    });
  }

  getFeed(): FeedEvent[] {
    return [...this.data.feed];
  }

  getWarnings(): Warning[] {
    return [...this.data.warnings];
  }

  getPlan(): PlanSection {
    return structuredClone(this.data.plan);
  }

  getMaintenance(): MaintenanceRow[] {
    return this.data.maintenance.map((row) => ({ ...row }));
  }

  getCameras(): CameraView[] {
    return this.data.printers
      .filter((p) => p.camera !== "none")
      .map((p) => ({
        id: p.id,
        name: p.name,
        camera: p.camera,
        light: p.light,
        status: p.status,
        snapshotAt: p.snapshotAt
      }));
  }

  /** The entire board in one payload — mirrors the frontend `state` object. */
  snapshot(): DashboardSnapshot {
    return {
      service: this.getService(),
      printers: this.listPrinters(),
      queue: this.getQueue(),
      night: this.getNight(),
      critical: this.getCritical(),
      materials: this.getMaterials(),
      today: this.getToday(),
      perf: this.getPerformance(),
      automations: this.getAutomations().automations,
      automationLastRun: this.data.automationLastRun,
      system: this.getSystem(),
      feed: this.getFeed(),
      warnings: this.getWarnings(),
      plan: this.getPlan(),
      maintenance: this.getMaintenance()
    };
  }

  // ── Actions (mutations) ────────────────────────────────────────────────
  // Each validates against the current state using the error taxonomy, then
  // updates the store. A real deployment would additionally dispatch to the
  // printer driver at the marked seams.

  pausePrinter(id: string): PrinterView {
    const printer = this.getReachableRecord(id);
    if (printer.status !== "printing") {
      throw new JobError(`Принтер «${printer.name}» не печатает — ставить на паузу нечего`);
    }
    // TODO(real driver): await driver.pauseJob(printer, job)
    printer.status = "paused";
    this.pushEvent("⏸", `Оператор поставил <b>${printer.name}</b> на паузу`, "info");
    return toPrinterView(printer);
  }

  resumePrinter(id: string): PrinterView {
    const printer = this.getReachableRecord(id);
    if (printer.status !== "paused") {
      throw new JobError(`Печать на «${printer.name}» не стоит на паузе`);
    }
    // TODO(real driver): await driver.resumeJob(printer, job)
    printer.status = "printing";
    this.pushEvent("▶", `<b>${printer.name}</b> продолжил печать`, "ok");
    return toPrinterView(printer);
  }

  cancelPrinter(id: string): PrinterView {
    const printer = this.getReachableRecord(id);
    if (!isBusy(printer)) {
      throw new JobError(`На «${printer.name}» нет активной печати для отмены`);
    }
    // TODO(real driver): await driver.cancelJob(printer, job)
    const job = printer.job;
    printer.status = "idle";
    printer.job = null;
    printer.progress = 0;
    printer.minutesLeft = 0;
    this.pushEvent(
      "✕",
      `Печать «${job ?? "—"}» на <b>${printer.name}</b> отменена оператором`,
      "err"
    );
    return toPrinterView(printer);
  }

  setLight(id: string, on: boolean): PrinterView {
    const printer = this.getReachableRecord(id);
    // TODO(real driver): await driver.setChamberLight(printer, on)
    printer.light = on;
    return toPrinterView(printer);
  }

  snapshotPrinter(id: string): PrinterView {
    const printer = this.getReachableRecord(id);
    if (printer.camera !== "online") {
      throw new CameraError(
        id,
        printer.camera === "none" ? "камера не настроена" : "нет сигнала"
      );
    }
    // TODO(real driver): image = await camera.captureSnapshot(printer)
    printer.snapshotAt = hhmm();
    this.pushEvent("◉", `Сделан снимок с камеры <b>${printer.name}</b>`, "info");
    return toPrinterView(printer);
  }

  toggleAutomation(id: string, on?: boolean): Automation {
    const rule = this.data.automations.find((a) => a.id === id);
    if (!rule) {
      throw new NotFoundError(`Automation "${id}"`);
    }
    rule.on = on ?? !rule.on;
    return { ...rule };
  }

  advanceNightPick(): NightPrint {
    const { night } = this.data;
    if (night.candidates.length > 0) {
      night.pick = (night.pick + 1) % night.candidates.length;
    }
    return structuredClone(night);
  }

  startNight(): { candidate: NightPrint["candidates"][number]; window: string } {
    const { night } = this.data;
    const candidate = night.candidates[night.pick];
    if (!candidate) {
      throw new JobError("Нет подходящего задания для ночной печати");
    }
    // TODO(real driver): schedule candidate on printer for the night window
    this.pushEvent(
      "☾",
      `Запланирована ночная печать «${candidate.title}» на <b>${candidate.printer}</b>`,
      "ok"
    );
    return { candidate: { ...candidate }, window: night.window };
  }

  startNext(): QueueJob {
    const next = this.data.queue.find((job) => job.status === "ready");
    if (!next) {
      throw new JobError("В очереди нет заданий, готовых к запуску");
    }

    const printer = this.data.printers.find((p) => p.name === next.printer);
    if (printer) {
      if (printer.status === "offline") {
        throw new PrinterOfflineError(printer.id);
      }
      if (printer.status !== "idle") {
        throw new JobError(`Принтер «${printer.name}» сейчас занят`);
      }
      // TODO(real driver): await driver.startJob(printer, next)
      printer.status = "printing";
      printer.job = next.title;
      printer.progress = 0;
    }

    this.data.queue = this.data.queue.filter((job) => job.id !== next.id);
    this.pushEvent("▶", `Задание «${next.title}» отправлено на <b>${next.printer}</b>`, "ok");
    return { ...next };
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
      material: typeof input.material === "string" && input.material.trim() ? input.material.trim() : "—",
      eta: typeof input.eta === "string" && input.eta.trim() ? input.eta.trim() : "—",
      at: typeof input.at === "string" && input.at.trim() ? input.at.trim() : "в очереди",
      status: printer ? "ready" : "review",
      ...(input.night === true ? { night: true } : {}),
      ...(printer ? {} : { reason: "не задан принтер" })
    };

    this.data.queue.push(job);
    this.pushEvent("＋", `Задание «${title}» добавлено в очередь`, "info");
    return { ...job };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private getRecordOrThrow(id: string): PrinterRecord {
    const printer = this.data.printers.find((p) => p.id === id);
    if (!printer) {
      throw new NotFoundError(`Printer "${id}"`);
    }
    return printer;
  }

  /** Like {@link getRecordOrThrow} but also rejects offline printers. */
  private getReachableRecord(id: string): PrinterRecord {
    const printer = this.getRecordOrThrow(id);
    if (printer.status === "offline") {
      throw new PrinterOfflineError(id);
    }
    return printer;
  }

  private pushEvent(icon: string, text: string, kind: FeedKind): void {
    this.data.feed.unshift({ icon, text, time: hhmm(), kind });
    // Keep the live feed bounded so it does not grow without limit.
    if (this.data.feed.length > 50) {
      this.data.feed.length = 50;
    }
  }
}

export const farmStore = new FarmStore();
