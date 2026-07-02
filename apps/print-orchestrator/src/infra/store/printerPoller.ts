import { env } from "../../shared/env";
import { hhmm, isWithinLocalTimeWindow, parseLocalTimeWindow } from "../../shared/time";
import type { PrinterConfig } from "../printers/config";
import {
  getPrinterLiveStatus,
  sendPrinterLight,
  supportsPrinterLight,
  type PrinterLiveStatus
} from "../printers/status";
import type { CameraService } from "./cameraService";
import type { EventFeed } from "./eventFeed";

export type StoreLogger = {
  info?: (obj: unknown, message?: string) => void;
  warn?: (obj: unknown, message?: string) => void;
  error?: (obj: unknown, message?: string) => void;
};

const COMPLETE_RE = /complete|finish|done/i;
const CANCEL_RE = /cancel|abort|stop/i;
const MANUAL_LIGHT_OVERRIDE_MS = 5 * 60 * 1000;

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

/**
 * Background poll loop: fetches live telemetry per enabled printer, records the
 * real transitions it observes into the event feed, probes cameras, and keeps
 * the today completion/failure counters. Holds the live status map that the
 * read model and command service read.
 */
export class PrinterPoller {
  private statuses = new Map<string, PrinterLiveStatus>();
  /** hh:mm of the last observed state change per printer. */
  private changedAt = new Map<string, string>();
  private lastPollAt: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private logger: StoreLogger = {};
  private warnedInvalidNightWindow = false;
  /** Last light target successfully requested per printer. */
  private lightTargets = new Map<string, boolean>();
  /** Until this timestamp, scheduled light policy must not override manual changes. */
  private manualLightOverrides = new Map<string, number>();
  /** Last light policy failure signature per printer, used to avoid feed spam. */
  private lightFailureKeys = new Map<string, string>();

  /** Completions/failures the poller itself observed today. */
  private todayKey = dateKey();
  private todayDone = 0;
  private todayFailed = 0;

  constructor(
    private readonly enabledConfigs: () => PrinterConfig[],
    private readonly cameras: CameraService,
    private readonly events: EventFeed
  ) {}

  /** Runs the first poll, then starts the interval loop. */
  async start(logger: StoreLogger): Promise<void> {
    this.logger = logger;
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
  }

  /** Polls every enabled printer once and records observed transitions. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const enabled = this.enabledConfigs();
      await Promise.all(
        enabled.map(async (printer) => {
          const status = await getPrinterLiveStatus(printer);
          this.recordTransition(printer, this.statuses.get(printer.id), status);
          this.statuses.set(printer.id, status);
        })
      );
      await this.applyNightLightPolicy(enabled);
      await Promise.all(enabled.map((printer) => this.cameras.probe(printer)));
      this.lastPollAt = Date.now();
    } catch (error) {
      this.logger.error?.({ err: error }, "printer poll failed");
    } finally {
      this.polling = false;
    }
  }

  getStatus(id: string): PrinterLiveStatus | undefined {
    return this.statuses.get(id);
  }

  /** Overwrites one printer's status (used after a command re-poll). */
  setStatus(id: string, status: PrinterLiveStatus): void {
    this.statuses.set(id, status);
  }

  /** Temporarily lets an operator's explicit light command win over the schedule. */
  noteManualLightChange(id: string, on: boolean): void {
    this.lightTargets.set(id, on);
    this.lightFailureKeys.delete(id);
    this.manualLightOverrides.set(id, Date.now() + MANUAL_LIGHT_OVERRIDE_MS);
  }

  getChangedAt(id: string): string | undefined {
    return this.changedAt.get(id);
  }

  getLastPollAt(): number | null {
    return this.lastPollAt;
  }

  getTodayDone(): number {
    this.rolloverToday();
    return this.todayDone;
  }

  getTodayFailed(): number {
    this.rolloverToday();
    return this.todayFailed;
  }

  // ── Night light policy ─────────────────────────────────────────────────

