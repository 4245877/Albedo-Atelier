import { getTimes } from "suncalc";

import { env, type LightScheduleConfig } from "../shared/env";
import {
  isWithinLocalTimeWindow,
  localDateKey,
  minutesSinceLocalMidnight,
  parseLocalTimeWindow,
  type LocalTimeWindow
} from "../shared/time";

/**
 * Local sunrise/sunset calculation for one calendar day. Injectable so tests
 * control the transitions exactly; the default wraps `suncalc` (pure math, no
 * network). `null` means the sun does not rise/set that day at that location
 * (polar day/night) — the policy then degrades to the fallback window.
 */
export type SolarCalculator = (
  localNoon: Date,
  latitude: number,
  longitude: number
) => { sunriseAt: Date | null; sunsetAt: Date | null };

function validDate(value: Date): Date | null {
  return Number.isNaN(value.getTime()) ? null : value;
}

export const suncalcCalculator: SolarCalculator = (localNoon, latitude, longitude) => {
  const times = getTimes(localNoon, latitude, longitude);
  return { sunriseAt: validDate(times.sunrise), sunsetAt: validDate(times.sunset) };
};

/** Where the current darkness verdict came from. */
export type DarknessSource = "solar" | "fallback" | "fixed" | "none";

export interface DarknessAssessment {
  /** true — dark (lights window), false — daylight, null — cannot determine. */
  dark: boolean | null;
  source: DarknessSource;
  /** True when solar mode is degraded (fallback window or no window at all). */
  usingFallback: boolean;
  /** Next boundary of the dark period, when one is known. */
  nextTransitionAt: Date | null;
}

/** The solar transitions computed for one farm-local calendar date. */
interface SolarDay {
  dateKey: string;
  /** Dark period ends: today's sunrise + off-offset. */
  lightsOffAt: Date | null;
  /** Dark period starts: today's sunset + on-offset. */
  lightsOnAt: Date | null;
  /** Tomorrow's dark-period end, for "next transition" after tonight's sunset. */
  nextLightsOffAt: Date | null;
}

export interface SolarLightPolicyDeps {
  now?: () => Date;
  calculator?: SolarCalculator;
  /** Called once per distinct problem (bad config, failed calculation). */
  onWarning?: (message: string) => void;
}

const MS_PER_MINUTE = 60 * 1000;

/**
 * Decides when it is "dark enough for chamber lights" — the schedule half of
 * the light policy, deliberately separate from `NIGHT_PRINT_WINDOW` (which
 * keeps governing night-print planning and the dashboard theme).
 *
 * In `solar` mode the transitions are computed locally (suncalc; no external
 * APIs) for the configured coordinates: dark from `sunset + onOffset` until
 * `sunrise + offOffset`, naturally crossing midnight. The pair is computed once
 * per farm-local calendar day (the process TZ, `TZ` in compose) and kept as the
 * last successfully calculated transitions; the date rollover triggers a
 * recompute. When the calculation is impossible (broken coordinates, polar
 * day/night) the policy degrades to the fixed fallback window and reports it.
 * In `fixed` mode the window itself is the schedule (no degradation semantics).
 */
export class SolarLightPolicy {
  private readonly config: LightScheduleConfig;
  private readonly now: () => Date;
  private readonly calculator: SolarCalculator;
  private readonly onWarning: (message: string) => void;

  /** Pre-parsed fallback/fixed window; null when the configured string is bad. */
  private readonly window: LocalTimeWindow | null;
  /** Last successfully calculated transitions (recomputed on date change). */
  private solarDay: SolarDay | null = null;
  /** Which local date the last (possibly failed) computation was attempted for. */
  private computedForDateKey: string | null = null;
  /** Deduplication of warnings — each distinct message reaches the feed once. */
  private readonly warned = new Set<string>();
  private configIssuesReported = false;

  constructor(config: LightScheduleConfig = env.lightSchedule, deps: SolarLightPolicyDeps = {}) {
    this.config = config;
    this.now = deps.now ?? (() => new Date());
    this.calculator = deps.calculator ?? suncalcCalculator;
    this.onWarning = deps.onWarning ?? (() => {});
    this.window = parseLocalTimeWindow(config.fallbackWindow);
  }

  get mode(): LightScheduleConfig["mode"] {
    return this.config.mode;
  }

  get onlyWhenActive(): boolean {
    return this.config.onlyWhenActive;
  }

