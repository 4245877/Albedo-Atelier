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
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return current >= startMinutes && current < endMinutes;
  }
  return current >= startMinutes || current < endMinutes;
}
