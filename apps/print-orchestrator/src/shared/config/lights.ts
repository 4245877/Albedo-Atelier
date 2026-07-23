import { parseLocalTimeWindow } from "../time";
import { FALSE_TOKENS, TRUE_TOKENS } from "./readers";
import { envVar, type EnvSource } from "./registry";

export type LightScheduleMode = "solar" | "fixed";

/**
 * Chamber-light schedule configuration (the `LIGHT_*` variables). Separate from
 * `NIGHT_PRINT_WINDOW` on purpose: that window stays the night-print planning
 * and dashboard-theme setting, while the lights follow this policy.
 */
export interface LightScheduleConfig {
  mode: LightScheduleMode;
  /** Farm location for the local solar calculation; null → solar unavailable. */
  latitude: number | null;
  longitude: number | null;
  /** Minutes relative to sunset when the dark period starts (negative = before). */
  onOffsetMinutes: number;
  /** Minutes relative to sunrise when the dark period ends (positive = after). */
  offOffsetMinutes: number;
  /** Light up only printers that are printing/paused, not the idle ones. */
  onlyWhenActive: boolean;
  /**
   * Fixed `HH:MM-HH:MM` window: the schedule itself in `fixed` mode, the safety
   * net in `solar` mode when the solar calculation is unavailable.
   */
  fallbackWindow: string;
  /** Human-readable config problems; each invalid value was replaced by its default. */
  issues: string[];
}

const LIGHT_FALLBACK_WINDOW_DEFAULT = "16:00-08:00";
const LIGHT_ON_OFFSET_DEFAULT = -30;
const LIGHT_OFF_OFFSET_DEFAULT = 30;
/** Offsets beyond ±12 h cannot mean "relative to sunset/sunrise" any more. */
const LIGHT_OFFSET_LIMIT_MINUTES = 720;

// Registered through the shared registry (readers unused — the LIGHT_* block is
// deliberately lenient and parsed wholesale by parseLightScheduleEnv below).
for (const name of [
  "LIGHT_SCHEDULE_MODE",
  "LIGHT_LATITUDE",
  "LIGHT_LONGITUDE",
  "LIGHT_ON_OFFSET_MINUTES",
  "LIGHT_OFF_OFFSET_MINUTES",
  "LIGHT_ONLY_WHEN_ACTIVE",
  "LIGHT_FALLBACK_WINDOW"
]) {
  envVar(name, "lights", (_n, raw) => raw);
}

function readLightNumber(
  name: string,
  value: string | undefined,
  unsetDefault: number | null,
  min: number,
  max: number,
  issues: string[],
  /**
   * What a present-but-broken value degrades to. Coordinates degrade to `null`
   * ("solar impossible" → the policy engages the fallback window) instead of a
   * silently wrong location; offsets degrade to their defaults.
   */
  invalidFallback: number | null = unsetDefault
): number | null {
  if (value === undefined || value.trim() === "") return unsetDefault;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    issues.push(
      `${name}=«${value}» вне диапазона ${min}…${max} — ${
        invalidFallback === null ? "солнечный расчёт недоступен" : "используется значение по умолчанию"
      }`
    );
    return invalidFallback;
  }
  return parsed;
}

function readLightBoolean(
  name: string,
  value: string | undefined,
  fallback: boolean,
  issues: string[]
): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (TRUE_TOKENS.has(normalized)) return true;
  if (FALSE_TOKENS.has(normalized)) return false;
  issues.push(`${name}=«${value}» не является boolean — используется значение по умолчанию`);
  return fallback;
}

/**
 * Parses the `LIGHT_*` environment leniently: an invalid value never throws
 * (the farm must keep running), it is replaced by its default and recorded in
 * `issues` so the policy can surface a warning. `nightWindow` is only the
 * legacy migration source: `LIGHT_SCHEDULE_MODE=fixed` without an explicit
 * `LIGHT_FALLBACK_WINDOW` keeps switching on the old `NIGHT_PRINT_WINDOW`
 * schedule, so upgrading changes nothing until solar mode is chosen.
 */
export function parseLightScheduleEnv(
  source: EnvSource,
  nightWindow: string
): LightScheduleConfig {
  const issues: string[] = [];

  const rawMode = (source.LIGHT_SCHEDULE_MODE ?? "solar").trim().toLowerCase();
  let mode: LightScheduleMode;
  if (rawMode === "solar" || rawMode === "fixed") {
    mode = rawMode;
  } else {
    issues.push(`LIGHT_SCHEDULE_MODE=«${source.LIGHT_SCHEDULE_MODE}» неизвестен (solar|fixed) — используется solar`);
    mode = "solar";
  }

  const latitude = readLightNumber(
    "LIGHT_LATITUDE",
    source.LIGHT_LATITUDE,
    50.45,
    -90,
    90,
    issues,
    null
  );
  const longitude = readLightNumber(
    "LIGHT_LONGITUDE",
    source.LIGHT_LONGITUDE,
    30.52,
    -180,
    180,
    issues,
    null
  );

  const onOffsetMinutes =
    readLightNumber(
      "LIGHT_ON_OFFSET_MINUTES",
      source.LIGHT_ON_OFFSET_MINUTES,
      LIGHT_ON_OFFSET_DEFAULT,
      -LIGHT_OFFSET_LIMIT_MINUTES,
      LIGHT_OFFSET_LIMIT_MINUTES,
      issues
    ) ?? LIGHT_ON_OFFSET_DEFAULT;
  const offOffsetMinutes =
    readLightNumber(
      "LIGHT_OFF_OFFSET_MINUTES",
      source.LIGHT_OFF_OFFSET_MINUTES,
      LIGHT_OFF_OFFSET_DEFAULT,
      -LIGHT_OFFSET_LIMIT_MINUTES,
      LIGHT_OFFSET_LIMIT_MINUTES,
      issues
    ) ?? LIGHT_OFF_OFFSET_DEFAULT;

  const onlyWhenActive = readLightBoolean(
    "LIGHT_ONLY_WHEN_ACTIVE",
    source.LIGHT_ONLY_WHEN_ACTIVE,
    true,
    issues
  );

  // Fixed mode without an explicit window keeps the legacy NIGHT_PRINT_WINDOW
  // schedule; solar mode falls back to the light-specific default window.
  const explicitWindow = source.LIGHT_FALLBACK_WINDOW?.trim();
  let fallbackWindow =
    explicitWindow || (mode === "fixed" ? nightWindow : LIGHT_FALLBACK_WINDOW_DEFAULT);
  if (!parseLocalTimeWindow(fallbackWindow)) {
    issues.push(
      `Окно подсветки «${fallbackWindow}» не в формате HH:MM-HH:MM — используется ${LIGHT_FALLBACK_WINDOW_DEFAULT}`
    );
    fallbackWindow = LIGHT_FALLBACK_WINDOW_DEFAULT;
  }

  return {
    mode,
    latitude,
    longitude,
    onOffsetMinutes,
    offOffsetMinutes,
    onlyWhenActive,
    fallbackWindow,
    issues
  };
}
