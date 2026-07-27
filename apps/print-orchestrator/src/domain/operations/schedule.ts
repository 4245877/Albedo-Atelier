/**
 * Timezone-anchored operator availability arithmetic — pure, synchronous and
 * fail-closed, in the same spirit as `domain/scheduling/nightWindow`.
 *
 * The whole module exists to answer one question honestly: **at this instant, is
 * there an operator who could walk over and do something?** Three properties
 * make that answer trustworthy:
 *
 *  1. **Wall clock, resolved through an explicit IANA zone.** Rules are stored as
 *     local minutes-since-midnight, never as instants, so "sleep 23:00–07:00"
 *     stays 23:00 local across a DST transition instead of drifting an hour
 *     twice a year. The zone comes from the operator record — never from the
 *     container's ambient `TZ`, which is UTC while the farm is not.
 *  2. **Midnight is not a boundary.** A window whose end is ≤ its start wraps
 *     into the next local day, and membership is tested against *both* today's
 *     rules and yesterday's wrapping ones. A sleep schedule that does not cross
 *     midnight would be a strange sleep schedule.
 *  3. **Unknown is never "yes".** An invalid/absent zone, an operator with no
 *     schedule at all, or a horizon with no window in it all resolve to
 *     {@link OperatorPresence UNKNOWN} / `null`, and every caller treats that as
 *     a refusal. Guessing here would mean planning a 3 a.m. intervention nobody
 *     is awake for.
 */

import { localDateInZone, localMinutesInZone } from "../scheduling/nightWindow";
import type {
  Operator,
  OperatorAbsence,
  ScheduleException,
  ScheduleRule,
  ScheduleTrack,
  Weekday
} from "./types";

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;
/** How far ahead {@link resolveAvailability} will look for the next opening. */
const LOOKAHEAD_DAYS = 14;

/**
 * What the operator is doing right now.
 *
 *  - `AVAILABLE` — awake, present, inside an availability window;
 *  - `ASLEEP`    — inside a sleep window (sleep beats availability on overlap);
 *  - `AWAY`      — inside a recorded absence;
 *  - `OFF`       — simply not scheduled now (evening, weekend, an `off` exception);
 *  - `UNKNOWN`   — the schedule cannot be resolved (no zone, no operator, bad
 *    zone). **Not a synonym for `OFF`**: `OFF` is a known "no", `UNKNOWN` is the
 *    absence of an answer, and only the latter is a fail-closed automation stop.
 */
export type OperatorPresence = "AVAILABLE" | "ASLEEP" | "AWAY" | "OFF" | "UNKNOWN";

export interface OperatorAvailability {
  presence: OperatorPresence;
  /** The operator this answer is about; null when none could be resolved. */
  operatorId: string | null;
  /**
   * The next instant an operator is available — `now` itself when they already
   * are. **Null means "not within the lookahead horizon, or unknowable"**, and a
   * null here must never be read as "soon".
   */
  nextAvailableAt: Date | null;
  /** While `AVAILABLE`: when the current window closes. Null otherwise/unknown. */
  availableUntil: Date | null;
  /** Operator-facing explanation, for the UI and the audit trail. */
  reason: string;
  /** True when every input needed for a definitive answer was present. */
  resolved: boolean;
}

/** Everything one operator's availability depends on, already loaded by the caller. */
export interface OperatorScheduleInput {
  operator: Operator;
  rules: readonly ScheduleRule[];
  exceptions: readonly ScheduleException[];
  absences: readonly OperatorAbsence[];
}

/** A resolved local window on a specific local date, as UTC instants. */
interface ResolvedWindow {
  start: Date;
  end: Date;
}

// ── Zone helpers ─────────────────────────────────────────────────────────────

