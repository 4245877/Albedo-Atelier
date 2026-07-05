import { randomUUID } from "node:crypto";

import { env } from "../../shared/env";
import { hhmm, isWithinLocalTimeWindow, localDateKey, parseLocalTimeWindow } from "../../shared/time";
import type { PrinterConfig } from "../printers/config";
import {
  getPrinterLiveStatus,
  sendPrinterLight,
  supportsPrinterLight,
  type PrinterLiveStatus
} from "../printers/status";
import { bambuMeasurableTrayCount, bambuTrayUsage } from "../printers/status/bambuUsage";
import type { AmsTraySnapshot } from "../printers/status/types";
import type { CameraService } from "./cameraService";
import type { EventFeed } from "./eventFeed";
import type { PersistedToday } from "./stateStore";

export type StoreLogger = {
  info?: (obj: unknown, message?: string) => void;
  warn?: (obj: unknown, message?: string) => void;
  error?: (obj: unknown, message?: string) => void;
};

/**
 * The slice of the fulfillment inventory client the poller needs: deduct filament
 * for a completed print. Structural, so the poller stays decoupled and testable.
 */
export interface InventoryConsumer {
  readonly enabled: boolean;
  consume(input: {
    printerId: string;
    lengthMm?: number;
    grams?: number;
    amsTray?: number;
    material?: string;
    color?: string;
    printJobId: string;
    idempotencyKey: string;
    note?: string;
  }): Promise<unknown>;
}

/** One filament deduction derived from a completed print. */
type ConsumeItem =
  | { kind: "length"; lengthMm: number }
  | { kind: "grams"; grams: number; amsTray: number; material: string | null; color: string | null };

/** Per-printer identity of the in-flight print, for stable idempotent deduction. */
type PrintRun = {
  printId: string;
  file: string | null;
  /** AMS tray `remain` snapshot at print start (Bambu), diffed at completion. */
  amsStart: AmsTraySnapshot[] | null;
};

const COMPLETE_RE = /complete|finish|done/i;
const CANCEL_RE = /cancel|abort|stop/i;
const MANUAL_LIGHT_OVERRIDE_MS = 5 * 60 * 1000;
/** After this many consecutive ineffective/errored light commands, pause retries. */
const MAX_LIGHT_ATTEMPTS = 3;
/** How long the schedule stops retrying a light that will not converge. */
const LIGHT_BACKOFF_MS = 5 * 60 * 1000;

function looksComplete(status: PrinterLiveStatus): boolean {
  if (status.stateText && CANCEL_RE.test(status.stateText)) return false;
  if (status.stateText && COMPLETE_RE.test(status.stateText)) return true;
  return status.progressPct !== null && status.progressPct >= 99;
}

function looksCancelled(status: PrinterLiveStatus): boolean {
  return Boolean(status.stateText && CANCEL_RE.test(status.stateText));
}

