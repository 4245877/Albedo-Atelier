import type { LightControlView, LightPolicyReason } from "../domain/dashboard/types";
import type { PrinterConfig } from "../infra/printers/config";
import {
  sendPrinterLight,
  supportsPrinterLight,
  type PrinterLiveStatus
} from "../infra/printers/status";
import { KeyedMutex } from "../shared/keyedMutex";
import type { StoreLogger } from "../shared/logger";
import type { EventFeed } from "./eventFeed";
import { isBusyStatus } from "./printerView";
import { SolarLightPolicy } from "./solarLightPolicy";

const MANUAL_LIGHT_OVERRIDE_MS = 5 * 60 * 1000;
/** After this many consecutive ineffective/errored light commands, pause retries. */
const MAX_LIGHT_ATTEMPTS = 3;
/** How long the schedule stops retrying a light that will not converge. */
const LIGHT_BACKOFF_MS = 5 * 60 * 1000;

/** The scheduled decision for one printer on one evaluation. */
export interface LightDecision {
  /** What the automation wants; null — it deliberately does not act. */
  desired: boolean | null;
  reason: LightPolicyReason;
  nextTransitionAt: Date | null;
  usingFallback: boolean;
}

/** Feed wording per decision reason (the decision, not the command outcome). */
const REASON_FEED_TEXT: Partial<Record<LightPolicyReason, string>> = {
  monitoring_lease: "открыта панель мониторинга",
  solar_dark_active_print: "темно, принтер печатает",
  solar_dark: "тёмное время суток",
  solar_daylight: "дневное время",
  printer_inactive: "принтер неактивен",
  fallback_window: "резервное расписание",
  fixed_window: "окно расписания",
  dark_unknown_safe_on: "нет расчёта темноты, идёт печать"
};

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
  /** Darkness schedule; injectable for tests, defaults to the env-configured one. */
  solarPolicy?: SolarLightPolicy;
  /** The farm-wide "operator is watching" lease; absent → never active. */
  monitoringLease?: { isActive(): boolean; expiresAt(): Date | null };
}

/**
 * Printer chamber-light control: the scheduled policy (dark per
 * {@link SolarLightPolicy} + activity + the monitoring lease), operator
 * overrides, and the plumbing that keeps the two honest — per-printer command
 * serialization, convergence tracking with backoff, and failure de-duplication
 * in the feed.
 *
 * Decision priority per printer, top wins:
 *   manual override → automation disabled → monitoring lease →
 *   dark & printing/paused → otherwise off.
 */
export class LightScheduler {
  private logger: StoreLogger = {};
  /** Darkness schedule (solar or fixed window); owns its own warnings dedupe. */
  private readonly policy: SolarLightPolicy;
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
  private readonly chain = new KeyedMutex();

  private readonly sendLight: (printer: PrinterConfig, on: boolean) => Promise<void>;

  constructor(private readonly deps: LightSchedulerDeps) {
    this.sendLight = deps.sendLight ?? sendPrinterLight;
    this.policy =
      deps.solarPolicy ??
      new SolarLightPolicy(undefined, {
        onWarning: (message) => this.notePolicyDegraded(message)
      });
  }