  /**
   * The current darkness verdict. Cheap to call every poll: the solar pair is
   * cached per local calendar date, everything else is arithmetic.
   */
  assess(now: Date = this.now()): DarknessAssessment {
    this.reportConfigIssuesOnce();

    if (this.config.mode === "fixed") {
      return this.assessWindow(now, "fixed", false);
    }

    const day = this.solarTransitionsFor(now);
    if (!day || day.lightsOffAt === null || day.lightsOnAt === null) {
      this.warnOnce(
        "Солнечный расчёт подсветки недоступен — используется резервное окно " +
          `«${this.config.fallbackWindow}»`
      );
      return this.assessWindow(now, "fallback", true);
    }

    if (now < day.lightsOffAt) {
      // The tail of last night: dark until sunrise + offset.
      return { dark: true, source: "solar", usingFallback: false, nextTransitionAt: day.lightsOffAt };
    }
    if (now < day.lightsOnAt) {
      return { dark: false, source: "solar", usingFallback: false, nextTransitionAt: day.lightsOnAt };
    }
    return {
      dark: true,
      source: "solar",
      usingFallback: false,
      nextTransitionAt: day.nextLightsOffAt
    };
  }

  /** Recomputes the transitions when the farm-local calendar date changed. */
  private solarTransitionsFor(now: Date): SolarDay | null {
    if (this.config.latitude === null || this.config.longitude === null) return null;

    const dateKey = localDateKey(now);
    if (this.computedForDateKey === dateKey) return this.solarDay;
    this.computedForDateKey = dateKey;

    const noon = localNoonOf(now);
    const today = this.calculator(noon, this.config.latitude, this.config.longitude);
    const tomorrow = this.calculator(
      new Date(noon.getTime() + 24 * 60 * MS_PER_MINUTE),
      this.config.latitude,
      this.config.longitude
    );

    const lightsOffAt = offsetOrNull(today.sunriseAt, this.config.offOffsetMinutes);
    const lightsOnAt = offsetOrNull(today.sunsetAt, this.config.onOffsetMinutes);
    if (lightsOffAt === null || lightsOnAt === null) {
      // Keep the previous successful pair out of use: it belongs to another
      // date. The caller falls back to the fixed window for this day.
      this.solarDay = null;
      return null;
    }

    this.solarDay = {
      dateKey,
      lightsOffAt,
      lightsOnAt,
      nextLightsOffAt: offsetOrNull(tomorrow.sunriseAt, this.config.offOffsetMinutes)
    };
    return this.solarDay;
  }

  private assessWindow(
    now: Date,
    source: DarknessSource,
    usingFallback: boolean
  ): DarknessAssessment {
    if (!this.window) {
      this.warnOnce(
        `Окно подсветки «${this.config.fallbackWindow}» не читается — темнота не определена`
      );
      return { dark: null, source: "none", usingFallback: true, nextTransitionAt: null };
    }
    return {
      dark: isWithinLocalTimeWindow(this.window, now),
      source,
      usingFallback,
      nextTransitionAt: nextWindowBoundary(this.window, now)
    };
  }

  private reportConfigIssuesOnce(): void {
    if (this.configIssuesReported) return;
    this.configIssuesReported = true;
    for (const issue of this.config.issues) {
      this.warnOnce(issue);
    }
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.onWarning(message);
  }
}

/** Noon of `date`'s local calendar day — the safe anchor for suncalc. */
function localNoonOf(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
}

function offsetOrNull(base: Date | null, offsetMinutes: number): Date | null {
  return base === null ? null : new Date(base.getTime() + offsetMinutes * MS_PER_MINUTE);
}

/**
 * The next boundary (start or end) of a fixed local-time window after `now`,
 * as a concrete Date in the process timezone. A degenerate window
 * (`start === end`, "always dark") has no boundaries → null.
 */
function nextWindowBoundary(window: LocalTimeWindow, now: Date): Date | null {
  if (window.startMinutes === window.endMinutes) return null;
  const current = minutesSinceLocalMidnight(now);
  const candidates = [window.startMinutes, window.endMinutes];
  let bestMinutes: number | null = null;
  for (const minutes of candidates) {
    if (minutes > current && (bestMinutes === null || minutes < bestMinutes)) {
      bestMinutes = minutes;
    }
  }
  const dayOffset = bestMinutes === null ? 1 : 0;
  const minutes = bestMinutes ?? Math.min(...candidates);
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0
  );
}
