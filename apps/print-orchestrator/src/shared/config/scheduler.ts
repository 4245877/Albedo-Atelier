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
   * Night ETA safety buffer, as a **fraction of the ETA** — `0.2` means +20%, i.e.
   * `bufferedEta = eta × (1 + 0.2)`. It is NOT a bare multiplier (0.2 would then
   * shrink the print to a fifth) and NOT a count of minutes. The single applier is
   * `applyBufferMinutes` / `applySafetyBuffer`; nothing else may re-derive it.
   *
   * Applied to the source ETA for unattended-night decisions while the farm has no
   * historical P90; the result stays flagged provisional.
   */
  nightEtaSafetyBuffer: envVar("NIGHT_ETA_SAFETY_BUFFER", "scheduler", (n, raw) =>
    readNonNegativeNumber(n, raw, 0.2)
  ),
  /**
   * The farm's IANA timezone — the wall clock `NIGHT_PRINT_WINDOW` is expressed in.
   * Stored timestamps stay UTC everywhere; only window arithmetic is localized, and
   * it goes through this zone rather than the container's ambient `TZ`, which is
   * frequently UTC while the farm is not. An unparseable zone is not silently
   * replaced: night starts fail closed with `NIGHT_WINDOW_UNKNOWN`.
   */
  farmTimezone: envVar("FARM_TIMEZONE", "scheduler", (_n, raw) => {
    const value = raw?.trim();
    return value && value.length > 0 ? value : "Europe/Moscow";
  }),
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
    farmTimezone: VARS.farmTimezone.read(source),
    schedulerTelemetryStaleMs: VARS.schedulerTelemetryStaleMs.read(source)
  };
}
