import type { PrinterConfig } from "../infra/printers/config";
import {
  sendPrinterLight,
  supportsPrinterLight,
  type PrinterLiveStatus
} from "../infra/printers/status";
import { env } from "../shared/env";
import type { StoreLogger } from "../shared/logger";
import { isWithinLocalTimeWindow, parseLocalTimeWindow } from "../shared/time";
import type { EventFeed } from "./eventFeed";

const MANUAL_LIGHT_OVERRIDE_MS = 5 * 60 * 1000;
/** After this many consecutive ineffective/errored light commands, pause retries. */
const MAX_LIGHT_ATTEMPTS = 3;
/** How long the schedule stops retrying a light that will not converge. */
const LIGHT_BACKOFF_MS = 5 * 60 * 1000;

/**
 * What the scheduler needs from the rest of the farm. Live statuses are read
 * and patched through accessors (the poller owns the status map), so the two
 * components stay decoupled and the scheduler is unit-testable with plain maps.
 */
export interface LightSchedulerDeps {
  events: EventFeed;
  /** Gate for the scheduled night-light policy (the `night-lights` automation). */
  nightLightsEnabled: () => boolean;
  getStatus: (id: string) => PrinterLiveStatus | undefined;
  setStatus: (id: string, status: PrinterLiveStatus) => void;
  /** Driver dispatch; injectable so unit tests need no device or fake fetch. */
  sendLight?: (printer: PrinterConfig, on: boolean) => Promise<void>;
}

/**
 * Printer chamber-light control: the scheduled night policy (on inside
 * `NIGHT_PRINT_WINDOW`, off outside), operator overrides, and the plumbing that
 * keeps the two honest — per-printer command serialization, convergence
 * tracking with backoff, and failure de-duplication in the feed.
 */
export class LightScheduler {
  private logger: StoreLogger = {};
  private warnedInvalidNightWindow = false;
  /** Last light target successfully requested per printer. */
  private lightTargets = new Map<string, boolean>();
  /** Until this timestamp, scheduled light policy must not override manual changes. */
  private manualOverrides = new Map<string, number>();
  /** Last light policy failure signature per printer, used to avoid feed spam. */
  private failureKeys = new Map<string, string>();
  /** Consecutive ineffective/errored scheduled light commands per printer. */
  private failureCounts = new Map<string, number>();
  /** Until this timestamp the schedule stops retrying a non-converging light. */
  private backoffUntil = new Map<string, number>();
  /**
   * Per-printer serialization for every light operation (manual + schedule), so
   * a manual command and a scheduled one can never interleave on the wire and a
   * stale scheduled command can never clobber a fresh manual one.
   */
  private chain = new Map<string, Promise<unknown>>();

  private readonly sendLight: (printer: PrinterConfig, on: boolean) => Promise<void>;

  constructor(private readonly deps: LightSchedulerDeps) {
    this.sendLight = deps.sendLight ?? sendPrinterLight;
  }

  useLogger(logger: StoreLogger): void {
    this.logger = logger;
  }

  /** Drops per-printer bookkeeping for printers no longer in the enabled set. */
  prune(live: Set<string>): void {
    const maps: Map<string, unknown>[] = [
      this.lightTargets,
      this.manualOverrides,
      this.failureKeys,
      this.failureCounts,
      this.backoffUntil,
      this.chain
    ];
    for (const map of maps) {
      for (const id of map.keys()) {
        if (!live.has(id)) map.delete(id);
      }
    }
  }