  private currentNightLightTarget(): boolean {
    const window = parseLocalTimeWindow(env.nightWindow);
    if (!window) {
      if (!this.warnedInvalidNightWindow) {
        this.warnedInvalidNightWindow = true;
        this.logger.warn?.(
          { window: env.nightWindow },
          "invalid NIGHT_PRINT_WINDOW; printer lights will stay off"
        );
      }
      return false;
    }
    return isWithinLocalTimeWindow(window);
  }

  private async applyNightLightPolicy(printers: PrinterConfig[]): Promise<void> {
    const targetOn = this.currentNightLightTarget();
    await Promise.all(
      printers.map((printer) => this.applyNightLightPolicyToPrinter(printer, targetOn))
    );
  }

  private async applyNightLightPolicyToPrinter(
    printer: PrinterConfig,
    targetOn: boolean
  ): Promise<void> {
    if (!supportsPrinterLight(printer)) return;
    if (this.isManualLightOverrideActive(printer.id)) return;

    const status = this.statuses.get(printer.id);
    if (!status?.online) return;

    const current = status.light;
    const lastTarget = this.lightTargets.get(printer.id);
    if (current === targetOn) {
      this.lightTargets.set(printer.id, targetOn);
      this.lightFailureKeys.delete(printer.id);
      return;
    }
    if (current === null && lastTarget === targetOn) return;

    try {
      await sendPrinterLight(printer, targetOn);
      this.lightTargets.set(printer.id, targetOn);
      this.lightFailureKeys.delete(printer.id);

      if (current !== null) {
        this.statuses.set(printer.id, {
          ...status,
          light: targetOn,
          updatedAt: new Date().toISOString()
        });
      }

      this.events.push(
        targetOn ? "☾" : "☀",
        `<b>${printer.name}</b>: подсветка ${targetOn ? "включена на ночь" : "выключена на день"}`,
        "info"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureKey = `${targetOn}:${message}`;
      if (this.lightFailureKeys.get(printer.id) !== failureKey) {
        this.lightFailureKeys.set(printer.id, failureKey);
        this.events.push(
          "⚠",
          `<b>${printer.name}</b>: не удалось ${targetOn ? "включить" : "выключить"} подсветку (${message})`,
          "err"
        );
      }
      this.logger.warn?.(
        { err: error, printer: printer.id, targetOn },
        "night light policy failed"
      );
    }
  }

  private isManualLightOverrideActive(id: string): boolean {
    const until = this.manualLightOverrides.get(id);
    if (!until) return false;
    if (until > Date.now()) return true;
    this.manualLightOverrides.delete(id);
    return false;
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
      this.events.push("⛓", `${name} потерял связь${next.error ? ` (${next.error})` : ""}`, "err");
      return;
    }
    if (!prev.online && next.online) {
      this.events.push("↺", `${name} снова на связи`, "ok");
      if (prev.status === "offline" && next.status === prev.status) return;
    }

    if (next.status === "error" && prev.status !== "error") {
      this.todayFailed += 1;
      this.events.push("⚠", `${name}: ${next.error ?? "ошибка печати"}`, "err");
      return;
    }
    if (next.status === "printing" && prev.status !== "printing" && prev.status !== "paused") {
      this.events.push("▶", `${name} начал печать${job ? ` «${job}»` : ""}`, "ok");
      return;
    }
    if (next.status === "paused" && prev.status === "printing") {
      this.events.push("⏸", `${name}: печать на паузе${next.stateMessage ? ` — ${next.stateMessage}` : ""}`, "info");
      return;
    }
    if (next.status === "printing" && prev.status === "paused") {
      this.events.push("▶", `${name} продолжил печать`, "ok");
      return;
    }
    if (next.status === "idle" && (prev.status === "printing" || prev.status === "paused")) {
      if (looksCancelled(next)) {
        this.events.push("✕", `Печать${job ? ` «${job}»` : ""} на ${name} отменена`, "info");
        return;
      }
      if (looksComplete(next)) {
        this.todayDone += 1;
        this.events.push("✔", `${name} завершил печать${job ? ` «${job}»` : ""}`, "ok");
        return;
      }
      this.events.push("◌", `${name} перешёл в режим ожидания`, "info");
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
}