/** True when `timeZone` is a usable IANA identifier. */
export function isValidTimeZone(timeZone: string | null | undefined): boolean {
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The local weekday (`0` = Sunday) of `date` in `timeZone`; null on a bad zone.
 * Derived from the formatted local calendar date rather than `getDay()`, which
 * would answer in the *process* timezone.
 */
export function localWeekdayInZone(date: Date, timeZone: string): Weekday | null {
  const local = localDateInZone(date, timeZone);
  if (!local) return null;
  return weekdayOfLocalDate(local);
}

/** `0`–`6` for a `YYYY-MM-DD` string, read as a calendar date (no zone involved). */
export function weekdayOfLocalDate(localDate: string): Weekday | null {
  const parsed = parseLocalDate(localDate);
  if (!parsed) return null;
  // Date.UTC on the bare calendar fields: a pure calendar → weekday mapping with
  // no timezone in play (the date string is already local).
  const day = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  return day as Weekday;
}

function parseLocalDate(value: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** `YYYY-MM-DD` `offsetDays` away from `localDate`, on the plain calendar. */
export function shiftLocalDate(localDate: string, offsetDays: number): string | null {
  const parsed = parseLocalDate(localDate);
  if (!parsed) return null;
  const shifted = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day) + offsetDays * 86_400_000
  );
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/**
 * The zone's UTC offset (ms) **at a given instant** — the quantity that changes
 * across a DST boundary. Obtained by formatting the instant into the zone's wall
 * clock and reading those fields back as if they were UTC; the difference is the
 * offset. Null on a bad zone.
 */
function zoneOffsetMsAt(instant: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(instant);
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second")
    );
    if (!Number.isFinite(asUtc)) return null;
    return asUtc - instant.getTime();
  } catch {
    return null;
  }
}

/**
 * The UTC instant of a local wall clock (`localDate` + minutes-since-midnight)
 * in `timeZone` — the inverse of {@link localMinutesInZone}, and the piece that
 * makes "next available at 08:00" a real timestamp.
 *
 * DST is handled by resolving the offset twice: once at a first guess and again
 * at the candidate it produces, because the offset that applies depends on the
 * instant we are still computing. The two agree everywhere except within an hour
 * of a transition, where the second pass is the correct one.
 *
 * The two irregular cases resolve the way a human would want:
 *  - **spring-forward gap** (02:30 simply does not exist): the result lands at
 *    the first real instant after the gap — a window that "starts at 02:30"
 *    starts as soon as 02:30 would have been;
 *  - **autumn-back overlap** (02:30 happens twice): the first (pre-transition)
 *    occurrence wins, i.e. the operator is available from the earlier of the two.
 *
 * Returns `null` only when the zone or the date is unusable.
 */
export function zonedWallClockToUtc(
  localDate: string,
  minutes: number,
  timeZone: string
): Date | null {
  const parsed = parseLocalDate(localDate);
  if (!parsed || !Number.isFinite(minutes)) return null;

  // Minutes may legitimately exceed a day (a window ending at 24:00+); let the
  // calendar absorb the overflow rather than clamping it.
  const wallUtcMs =
    Date.UTC(parsed.year, parsed.month - 1, parsed.day) + Math.round(minutes) * MS_PER_MINUTE;

  const firstOffset = zoneOffsetMsAt(new Date(wallUtcMs), timeZone);
  if (firstOffset === null) return null;
  const firstGuess = new Date(wallUtcMs - firstOffset);

  const secondOffset = zoneOffsetMsAt(firstGuess, timeZone);
  if (secondOffset === null) return null;
  if (secondOffset === firstOffset) return firstGuess;

  return new Date(wallUtcMs - secondOffset);
}

// ── Effective windows for a local date ───────────────────────────────────────

/**
 * The windows that actually apply on one local date for one track: the date's
 * exceptions when it has any, otherwise the recurring weekly rules.
 *
 * Exceptions **replace** rather than extend, which is what makes them able to
 * narrow a day ("this Saturday only 12:00–16:00") and not merely widen it. An
 * `off` exception replaces the `available` track with nothing at all.
 */
export function effectiveWindowsForDate(
  input: OperatorScheduleInput,
  track: ScheduleTrack,
  localDate: string
): { startMinutes: number; endMinutes: number }[] {
  const dated = input.exceptions.filter((e) => e.date === localDate);

  if (track === "available" && dated.some((e) => e.kind === "off")) return [];

  const overrides = dated.filter((e) => e.kind === track);
  if (overrides.length > 0) {
    return overrides
      .filter((e) => e.startMinutes !== null && e.endMinutes !== null)
      .map((e) => ({ startMinutes: e.startMinutes as number, endMinutes: e.endMinutes as number }));
  }

  const weekday = weekdayOfLocalDate(localDate);
  if (weekday === null) return [];
  return input.rules
    .filter((r) => r.track === track && r.weekday === weekday)
    .map((r) => ({ startMinutes: r.startMinutes, endMinutes: r.endMinutes }));
}

