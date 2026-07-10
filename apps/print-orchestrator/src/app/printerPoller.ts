import { randomUUID } from "node:crypto";

import type { PrinterConfig } from "../infra/printers/config";
import { getPrinterLiveStatus, type PrinterLiveStatus } from "../infra/printers/status";
import type { AmsTraySnapshot } from "../infra/printers/status/types";
import type { PersistedToday } from "../infra/persistence/stateStore";
import { env } from "../shared/env";
import type { StoreLogger } from "../shared/logger";
import { hhmm } from "../shared/time";
import type { CameraService } from "./cameraService";
import type { EventFeed } from "./eventFeed";
import { FilamentConsumption, type InventoryConsumer } from "./filamentConsumption";
import { LightScheduler } from "./lightScheduler";
import { TodayCounters } from "./todayCounters";

/** Per-printer identity of the in-flight print, for stable idempotent deduction. */
type PrintRun = {
  printId: string;
  file: string | null;
  /**
   * Wall-clock (Date.now()) when this print run was observed to start. The
   * anchor for the "average print duration" metric — present only for runs the
   * poller itself watched begin, so a print already running at startup or one
   * revived across a restart has none and is excluded from the average. Held in
   * memory only (like the rest of PrintRun): after a restart there is no known
   * start, so the run cannot be timed and is intentionally not counted.
   */
  startedAtMs: number;
  /** AMS tray `remain` snapshot at print start (Bambu), diffed at completion. */
  amsStart: AmsTraySnapshot[] | null;
};

const COMPLETE_RE = /complete|finish|done/i;
const CANCEL_RE = /cancel|abort|stop/i;
/**
 * How often accrued printing-hours are checkpointed to disk mid-print. The
 * `done`/`failed` counters persist on every transition, but a long print emits
 * no transition for hours, so we persist the running total at most this often
 * (instead of every poll) to bound both write churn and the loss on a crash.
 */
const HOURS_PERSIST_INTERVAL_MS = 60 * 1000;

function looksComplete(status: PrinterLiveStatus): boolean {
  if (status.stateText && CANCEL_RE.test(status.stateText)) return false;
  if (status.stateText && COMPLETE_RE.test(status.stateText)) return true;
  return status.progressPct !== null && status.progressPct >= 99;
}

function looksCancelled(status: PrinterLiveStatus): boolean {
  return Boolean(status.stateText && CANCEL_RE.test(status.stateText));
}

/**
 * Background poll loop: fetches live telemetry per enabled printer, records the
 * real transitions it observes into the event feed, probes cameras, and holds
 * the live status map that the read model and command service read. The
 * per-domain work is delegated: daily statistics to {@link TodayCounters}
 * (exposed as {@link PrinterPoller.today}), the chamber-light policy to
 * {@link LightScheduler} (exposed as {@link PrinterPoller.lights}) and
 * completion stock deduction to {@link FilamentConsumption}.
 */
export class PrinterPoller {
  private statuses = new Map<string, PrinterLiveStatus>();
  /** hh:mm of the last observed state change per printer. */
  private changedAt = new Map<string, string>();
  private lastPollAt: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private logger: StoreLogger = {};

  /** Completions/failures/printing-hours the poller itself observed today. */
  readonly today: TodayCounters;
  /** Night policy + manual override for the chamber lights. */
  readonly lights: LightScheduler;
  private readonly filament: FilamentConsumption;

  /** Wall-clock of the last accrual per printer; the anchor for the next interval. */
  private lastAccrualAt = new Map<string, number>();
  /** Wall-clock of the last throttled hours persist (see HOURS_PERSIST_INTERVAL_MS). */
  private lastHoursPersistAt = 0;

  /** Per-printer identity of the in-flight print, for stable idempotent deduction. */
  private printRuns = new Map<string, PrintRun>();

  constructor(
    private readonly enabledConfigs: () => PrinterConfig[],
    private readonly cameras: CameraService,
    private readonly events: EventFeed,
    private readonly persist: () => void = () => {},
    initialToday?: PersistedToday,
    /** Gate for the scheduled night-light policy (the `night-lights` automation). */
    nightLightsEnabled: () => boolean = () => true,
    /** Fulfillment stock client; when absent/disabled, completion deduction is skipped. */
    inventory?: InventoryConsumer,
    /** Live telemetry source; injectable so the poll loop can be tested without real devices. */
    private readonly statusProvider: (
      printer: PrinterConfig
    ) => Promise<PrinterLiveStatus> = getPrinterLiveStatus
  ) {
    this.today = new TodayCounters(initialToday);
    this.filament = new FilamentConsumption(inventory, events);
    this.lights = new LightScheduler({
      events,
      nightLightsEnabled,
      getStatus: (id) => this.statuses.get(id),
      setStatus: (id, status) => this.statuses.set(id, status)
    });
  }

