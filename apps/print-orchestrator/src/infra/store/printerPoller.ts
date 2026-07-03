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
import type { PersistedToday } from "./stateStore";

export type StoreLogger = {
  info?: (obj: unknown, message?: string) => void;
  warn?: (obj: unknown, message?: string) => void;
  error?: (obj: unknown, message?: string) => void;
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

  constructor(
    private readonly enabledConfigs: () => PrinterConfig[],
    private readonly cameras: CameraService,
    private readonly events: EventFeed,
    private readonly persist: () => void = () => {},
    initialToday?: PersistedToday,
    /** Gate for the scheduled night-light policy (the `night-lights` automation). */
    private readonly nightLightsEnabled: () => boolean = () => true
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
      this.events.push("↺", `${name} снова на связи`, "ok");
      if (prev.status === "offline" && next.status === prev.status) return;
    }

    if (next.status === "error" && prev.status !== "error") {
      this.todayFailed += 1;
      this.persist();
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
        this.persist();
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