/**
 * Every window of `track` that can cover an instant on `localDate`, as concrete
 * UTC instants: the date's own windows plus the previous date's windows that
 * wrap past midnight into it. Wrapping is why the previous day is consulted —
 * a 23:00–07:00 sleep window belongs to yesterday's rules but covers this
 * morning.
 */
function resolvedWindowsCovering(
  input: OperatorScheduleInput,
  track: ScheduleTrack,
  localDate: string,
  timeZone: string
): ResolvedWindow[] {
  const out: ResolvedWindow[] = [];
  const previous = shiftLocalDate(localDate, -1);
  const dates = previous ? [previous, localDate] : [localDate];

  for (const date of dates) {
    for (const w of effectiveWindowsForDate(input, track, date)) {
      const resolved = resolveWindow(date, w, timeZone);
      if (resolved) out.push(resolved);
    }
  }
  return out;
}

/**
 * One stored window on one local date → a UTC interval. `endMinutes <=
 * startMinutes` wraps into the following local day; a window with equal bounds
 * means the whole 24 hours (the same convention `isWithinLocalTimeWindow` uses).
 */
function resolveWindow(
  localDate: string,
  window: { startMinutes: number; endMinutes: number },
  timeZone: string
): ResolvedWindow | null {
  const start = zonedWallClockToUtc(localDate, window.startMinutes, timeZone);
  if (!start) return null;
  const spanMinutes =
    window.endMinutes > window.startMinutes
      ? window.endMinutes - window.startMinutes
      : MINUTES_PER_DAY - window.startMinutes + window.endMinutes;

  // The end is computed as a wall clock on the (possibly next) local date rather
  // than start + span, so a window spanning a DST change keeps its wall-clock end.
  const wraps = window.endMinutes <= window.startMinutes;
  const endDate = wraps ? shiftLocalDate(localDate, 1) : localDate;
  if (!endDate) return null;
  const end = zonedWallClockToUtc(endDate, window.endMinutes, timeZone);
  if (!end) return null;
  // Degenerate/inverted results (a transition ate the whole window) fall back to
  // the arithmetic span so a window never resolves to a negative interval.
  if (end.getTime() <= start.getTime()) {
    return { start, end: new Date(start.getTime() + spanMinutes * MS_PER_MINUTE) };
  }
  return { start, end };
}

function covers(window: ResolvedWindow, instant: Date): boolean {
  const t = instant.getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}

// ── The resolver ─────────────────────────────────────────────────────────────

/**
 * Where the operator is at `now`, and when they are next available.
 *
 * Precedence, strongest first: **absence → sleep → availability**. An absent
 * operator is away even during their usual hours; a sleeping one is asleep even
 * inside an availability window (that overlap is normal — "available 08:00–23:00,
 * asleep 23:00–07:00" needs no gap engineering to behave).
 */
export function resolveAvailability(
  input: OperatorScheduleInput | null,
  now: Date
): OperatorAvailability {
  if (!input) {
    return unresolved(null, "нет ни одного оператора с расписанием");
  }
  const operator = input.operator;
  if (!operator.active) {
    return unresolved(operator.id, `оператор «${operator.name}» отключён`);
  }
  const timeZone = operator.timeZone;
  if (!isValidTimeZone(timeZone)) {
    return unresolved(
      operator.id,
      `таймзона оператора «${operator.name}» не задана или неизвестна — расписание не разобрано`
    );
  }
  const zone = timeZone as string;

  const absence = activeAbsence(input.absences, now);
  if (absence) {
    return {
      presence: "AWAY",
      operatorId: operator.id,
      nextAvailableAt: nextAvailableFrom(input, zone, absenceEndOrNull(absence) ?? now),
      availableUntil: null,
      reason: absence.reason
        ? `оператор отсутствует: ${absence.reason}`
        : "оператор временно отсутствует",
      resolved: true
    };
  }

  const localDate = localDateInZone(now, zone);
  if (!localDate || localMinutesInZone(now, zone) === null) {
    return unresolved(operator.id, "локальная дата в таймзоне оператора не разобрана");
  }

  const sleep = resolvedWindowsCovering(input, "sleep", localDate, zone).find((w) => covers(w, now));
  if (sleep) {
    return {
      presence: "ASLEEP",
      operatorId: operator.id,
      nextAvailableAt: nextAvailableFrom(input, zone, sleep.end),
      availableUntil: null,
      reason: "оператор спит",
      resolved: true
    };
  }

  const open = resolvedWindowsCovering(input, "available", localDate, zone).find((w) =>
    covers(w, now)
  );
  if (open) {
    return {
      presence: "AVAILABLE",
      operatorId: operator.id,
      nextAvailableAt: now,
      availableUntil: open.end,
      reason: "оператор доступен",
      resolved: true
    };
  }

  const next = nextAvailableFrom(input, zone, now);
  return {
    presence: "OFF",
    operatorId: operator.id,
    nextAvailableAt: next,
    availableUntil: null,
    reason: next ? "оператор вне рабочего окна" : "в расписании нет ближайших рабочих окон",
    resolved: true
  };
}