  /**
   * Serializes a light operation for one printer behind any in-flight one, so
   * manual and scheduled commands run strictly one after another. Failures do
   * not break the chain: the next task still runs.
   */
  private runExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = (this.chain.get(id) ?? Promise.resolve()).catch(() => {});
    const next = prev.then(task);
    this.chain.set(id, next.catch(() => {}));
    return next;
  }

  /**
   * An operator's explicit light command. Runs through the per-printer light
   * chain so it can never interleave with a scheduled command, then holds the
   * chosen state against the schedule for {@link MANUAL_LIGHT_OVERRIDE_MS}.
   * Throws the underlying driver error (mapped by the command service).
   */
  async applyManual(printer: PrinterConfig, on: boolean): Promise<void> {
    await this.runExclusive(printer.id, async () => {
      await this.sendLight(printer, on);
      this.lightTargets.set(printer.id, on);
      this.resetFailure(printer.id);
      this.manualOverrides.set(printer.id, Date.now() + MANUAL_LIGHT_OVERRIDE_MS);

      const status = this.deps.getStatus(printer.id);
      if (status) {
        this.deps.setStatus(printer.id, {
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
  async ensureForSnapshot(printer: PrinterConfig): Promise<boolean> {
    if (!supportsPrinterLight(printer)) return false;
    if (!this.deps.nightLightsEnabled()) return false;
    if (!this.currentNightTarget()) return false;
    if (this.isManualOverrideActive(printer.id)) return false;

    const status = this.deps.getStatus(printer.id);
    if (!status?.online || status.light === true) return false;

    return this.runExclusive(printer.id, async () => {
      // Re-check under the lock: a manual command or a fresh poll may have just
      // taken over / already turned the light on.
      if (this.isManualOverrideActive(printer.id)) return false;
      const fresh = this.deps.getStatus(printer.id);
      if (!fresh?.online || fresh.light === true) return false;

      try {
        await this.sendLight(printer, true);
        this.lightTargets.set(printer.id, true);
        if (fresh.light !== null) {
          this.deps.setStatus(printer.id, {
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

  /**
   * Applies the scheduled night policy to every supported printer: on inside
   * the night window, off outside it. When the automation is off, leaves the
   * lights entirely under manual/device control — the schedule must not touch
   * them. Called once per poll with the current enabled set.
   */
  async applyPolicy(printers: PrinterConfig[]): Promise<void> {
    if (!this.deps.nightLightsEnabled()) return;
    const targetOn = this.currentNightTarget();
    await Promise.all(printers.map((printer) => this.applyPolicyToPrinter(printer, targetOn)));
  }

  private currentNightTarget(): boolean {
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

  private async applyPolicyToPrinter(printer: PrinterConfig, targetOn: boolean): Promise<void> {
    if (!supportsPrinterLight(printer)) return;
    if (this.isManualOverrideActive(printer.id)) return;

    const status = this.deps.getStatus(printer.id);
    if (!status?.online) return;

    const current = status.light;
    const lastTarget = this.lightTargets.get(printer.id);
    if (current === targetOn) {
      // Converged to the scheduled target: clear the target and any failure/backoff bookkeeping.
      this.lightTargets.set(printer.id, targetOn);
      this.resetFailure(printer.id);
      return;
    }
    // State unknown and we already asked for this target — nothing new to do.
    if (current === null && lastTarget === targetOn) return;
    // The light keeps ignoring us: back off instead of spamming SET_PIN every tick.
    if (this.isBackoffActive(printer.id)) return;

    await this.runExclusive(printer.id, async () => {
      // Re-check under the lock: a manual command may have just taken over.
      if (this.isManualOverrideActive(printer.id)) return;

      const fresh = this.deps.getStatus(printer.id);
      if (!fresh?.online) return;
      if (fresh.light === targetOn) {
        this.resetFailure(printer.id);
        return;
      }

      // Announce only when the target itself changed (day↔night), not on every
      // retry of a light that has not physically converged yet.
      const announce = lastTarget !== targetOn;

      try {
        await this.sendLight(printer, targetOn);
        this.lightTargets.set(printer.id, targetOn);

        if (fresh.light !== null) {
          this.deps.setStatus(printer.id, {
            ...fresh,
            light: targetOn,
            updatedAt: new Date().toISOString()
          });
        }

        if (announce) {
          this.deps.events.push(
            targetOn ? "☾" : "☀",
            `<b>${printer.name}</b>: подсветка ${targetOn ? "включена на ночь" : "выключена на день"}`,
            "info"
          );
        }

        // The command was accepted; whether the pin actually moved is confirmed
        // on the next poll (fresh.light === targetOn → resetFailure above).
        this.noteNotConverging(printer, targetOn);
      } catch (error) {
        this.notePolicyError(printer, targetOn, error);
      }
    });
  }

  /**
   * Counts a scheduled command that was sent but has not (yet) moved the pin. If
   * it keeps happening the pin is almost certainly misconfigured, so back off and
   * warn once instead of resending forever. Reset on convergence or manual command.
   */
  private noteNotConverging(printer: PrinterConfig, targetOn: boolean): void {
    const attempts = (this.failureCounts.get(printer.id) ?? 0) + 1;
    if (attempts >= MAX_LIGHT_ATTEMPTS) {
      this.failureCounts.set(printer.id, 0);
      this.backoffUntil.set(printer.id, Date.now() + LIGHT_BACKOFF_MS);
      this.warnNotConverging(printer, targetOn);
    } else {
      this.failureCounts.set(printer.id, attempts);
    }
  }

  private warnNotConverging(printer: PrinterConfig, targetOn: boolean): void {
    const failureKey = `converge:${targetOn}`;
    if (this.failureKeys.get(printer.id) === failureKey) return;
    this.failureKeys.set(printer.id, failureKey);
    this.deps.events.push(
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

  private notePolicyError(printer: PrinterConfig, targetOn: boolean, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const failureKey = `err:${targetOn}:${message}`;
    if (this.failureKeys.get(printer.id) !== failureKey) {
      this.failureKeys.set(printer.id, failureKey);
      this.deps.events.push(
        "⚠",
        `<b>${printer.name}</b>: не удалось ${targetOn ? "включить" : "выключить"} подсветку (${message})`,
        "err"
      );
    }
    const attempts = (this.failureCounts.get(printer.id) ?? 0) + 1;
    if (attempts >= MAX_LIGHT_ATTEMPTS) {
      this.failureCounts.set(printer.id, 0);
      this.backoffUntil.set(printer.id, Date.now() + LIGHT_BACKOFF_MS);
    } else {
      this.failureCounts.set(printer.id, attempts);
    }
    this.logger.warn?.({ err: error, printer: printer.id, targetOn }, "night light policy failed");
  }

  private resetFailure(id: string): void {
    this.failureKeys.delete(id);
    this.failureCounts.delete(id);
    this.backoffUntil.delete(id);
  }

  private isBackoffActive(id: string): boolean {
    const until = this.backoffUntil.get(id);
    if (!until) return false;
    if (until > Date.now()) return true;
    this.backoffUntil.delete(id);
    return false;
  }

  private isManualOverrideActive(id: string): boolean {
    const until = this.manualOverrides.get(id);
    if (!until) return false;
    if (until > Date.now()) return true;
    this.manualOverrides.delete(id);
    return false;
  }
}
