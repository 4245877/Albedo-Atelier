import { readBoolean, readNonNegativeInt, readNonNegativeNumber, readPositiveInt } from "./readers";
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
  ),
  /**
   * Operator minutes to ready a plate for the next print after the finished part
   * is removed. The planner places a printer's next job no earlier than: the
   * print's end → the next moment an operator works → part removal + this.
   */
  schedulerBedPrepMinutes: envVar("SCHEDULER_BED_PREP_MINUTES", "scheduler", (n, raw) =>
    readNonNegativeInt(n, raw, 5)
  ),
  /**
   * The automatic queue's deployment switch. **Off by default**: with it off the
   * executor never starts a print, whatever the operator's «Автоочередь» rule
   * says — and the dashboard shows the rule locked. Turning it on only ALLOWS
   * the rule; the rule itself starts off and is switched on by an operator.
   */
  autoQueueEnabled: envVar("AUTO_QUEUE_ENABLED", "scheduler", (n, raw) => readBoolean(n, raw, false)),
  /** Pause between automatic-queue passes, ms (floor 10 s). */
  autoQueueIntervalMs: envVar("AUTO_QUEUE_INTERVAL_MS", "scheduler", (n, raw) =>
    Math.max(10_000, readPositiveInt(n, raw, 60_000))
  ),
  /** Grace after boot before the first pass: recovery done, telemetry fresh. */
  autoQueueStartupDelayMs: envVar("AUTO_QUEUE_STARTUP_DELAY_MS", "scheduler", (n, raw) =>
    readNonNegativeInt(n, raw, 120_000)
  ),
  /** Starts per pass, at most (never two on one printer); capped at 5. */
  autoQueueMaxStartsPerTick: envVar("AUTO_QUEUE_MAX_STARTS_PER_TICK", "scheduler", (n, raw) =>
    Math.min(5, readPositiveInt(n, raw, 1))
  ),
  /** How long a job the policy refused is left alone (unless the job changes), ms. */
  autoQueueRetryCooldownMs: envVar("AUTO_QUEUE_RETRY_COOLDOWN_MS", "scheduler", (n, raw) =>
    readNonNegativeInt(n, raw, 900_000)
  )
};

/** Manual-scheduler and night-window settings. */
export function buildSchedulerConfig(source: EnvSource) {
  return {
    nightWindow: VARS.nightWindow.read(source),
    nightEtaSafetyBuffer: VARS.nightEtaSafetyBuffer.read(source),
    farmTimezone: VARS.farmTimezone.read(source),
    schedulerTelemetryStaleMs: VARS.schedulerTelemetryStaleMs.read(source),
    schedulerBedPrepMinutes: VARS.schedulerBedPrepMinutes.read(source),
    autoQueueEnabled: VARS.autoQueueEnabled.read(source),
    autoQueueIntervalMs: VARS.autoQueueIntervalMs.read(source),
    autoQueueStartupDelayMs: VARS.autoQueueStartupDelayMs.read(source),
    autoQueueMaxStartsPerTick: VARS.autoQueueMaxStartsPerTick.read(source),
    autoQueueRetryCooldownMs: VARS.autoQueueRetryCooldownMs.read(source)
  };
}