function dateKey(): string {
  return localDateKey();
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
  /** Consecutive ineffective/errored scheduled light commands per printer. */
  private lightFailureCounts = new Map<string, number>();
  /** Until this timestamp the schedule stops retrying a non-converging light. */
  private lightBackoffUntil = new Map<string, number>();
  /**
   * Per-printer serialization for every light operation (manual + schedule), so
   * a manual command and a scheduled one can never interleave on the wire and a
   * stale scheduled command can never clobber a fresh manual one.
   */
  private lightChain = new Map<string, Promise<unknown>>();

  /** Completions/failures the poller itself observed today. */
  private todayKey = dateKey();
  private todayDone = 0;
  private todayFailed = 0;

  /** Per-printer identity of the in-flight print, for stable idempotent deduction. */
  private printRuns = new Map<string, PrintRun>();

  constructor(
    private readonly enabledConfigs: () => PrinterConfig[],
    private readonly cameras: CameraService,
    private readonly events: EventFeed,
    private readonly persist: () => void = () => {},
    initialToday?: PersistedToday,
    /** Gate for the scheduled night-light policy (the `night-lights` automation). */
    private readonly nightLightsEnabled: () => boolean = () => true,
    /** Fulfillment stock client; when absent/disabled, completion deduction is skipped. */
    private readonly inventory?: InventoryConsumer,
    /** Live telemetry source; injectable so the poll loop can be tested without real devices. */
    private readonly statusProvider: (
      printer: PrinterConfig
    ) => Promise<PrinterLiveStatus> = getPrinterLiveStatus
  ) {
    // Hydrate the counters from persisted state. rolloverToday() resets them on
    // the first read if the persisted day is no longer today.
    if (initialToday?.key) {
      this.todayKey = initialToday.key;
      this.todayDone = initialToday.done;
      this.todayFailed = initialToday.failed;
    }
  }

  /** The durable projection of today's counters (rolled over to the current day first). */
  serializeToday(): PersistedToday {
    this.rolloverToday();
    return { key: this.todayKey, done: this.todayDone, failed: this.todayFailed };
  }

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
      this.pruneStaleEntries(enabled);
      await Promise.all(
        enabled.map(async (printer) => {
          const status = await this.statusProvider(printer);
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

  /**
   * Serializes a light operation for one printer behind any in-flight one, so
   * manual and scheduled commands run strictly one after another. Failures do
   * not break the chain: the next task still runs.
   */
  private runLightExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = (this.lightChain.get(id) ?? Promise.resolve()).catch(() => {});
    const next = prev.then(task);
    this.lightChain.set(id, next.catch(() => {}));
    return next;
  }

  /**
   * An operator's explicit light command. Runs through the per-printer light
   * chain so it can never interleave with a scheduled command, then holds the
   * chosen state against the schedule for {@link MANUAL_LIGHT_OVERRIDE_MS}.
   * Throws the underlying driver error (mapped by the command service).
   */
  async applyManualLight(printer: PrinterConfig, on: boolean): Promise<void> {
    await this.runLightExclusive(printer.id, async () => {
      await sendPrinterLight(printer, on);
      this.lightTargets.set(printer.id, on);
      this.resetLightFailure(printer.id);
      this.manualLightOverrides.set(printer.id, Date.now() + MANUAL_LIGHT_OVERRIDE_MS);

      const status = this.statuses.get(printer.id);
      if (status) {
        this.statuses.set(printer.id, {
          ...status,
          light: on,
          updatedAt: new Date().toISOString()
        });
      }
    });
  }

  /**
   * Ensures the chamber light is on for an out-of-band snapshot (e.g. the night
   * Telegram photo captured by fulfillment) at the exact moment a frame is
   * grabbed — closing the gap the periodic policy leaves when a printer auto-off
   * its light on FINISH and the next poll has not re-enabled it yet. Returns
   * true only when it actually switched the light on, so the caller can let it
   * settle before capturing.
   *
   * Only acts when the night-light schedule itself would want the light on (the
   * automation is enabled and we are inside the night window): a daytime frame
   * is meant to be unlit, and a disabled automation means "hands off the lights".
   *
   * Deliberately does NOT install a manual override and never turns the light
   * back off: the steady state stays owned by the night-light policy, so the two
   * systems can't flap against each other.
   */
  async ensureLightForSnapshot(printer: PrinterConfig): Promise<boolean> {
    if (!supportsPrinterLight(printer)) return false;
    if (!this.nightLightsEnabled()) return false;
    if (!this.currentNightLightTarget()) return false;
    if (this.isManualLightOverrideActive(printer.id)) return false;

    const status = this.statuses.get(printer.id);
    if (!status?.online || status.light === true) return false;

    return this.runLightExclusive(printer.id, async () => {
      // Re-check under the lock: a manual command or a fresh poll may have just
      // taken over / already turned the light on.
      if (this.isManualLightOverrideActive(printer.id)) return false;
      const fresh = this.statuses.get(printer.id);
      if (!fresh?.online || fresh.light === true) return false;

      try {
        await sendPrinterLight(printer, true);
        this.lightTargets.set(printer.id, true);
        if (fresh.light !== null) {
          this.statuses.set(printer.id, {
            ...fresh,
            light: true,
            updatedAt: new Date().toISOString()
          });
        }
        return true;
      } catch (error) {
        this.logger.warn?.(
          { err: error, printer: printer.id },
          "ensure light for snapshot failed"
        );
        return false;
      }
    });
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
      this.printRuns,
      this.lightTargets,
      this.manualLightOverrides,
      this.lightFailureKeys,
      this.lightFailureCounts,
      this.lightBackoffUntil,
      this.lightChain
    ];
    for (const map of maps) {
      for (const id of map.keys()) {
        if (!live.has(id)) map.delete(id);
      }
    }
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
    // When the automation is off, leave the lights entirely under manual/device
    // control — the schedule must not touch them.
    if (!this.nightLightsEnabled()) return;
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
      // Converged to the scheduled target: clear the target and any failure/backoff bookkeeping.
      this.lightTargets.set(printer.id, targetOn);
      this.resetLightFailure(printer.id);
      return;
    }
    // State unknown and we already asked for this target — nothing new to do.
    if (current === null && lastTarget === targetOn) return;
    // The light keeps ignoring us: back off instead of spamming SET_PIN every tick.
    if (this.isLightBackoffActive(printer.id)) return;

    await this.runLightExclusive(printer.id, async () => {
      // Re-check under the lock: a manual command may have just taken over.
      if (this.isManualLightOverrideActive(printer.id)) return;

      const fresh = this.statuses.get(printer.id);
      if (!fresh?.online) return;
      if (fresh.light === targetOn) {
        this.resetLightFailure(printer.id);
        return;
      }

      // Announce only when the target itself changed (day↔night), not on every
      // retry of a light that has not physically converged yet.
      const announce = lastTarget !== targetOn;

      try {
        await sendPrinterLight(printer, targetOn);
        this.lightTargets.set(printer.id, targetOn);

        if (fresh.light !== null) {
          this.statuses.set(printer.id, {
            ...fresh,
            light: targetOn,
            updatedAt: new Date().toISOString()
          });
        }

        if (announce) {
          this.events.push(
            targetOn ? "☾" : "☀",
            `<b>${printer.name}</b>: подсветка ${targetOn ? "включена на ночь" : "выключена на день"}`,
            "info"
          );
        }

        // The command was accepted; whether the pin actually moved is confirmed
        // on the next poll (fresh.light === targetOn → resetLightFailure above).
        this.noteLightNotConverging(printer, targetOn);
      } catch (error) {
        this.noteLightPolicyError(printer, targetOn, error);
      }
    });
  }

  /**
   * Counts a scheduled command that was sent but has not (yet) moved the pin. If
   * it keeps happening the pin is almost certainly misconfigured, so back off and
   * warn once instead of resending forever. Reset on convergence or manual command.
   */
  private noteLightNotConverging(printer: PrinterConfig, targetOn: boolean): void {
    const attempts = (this.lightFailureCounts.get(printer.id) ?? 0) + 1;
    if (attempts >= MAX_LIGHT_ATTEMPTS) {
      this.lightFailureCounts.set(printer.id, 0);
      this.lightBackoffUntil.set(printer.id, Date.now() + LIGHT_BACKOFF_MS);
      this.warnLightNotConverging(printer, targetOn);
    } else {
      this.lightFailureCounts.set(printer.id, attempts);
    }
  }

  private warnLightNotConverging(printer: PrinterConfig, targetOn: boolean): void {
    const failureKey = `converge:${targetOn}`;
    if (this.lightFailureKeys.get(printer.id) === failureKey) return;
    this.lightFailureKeys.set(printer.id, failureKey);
    this.events.push(
      "⚠",
      `<b>${printer.name}</b>: подсветка не переключается (${targetOn ? "вкл" : "выкл"}) — проверьте пин «${printer.light.pin || "?"}» в printer.cfg (output_pin) на устройстве`,
      "err"
    );
    // Cannot verify the physical wiring from here — surface the pin so an
    // operator can confirm `output_pin <pin>` in Klipper matches the K2 light.
    this.logger.warn?.(
      {
        printer: printer.id,
        targetOn,
        pin: printer.light.pin,
        statusObject: printer.light.statusObject
      },
      "printer light not converging to target; verify Klipper output_pin config"
    );
  }

  private noteLightPolicyError(printer: PrinterConfig, targetOn: boolean, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const failureKey = `err:${targetOn}:${message}`;
    if (this.lightFailureKeys.get(printer.id) !== failureKey) {
      this.lightFailureKeys.set(printer.id, failureKey);
      this.events.push(
        "⚠",
        `<b>${printer.name}</b>: не удалось ${targetOn ? "включить" : "выключить"} подсветку (${message})`,
        "err"
      );
    }
    const attempts = (this.lightFailureCounts.get(printer.id) ?? 0) + 1;
    if (attempts >= MAX_LIGHT_ATTEMPTS) {
      this.lightFailureCounts.set(printer.id, 0);
      this.lightBackoffUntil.set(printer.id, Date.now() + LIGHT_BACKOFF_MS);
    } else {
      this.lightFailureCounts.set(printer.id, attempts);
    }
    this.logger.warn?.({ err: error, printer: printer.id, targetOn }, "night light policy failed");
  }

  private resetLightFailure(id: string): void {
    this.lightFailureKeys.delete(id);
    this.lightFailureCounts.delete(id);
    this.lightBackoffUntil.delete(id);
  }

  private isLightBackoffActive(id: string): boolean {
    const until = this.lightBackoffUntil.get(id);
    if (!until) return false;
    if (until > Date.now()) return true;
    this.lightBackoffUntil.delete(id);
    return false;
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
      this.todayFailed += 1;
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
        this.todayDone += 1;
        this.persist();
        this.consumeFilamentForPrint(printer, prev, next, run, job);
        this.events.push("✔", `${name} завершил печать${job ? ` «${job}»` : ""}`, "ok");
        return;
      }
      this.events.push("◌", `${name} перешёл в режим ожидания`, "info");
    }
  }

  /**
   * Turns one completed print into zero or more filament deductions. Moonraker
   * reports a single extruded length for the loaded reel; Bambu attributes grams
   * per AMS tray from the drop in each tray's `remain` between the start snapshot
   * and completion ({@link bambuTrayUsage}), so multi-slot prints deduct from
   * every slot they used. An empty list means the device gave nothing to deduct.
   */
  private buildConsumeItems(
    printer: PrinterConfig,
    prev: PrinterLiveStatus,
    next: PrinterLiveStatus,
    run: PrintRun | undefined
  ): ConsumeItem[] {
    if (printer.protocol === "bambu") {
      const endTrays = next.amsTrays ?? prev.amsTrays;
      return bambuTrayUsage(run?.amsStart ?? null, endTrays).map((usage) => ({
        kind: "grams",
        grams: usage.grams,
        amsTray: usage.tray,
        material: usage.material,
        color: usage.color
      }));
    }

    const usedMm = next.filamentUsedMm ?? prev.filamentUsedMm;
    return usedMm && usedMm > 0 ? [{ kind: "length", lengthMm: usedMm }] : [];
  }

  /**
   * Fire-and-forget filament deduction for a completed print. Never throws into
   * the poll loop: a missing/disabled client is a no-op, and any failure
   * (fulfillment down, no loaded filament, not enough stock) is logged and
   * surfaced as a soft warning. Idempotent per print — and per AMS tray — via a
   * stable `idempotencyKey`, so a re-observed completion or a retry never
   * double-deducts.
   *
   * When the print completed but the device gave no usable consumption data —
   * Bambu with uncalibrated AMS trays (`remain = -1`) or a missing start
   * snapshot — nothing is deducted (we never invent grams). For Bambu that gap
   * is surfaced as one soft warning so the operator knows stock was untouched;
   * Moonraker without a reported length stays silent, exactly as before.
   */
  private consumeFilamentForPrint(
    printer: PrinterConfig,
    prev: PrinterLiveStatus,
    next: PrinterLiveStatus,
    run: PrintRun | undefined,
    job: string | null
  ): void {
    if (!this.inventory?.enabled) return;

    const items = this.buildConsumeItems(printer, prev, next, run);
    if (items.length === 0) {
      // Warn only when the device gave us nothing to measure (uncalibrated trays
      // or a missing start snapshot) — not when it measured a print too small to
      // move the 1 % `remain`, which is a legitimate ~0 g no-op.
      const endTrays = next.amsTrays ?? prev.amsTrays;
      if (printer.protocol === "bambu" && bambuMeasurableTrayCount(run?.amsStart ?? null, endTrays) === 0) {
        this.events.push(
          "⚠",
          `<b>${printer.name}</b>: склад — нет данных о расходе филамента${job ? ` для «${job}»` : ""}, списание пропущено`,
          "err"
        );
      }
      return;
    }

    const printJobId = run?.printId ?? `${printer.id}:${dateKey()}:${job ?? "?"}`;
    for (const item of items) {
      this.dispatchConsumeItem(printer, item, printJobId, job);
    }
  }

  private dispatchConsumeItem(
    printer: PrinterConfig,
    item: ConsumeItem,
    printJobId: string,
    job: string | null
  ): void {
    const note = job ? `Печать «${job}»` : undefined;
    const input =
      item.kind === "length"
        ? {
            printerId: printer.id,
            lengthMm: item.lengthMm,
            printJobId,
            idempotencyKey: `${printer.id}:${printJobId}`,
            note
          }
        : {
            printerId: printer.id,
            grams: item.grams,
            amsTray: item.amsTray,
            material: item.material ?? undefined,
            color: item.color ?? undefined,
            printJobId,
            idempotencyKey: `${printer.id}:${printJobId}:t${item.amsTray}`,
            note
          };

    void this.inventory!.consume(input).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn?.({ err: error, printer: printer.id }, "filament consume failed");
      this.events.push("⚠", `<b>${printer.name}</b>: склад — ${message}`, "err");
    });
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
