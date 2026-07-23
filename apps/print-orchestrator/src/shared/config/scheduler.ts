import { readNonNegativeInt, readNonNegativeNumber } from "./readers";
import { envVar, type EnvSource } from "./registry";

const VARS = {
  /**
   * Night-print window shown on the dashboard (config, not telemetry). Also
   * drives the dashboard's automatic dark theme and the night-plan duration
   * checks. Deliberately NOT the chamber-light schedule — the lights follow
   * the `LIGHT_*` settings, so this stays a plain fixed window.
   */
  nightWindow: envVar("NIGHT_PRINT_WINDOW", "scheduler", (_n, raw) => raw ?? "21:30 – 07:30"),
  /**
   * Manual-scheduler night ETA safety buffer as a fraction (0.2 → +20%). Applied
   * to the source ETA for unattended-night recommendations while the farm has no
   * historical P90; the result stays flagged provisional. Configurable per the brief.
   */
  nightEtaSafetyBuffer: envVar("NIGHT_ETA_SAFETY_BUFFER", "scheduler", (n, raw) =>
    readNonNegativeNumber(n, raw, 0.2)
  ),
  /** Telemetry older than this (ms) is treated as stale by the scheduler → review. */
  schedulerTelemetryStaleMs: envVar("SCHEDULER_TELEMETRY_STALE_MS", "scheduler", (n, raw) =>
    readNonNegativeInt(n, raw, 120_000)
  )
};

/** Manual-scheduler and night-window settings. */
export function buildSchedulerConfig(source: EnvSource) {
  return {
    nightWindow: VARS.nightWindow.read(source),
    nightEtaSafetyBuffer: VARS.nightEtaSafetyBuffer.read(source),
    schedulerTelemetryStaleMs: VARS.schedulerTelemetryStaleMs.read(source)
  };
}