  /** Runs the first poll, then starts the interval loop. */
  async start(logger: StoreLogger): Promise<void> {
    this.logger = logger;
    this.lights.useLogger(logger);
    this.filament.useLogger(logger);
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
      this.pruneStaleEntries(enabled);
      await Promise.all(
        enabled.map(async (printer) => {
          const status = await this.statusProvider(printer);
          const prev = this.statuses.get(printer.id);
          this.recordTransition(printer, prev, status);
          // Credit the interval since the last poll to the PREVIOUS status —
          // only time we watched the printer actually printing counts.
          this.accruePrintingTime(printer.id, prev);
          this.statuses.set(printer.id, status);
        })
      );
      await this.lights.applyPolicy(enabled);
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

  /**
   * Accrues observed printer-time toward today's "hours printing" total. Called
   * once per printer per poll with that printer's PREVIOUS status: the interval
   * since the last poll is attributed to the state we last observed (a left
   * Riemann sum), so only intervals that began while the printer was actually
   * printing and online are counted.
   *
   * `printing` already subsumes heating/preparing — the status mapper folds
   * those device states into `printing` (see toStatusState) — so they need no
   * special case here. `paused`, `offline`/`unknown` and every reconnect edge
   * contribute nothing, so a long pause or a dropped connection cannot inflate
   * the metric.
   *
   * The first interval after a (re)start has no recorded anchor and is skipped —
   * we only count time we actually watched, never reconstructing the past from
   * remainingMinutes. Day-boundary clipping and the max-interval cap live in
   * {@link TodayCounters.creditPrintingInterval}.
   */
  private accruePrintingTime(id: string, prev: PrinterLiveStatus | undefined): void {
    const now = Date.now();
    const prevAt = this.lastAccrualAt.get(id);
    // Advance the anchor even when this interval is not credited, so the next
    // interval measures from now — e.g. an offline stretch is dropped rather
    // than folded into the reconnect interval.
    this.lastAccrualAt.set(id, now);

    if (prevAt === undefined) return;
    if (!prev || !prev.online || prev.status !== "printing") return;

    const credited = this.today.creditPrintingInterval(prevAt, now);
    if (credited <= 0) return;

    // Checkpoint at most once per HOURS_PERSIST_INTERVAL_MS while printing.
    if (now - this.lastHoursPersistAt >= HOURS_PERSIST_INTERVAL_MS) {
      this.lastHoursPersistAt = now;
      this.persist();
    }
  }

  /**
   * Drops per-printer map entries for printers no longer in the enabled config
   * (removed or disabled via a config change), so the maps do not grow without
   * bound. There is no live config reload today, but this keeps the state honest
   * if the enabled set ever shrinks at runtime.
   */
  private pruneStaleEntries(enabled: PrinterConfig[]): void {
    const live = new Set(enabled.map((printer) => printer.id));
    const maps: Map<string, unknown>[] = [
      this.statuses,
      this.changedAt,
      this.lastAccrualAt,
      this.printRuns
    ];
    for (const map of maps) {
      for (const id of map.keys()) {
        if (!live.has(id)) map.delete(id);
      }
    }
    this.lights.prune(live);
  }

  // ── Transition tracking (real events only) ──────────────────────────────

  private recordTransition(
    printer: PrinterConfig,
    prev: PrinterLiveStatus | undefined,
    next: PrinterLiveStatus
  ): void {
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
      // Reconnect is a fresh baseline: announce it, but never derive a print
      // start/completion from the offline→online edge. While offline prev.status
      // is "offline", so falling through would mis-read a still-running job as a
      // brand-new print — a false "started printing" event and a needlessly
      // re-minted run id mid-print. The next poll compares two online states and
      // reports the real transitions.
      this.events.push("↺", `${name} снова на связи`, "ok");
      return;
    }

    if (next.status === "error" && prev.status !== "error") {
      this.today.recordFailed();
      this.persist();
      this.events.push("⚠", `${name}: ${next.error ?? "ошибка печати"}`, "err");
      return;
    }
    if (next.status === "printing" && prev.status !== "printing" && prev.status !== "paused") {
      // New print run: mint a stable identity used as the idempotency key on
      // finish, and snapshot the AMS trays so Bambu can diff `remain` at
      // completion. A print already running before the orchestrator started has
      // no snapshot (in-memory only), so its Bambu consumption is skipped.
      this.printRuns.set(printer.id, {
        printId: randomUUID(),
        file: job,
        startedAtMs: Date.now(),
        amsStart: next.amsTrays
      });
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
      // The run is over however it ended: take the identity, then clear it.
      const run = this.printRuns.get(printer.id);
      this.printRuns.delete(printer.id);

      if (looksCancelled(next)) {
        this.events.push("✕", `Печать${job ? ` «${job}»` : ""} на ${name} отменена`, "info");
        return;
      }
      if (looksComplete(next)) {
        // Fold this run into today's counters — the duration only when we saw
        // it start (run present with a startedAtMs). Pauses are intentionally
        // included: startedAtMs..now spans the whole job, matching "how long
        // the printer was occupied".
        this.today.recordCompleted(run ? Date.now() - run.startedAtMs : null);
        this.persist();
        this.filament.consumeForPrint(printer, prev, next, run, job);
        this.events.push("✔", `${name} завершил печать${job ? ` «${job}»` : ""}`, "ok");
        return;
      }
      this.events.push("◌", `${name} перешёл в режим ожидания`, "info");
    }
  }
}
