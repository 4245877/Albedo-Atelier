/**
 * Timezone-aware night-window arithmetic.
 *
 * Two things the old full-window check got wrong and this module fixes:
 *
 *  1. **Remaining, not total.** A print may only start when its buffered ETA fits
 *     the time left *until the window closes*, not the window's nominal length.
 *     At 06:00 in a 21:30–07:30 window there are 90 minutes left, not 600.
 *  2. **Explicit farm timezone.** Every stored timestamp stays UTC; the local
 *     wall-clock the window is expressed in is resolved through an IANA zone
 *     (`FARM_TIMEZONE`) rather than whatever `TZ` the container happens to carry.
 *
 * Everything here is pure and fail-closed: an unparseable window or an unknown
 * timezone yields `null`, and callers must treat `null` as "cannot verify" —
 * never as "fits".
 */

import { parseLocalTimeWindow } from "../../shared/time";

const MINUTES_PER_DAY = 24 * 60;

export interface NightWindowFit {
  /** Minutes left until the window's end from `now` (0 when outside the window). */
  remainingMinutes: number;
  /** Whether `now` is inside the window at all. */
  insideWindow: boolean;
  /** The ETA after the safety buffer, in minutes. */
  bufferedEtaMinutes: number;
  /** True only when the buffered ETA fits into `remainingMinutes`. */
  fits: boolean;
  /** Window bounds as local minutes-since-midnight, for evidence/UI. */
  startMinutes: number;
  endMinutes: number;
  /** Local minutes-since-midnight of `now` in the farm timezone. */
  nowMinutes: number;
}

/**
 * Minutes since local midnight for `date` in `timeZone`. Returns `null` when the
 * zone is not a valid IANA identifier — the caller then fails closed instead of
 * silently falling back to the process timezone (which is how a farm in UTC+3
 * would evaluate its night window against UTC and start a print at the wrong hour).
 */
export function localMinutesInZone(date: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    if (hour === undefined || minute === undefined) return null;
    const h = Number(hour);
    const m = Number(minute);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
    return h * 60 + m;
  } catch {
    return null;
  }
}

/** The local calendar date (`YYYY-MM-DD`) of `date` in `timeZone`; null on a bad zone. */
export function localDateInZone(date: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    return y && m && d ? `${y}-${m}-${d}` : null;
  } catch {
    return null;
  }
}

/** Total length of a `"HH:MM – HH:MM"` window in minutes, wrapping midnight; null when unparseable. */
export function windowLengthMinutes(window: string): number | null {
  const parsed = parseLocalTimeWindow(window);
  if (!parsed) return null;
  const { startMinutes, endMinutes } = parsed;
  if (startMinutes === endMinutes) return MINUTES_PER_DAY;
  return startMinutes < endMinutes
    ? endMinutes - startMinutes
    : MINUTES_PER_DAY - startMinutes + endMinutes;
}

/**
 * Minutes remaining until the window closes, evaluated at the farm's local wall
 * clock. Handles a window that wraps past midnight (21:30–07:30): at 02:00 the
 * answer is 330, at 22:00 it is 570. Outside the window the answer is 0 — the
 * time until the *next* opening is deliberately not returned, because a start
 * that must wait is not a start that fits.
 *
 * Returns `null` when the window cannot be parsed or the timezone is invalid.
 */
export function remainingWindowMinutes(
  window: string,
  now: Date,
  timeZone: string
): number | null {
  const parsed = parseLocalTimeWindow(window);
  if (!parsed) return null;
  const nowMinutes = localMinutesInZone(now, timeZone);
  if (nowMinutes === null) return null;

  const { startMinutes, endMinutes } = parsed;
  // A zero-length window means "all day"; there is always a full day ahead.
  if (startMinutes === endMinutes) return MINUTES_PER_DAY;

  const inside =
    startMinutes < endMinutes
      ? nowMinutes >= startMinutes && nowMinutes < endMinutes
      : nowMinutes >= startMinutes || nowMinutes < endMinutes;
  if (!inside) return 0;

  // Inside the window: distance to `end`, wrapping across midnight when needed.
  return nowMinutes < endMinutes
    ? endMinutes - nowMinutes
    : MINUTES_PER_DAY - nowMinutes + endMinutes;
}

/**
 * Whether a print of `etaMinutes` fits the time left in the window once the
 * safety buffer is applied.
 *
 * The buffer is a **fraction**: `0.2` → +20% → `eta × 1.2`. It is never a bare
 * multiplier and never absolute minutes (see `NIGHT_ETA_SAFETY_BUFFER`). A
 * negative or non-finite ratio collapses to no buffer rather than shrinking the
 * ETA — a buffer may only ever make the check stricter.
 *
 * Returns `null` when the window/timezone cannot be resolved, so the caller
 * fails closed instead of guessing.
 */
export function evaluateNightWindowFit(input: {
  window: string;
  now: Date;
  timeZone: string;
  etaMinutes: number;
  safetyBufferRatio: number;
}): NightWindowFit | null {
  const parsed = parseLocalTimeWindow(input.window);
  if (!parsed) return null;
  const nowMinutes = localMinutesInZone(input.now, input.timeZone);
  if (nowMinutes === null) return null;
  const remaining = remainingWindowMinutes(input.window, input.now, input.timeZone);
  if (remaining === null) return null;

  const bufferedEtaMinutes = applyBufferMinutes(input.etaMinutes, input.safetyBufferRatio);
  return {
    remainingMinutes: remaining,
    insideWindow: remaining > 0,
    bufferedEtaMinutes,
    fits: remaining > 0 && bufferedEtaMinutes <= remaining,
    startMinutes: parsed.startMinutes,
    endMinutes: parsed.endMinutes,
    nowMinutes
  };
}

/** ETA + safety buffer, in minutes, rounded up (a partial minute still needs the minute). */
export function applyBufferMinutes(etaMinutes: number, safetyBufferRatio: number): number {
  const ratio = Number.isFinite(safetyBufferRatio) ? Math.max(0, safetyBufferRatio) : 0;
  return Math.ceil(etaMinutes * (1 + ratio));
}
