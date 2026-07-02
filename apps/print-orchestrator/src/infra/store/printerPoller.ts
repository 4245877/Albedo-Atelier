import { env } from "../../shared/env";
import { hhmm } from "../../shared/time";
import type { PrinterConfig } from "../printers/config";
import { getPrinterLiveStatus, type PrinterLiveStatus } from "../printers/status";
import type { CameraService } from "./cameraService";
import type { EventFeed } from "./eventFeed";

export type StoreLogger = {
  info?: (obj: unknown, message?: string) => void;
  warn?: (obj: unknown, message?: string) => void;
  error?: (obj: unknown, message?: string) => void;
};

const COMPLETE_RE = /complete|finish|done/i;
const CANCEL_RE = /cancel|abort|stop/i;

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