  /** A degraded/invalid light schedule: once per distinct problem, feed + log. */
  private notePolicyDegraded(message: string): void {
    this.deps.events.push("☾", `Подсветка: ${message}`, "err");
    this.logger.warn?.({ message }, "light schedule degraded");
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
      this.backoffUntil
    ];
    for (const map of maps) {
      for (const id of map.keys()) {
        if (!live.has(id)) map.delete(id);
      }
    }
    this.chain.prune(live);
  }

  /**
   * Serializes a light operation for one printer behind any in-flight one, so
   * manual and scheduled commands run strictly one after another. Failures do
   * not break the chain: the next task still runs.
   */
  private runExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    return this.chain.run(id, task);
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
    // Only a *provably* dark scene needs a lit snapshot; unknown darkness stays
    // conservative here (the periodic policy handles the safe-on for prints).
    if (this.policy.assess().dark !== true) return false;
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
   * The scheduled decision for one printer, in strict priority order (see the
   * class doc). Pure — no commands are sent; `applyPolicy` acts on it and the
   * dashboard read model shows the very same verdict via {@link lightState}.
   */
  evaluate(printer: PrinterConfig, now: Date = new Date()): LightDecision {
    if (!supportsPrinterLight(printer)) {
      return { desired: null, reason: "unsupported", nextTransitionAt: null, usingFallback: false };
    }
    if (!this.deps.nightLightsEnabled()) {
      return {
        desired: null,
        reason: "automation_disabled",
        nextTransitionAt: null,
        usingFallback: false
      };
    }
    if (this.isManualOverrideActive(printer.id)) {
      const until = this.manualOverrides.get(printer.id);
      return {
        // Under an override the operator's choice is the desired state; the
        // last requested target is what they asked for.
        desired: this.lightTargets.get(printer.id) ?? this.deps.getStatus(printer.id)?.light ?? null,
        reason: "manual_override",
        nextTransitionAt: until ? new Date(until) : null,
        usingFallback: false
      };
    }

    const lease = this.deps.monitoringLease;
    if (lease?.isActive()) {
      return {
        desired: true,
        reason: "monitoring_lease",
        nextTransitionAt: lease.expiresAt(),
        usingFallback: false
      };
    }

    const status = this.deps.getStatus(printer.id);
    const active = status ? isBusyStatus(status.status) : false;
    const darkness = this.policy.assess(now);

    if (darkness.dark === null) {
      // Darkness cannot be determined at all (bad solar config AND bad fallback
      // window). Safe default: keep an actively printing printer lit, leave
      // idle ones dark.
      if (active) {
        return {
          desired: true,
          reason: "dark_unknown_safe_on",
          nextTransitionAt: null,
          usingFallback: true
        };
      }
      return {
        desired: false,
        reason: "printer_inactive",
        nextTransitionAt: null,
        usingFallback: true
      };
    }

    const windowReason: LightPolicyReason =
      darkness.source === "fixed" ? "fixed_window" : "fallback_window";

    if (!darkness.dark) {
      return {
        desired: false,
        reason: darkness.source === "solar" ? "solar_daylight" : windowReason,
        nextTransitionAt: darkness.nextTransitionAt,
        usingFallback: darkness.usingFallback
      };
    }

    if (this.policy.onlyWhenActive && !active) {
      return {
        desired: false,
        reason: "printer_inactive",
        nextTransitionAt: darkness.nextTransitionAt,
        usingFallback: darkness.usingFallback
      };
    }

    return {
      desired: true,
      reason:
        darkness.source === "solar"
          ? active
            ? "solar_dark_active_print"
            : "solar_dark"
          : windowReason,
      nextTransitionAt: darkness.nextTransitionAt,
      usingFallback: darkness.usingFallback
    };
  }

  /** The dashboard projection of the decision plus the known physical state. */
  lightState(printer: PrinterConfig): Omit<LightControlView, "id"> {
    const decision = this.evaluate(printer);
    return {
      supported: supportsPrinterLight(printer),
      desired: decision.desired,
      actual: this.deps.getStatus(printer.id)?.light ?? null,
      reason: decision.reason,
      nextTransitionAt: decision.nextTransitionAt?.toISOString() ?? null,
      usingFallback: decision.usingFallback
    };
  }

  /** Whether the darkness schedule is currently degraded to the fallback window. */
  isUsingFallback(): boolean {
    return this.policy.assess().usingFallback;
  }

  /**
   * Applies the scheduled policy to every supported printer, one decision per
   * printer per poll. When the automation is off, leaves the lights entirely
   * under manual/device control — the schedule must not touch them.
   */
  async applyPolicy(printers: PrinterConfig[]): Promise<void> {
    if (!this.deps.nightLightsEnabled()) return;
    await Promise.all(
      printers.map((printer) => {
        const decision = this.evaluate(printer);
        // desired === null → hands off (unsupported printer or manual override).
        if (decision.desired === null) return undefined;
        return this.applyPolicyToPrinter(printer, decision.desired, decision.reason);
      })
    );
  }

  private async applyPolicyToPrinter(
    printer: PrinterConfig,
    targetOn: boolean,
    reason: LightPolicyReason
  ): Promise<void> {
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
          const detail = REASON_FEED_TEXT[reason];
          this.deps.events.push(
            targetOn ? "☾" : "☀",
            `<b>${printer.name}</b>: подсветка ${targetOn ? "включена" : "выключена"}${detail ? ` — ${detail}` : ""}`,
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
