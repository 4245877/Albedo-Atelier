export function nowIso(): string {
  return new Date().toISOString();
}

/** Local `HH:MM`, matching how the dashboard stamps live feed events. */
export function hhmm(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
