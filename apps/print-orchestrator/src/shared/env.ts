import path from "node:path";

import { parseLocalTimeWindow } from "./time";

function readInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer environment value: ${value}`);
  }

  return parsed;
}

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
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
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
  source: Record<string, string | undefined>,
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

const stateFilePath =
  process.env.STATE_FILE_PATH || path.resolve(process.cwd(), "data", "state.json");

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? "development",
  serviceName: process.env.SERVICE_NAME ?? "print-orchestrator",
  serviceVersion: process.env.SERVICE_VERSION ?? "v0.1.0",
  host: process.env.HOST ?? "0.0.0.0",
  port: readInteger(process.env.PORT, 3100),
  logLevel: process.env.LOG_LEVEL ?? "info",
  /** How often the farm polls real printers for live status. */
  printerPollIntervalMs: readInteger(process.env.PRINTER_POLL_INTERVAL_MS, 10000),
  /**
   * Night-print window shown on the dashboard (config, not telemetry). Also
   * drives the dashboard's automatic dark theme and the night-plan duration
   * checks. Deliberately NOT the chamber-light schedule — the lights follow
   * {@link env.lightSchedule} (`LIGHT_*`), so this stays a plain fixed window.
   */
  nightWindow: process.env.NIGHT_PRINT_WINDOW ?? "21:30 – 07:30",
  /** Chamber-light schedule (`LIGHT_*`); invalid values degrade, never throw. */
  lightSchedule: parseLightScheduleEnv(
    process.env,
    process.env.NIGHT_PRINT_WINDOW ?? "21:30 – 07:30"
  ),
  /**
   * How long to wait after switching a chamber light on for a night snapshot
   * before grabbing the frame, so the camera exposes a lit scene rather than a
   * dark one. Only applies when a light-ensured capture actually flipped the
   * light (see FarmStore.getCameraFrame / ensureLight).
   */
  snapshotLightSettleMs: readInteger(process.env.SNAPSHOT_LIGHT_SETTLE_MS, 1200),
  /**
   * JSON file the operator queue, event feed and today counters are persisted
   * to, so they survive a restart. Defaults to `<cwd>/data/state.json`; in the
   * container `<cwd>` is `/app`, and compose mounts a volume at `/app/data`.
   */
  stateFilePath,
  /**
   * Directory the saved camera snapshots (JPEG/PNG files) are written to, kept
   * next to {@link stateFilePath} so the same mounted volume holds both. The
   * durable JSON state stores only the per-snapshot metadata; the image bytes
   * live here as files. Defaults to `<state dir>/snapshots`.
   */
  snapshotsDir:
    process.env.SNAPSHOTS_DIR || path.resolve(path.dirname(stateFilePath), "snapshots"),
  /**
   * How many saved snapshots to keep per printer. Older ones (metadata and the
   * file on disk) are pruned after each new capture so the volume cannot grow
   * without bound. Must be at least 1.
   */
  snapshotRetainPerPrinter: Math.max(
    1,
    readInteger(process.env.SNAPSHOT_RETAIN_PER_PRINTER, 30)
  ),
  /**
   * Shared secret required on state-changing requests (pause/resume/cancel/…).
   * Empty disables the guard — reads stay open either way.
   */
  apiToken: process.env.ORCHESTRATOR_API_TOKEN ?? "",
  /**
   * Base URL of the fulfillment API used to auto-deduct filament stock when a
   * print completes (e.g. `http://fulfillment-api:8080` or `http://<host>:3001`).
   * Empty disables auto-consume — the farm keeps running standalone.
   */
  fulfillmentApiUrl: process.env.FULFILLMENT_API_URL ?? "",
  /** Cross-origin origins allowed to call the API; empty = same-origin only. */
  corsAllowOrigins: (process.env.CORS_ALLOW_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
});