/**
 * Availability across a set of operators — the multi-operator entry point.
 * The farm is available when *any* operator is, and the soonest `nextAvailableAt`
 * across everyone wins. With a single operator this is exactly
 * {@link resolveAvailability}.
 *
 * An empty roster is `UNKNOWN`, never `OFF`: no schedule is not the same fact as
 * a schedule that says no.
 */
export function resolveFarmAvailability(
  inputs: readonly OperatorScheduleInput[],
  now: Date
): OperatorAvailability {
  if (inputs.length === 0) return unresolved(null, "нет ни одного оператора с расписанием");

  const results = inputs.map((i) => resolveAvailability(i, now));
  const available = results.find((r) => r.presence === "AVAILABLE");
  if (available) return available;

  const resolvedResults = results.filter((r) => r.resolved);
  if (resolvedResults.length === 0) return results[0];

  // Nobody is available now: report the strongest explanation (a sleeping
  // operator is more informative than a generic "off") with the soonest opening.
  const soonest = resolvedResults
    .map((r) => r.nextAvailableAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  const preferred =
    resolvedResults.find((r) => r.presence === "ASLEEP") ??
    resolvedResults.find((r) => r.presence === "AWAY") ??
    resolvedResults[0];

  return { ...preferred, nextAvailableAt: soonest ?? null };
}

/**
 * The first availability-window start at or after `from` that is not swallowed
 * by sleep or an absence, scanning day by day to the horizon. Returns `null`
 * when the horizon holds no opening — the honest "I do not know when" that
 * callers must treat as a refusal, not as "later today".
 */
function nextAvailableFrom(
  input: OperatorScheduleInput,
  timeZone: string,
  from: Date
): Date | null {
  const startDate = localDateInZone(from, timeZone);
  if (!startDate) return null;

  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset++) {
    const date = shiftLocalDate(startDate, offset);
    if (!date) return null;
    const windows = effectiveWindowsForDate(input, "available", date)
      .map((w) => resolveWindow(date, w, timeZone))
      .filter((w): w is ResolvedWindow => w !== null)
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    for (const window of windows) {
      // A window already in progress counts from `from`, not from its start.
      const candidate = window.start.getTime() >= from.getTime() ? window.start : from;
      if (candidate.getTime() >= window.end.getTime()) continue;
      if (isFreeAt(input, timeZone, candidate)) return candidate;
    }
  }
  return null;
}

/** Whether `instant` falls outside every absence and every sleep window. */
function isFreeAt(input: OperatorScheduleInput, timeZone: string, instant: Date): boolean {
  if (activeAbsence(input.absences, instant)) return false;
  const localDate = localDateInZone(instant, timeZone);
  if (!localDate) return false;
  return !resolvedWindowsCovering(input, "sleep", localDate, timeZone).some((w) =>
    covers(w, instant)
  );
}

function activeAbsence(
  absences: readonly OperatorAbsence[],
  instant: Date
): OperatorAbsence | null {
  const t = instant.getTime();
  for (const absence of absences) {
    const start = Date.parse(absence.startsAt);
    if (!Number.isFinite(start) || t < start) continue;
    if (absence.endsAt === null) return absence;
    const end = Date.parse(absence.endsAt);
    if (!Number.isFinite(end) || t < end) return absence;
  }
  return null;
}

function absenceEndOrNull(absence: OperatorAbsence): Date | null {
  if (absence.endsAt === null) return null;
  const end = Date.parse(absence.endsAt);
  return Number.isFinite(end) ? new Date(end) : null;
}

function unresolved(operatorId: string | null, reason: string): OperatorAvailability {
  return {
    presence: "UNKNOWN",
    operatorId,
    nextAvailableAt: null,
    availableUntil: null,
    reason,
    resolved: false
  };
}
