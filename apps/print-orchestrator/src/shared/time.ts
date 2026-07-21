/** Local `HH:MM`, matching how the dashboard stamps live feed events. */
export function hhmm(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Local `YYYY-MM-DD`. Used to key the "today" counters so they roll over at the
 * operator's local midnight (the same timezone `hhmm` and the night window use),
 * not at UTC midnight — the two diverge whenever `TZ` is not UTC.
 */
export function localDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface LocalTimeWindow {
  startMinutes: number;
  endMinutes: number;
}

function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return hours * 60 + minutes;
}

export function parseLocalTimeWindow(value: string): LocalTimeWindow | null {
  const times = value.match(/\b\d{1,2}:\d{2}\b/g);
  if (!times || times.length < 2) return null;

  const startMinutes = parseHHMM(times[0]);
  const endMinutes = parseHHMM(times[1]);
  if (startMinutes === null || endMinutes === null) return null;

  return { startMinutes, endMinutes };
}

/**
 * Canonical zero-padded `"HH:MM"` from minutes since midnight (e.g. 450 →
 * `"07:30"`). Callers pass minutes-since-midnight (0…1439); a value outside that
 * range is normalized into a single day rather than producing `"24:00"` or a
 * negative string — `1440 → "00:00"`, `-1 → "23:59"`. A non-finite input is a
 * programming error and is rejected loudly.
 */
export function minutesToHhmm(minutes: number): string {
  if (!Number.isFinite(minutes)) {
    throw new RangeError(`minutesToHhmm expects a finite number of minutes, got ${minutes}`);
  }
  const dayMinutes = ((Math.trunc(minutes) % 1440) + 1440) % 1440;
  const h = String(Math.floor(dayMinutes / 60)).padStart(2, "0");
  const m = String(dayMinutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

export function minutesSinceLocalMidnight(date: Date = new Date()): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function isWithinLocalTimeWindow(
  window: string | LocalTimeWindow,
  date: Date = new Date()
): boolean {
  const parsed = typeof window === "string" ? parseLocalTimeWindow(window) : window;
  if (!parsed) return false;

  const current = minutesSinceLocalMidnight(date);
  const { startMinutes, endMinutes } = parsed;
  // Equal start and end is a zero-length window read as "the whole day" — always
  // within. Intentional (a light fallback of "08:00-08:00" stays on around the
  // clock); it is NOT "never on". Start is inclusive, end exclusive; a window
  // whose end is before its start (e.g. 21:30–07:30) wraps across midnight.
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return current >= startMinutes && current < endMinutes;
  }
  return current >= startMinutes || current < endMinutes;
}
