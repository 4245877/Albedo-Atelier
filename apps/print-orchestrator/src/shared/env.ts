import path from "node:path";

import { parseLocalTimeWindow } from "./time";

// ── Env value parsing ───────────────────────────────────────────────────────
// One consistent rule for every scalar env value: surrounding whitespace is
// trimmed, an unset or blank value uses the documented default, and a
// present-but-malformed value FAILS startup with a message naming the variable
// rather than silently degrading to a wrong limit, interval or flag. Numbers are
// parsed strictly (never `parseInt`/`parseFloat`, which quietly keep the leading
// digits of "200MB" or "1.5x"). The LIGHT_* block is the one deliberate
// exception — it is lenient and records issues so the farm keeps running (see
// {@link parseLightScheduleEnv}).

/** Accepted tokens for a boolean flag, kept in one place for the strict and lenient readers. */
const TRUE_TOKENS = new Set(["true", "1", "yes", "on"]);
const FALSE_TOKENS = new Set(["false", "0", "no", "off"]);
const BOOLEAN_TOKENS = [...TRUE_TOKENS, ...FALSE_TOKENS].join("/");

/** Log levels Pino accepts (Fastify passes `logLevel` straight through to Pino). */
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** `undefined`/blank → null (caller uses its default); otherwise the trimmed token. */
function normalizeEnv(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

interface NumericBounds {
  /** The value must be an integer. */
  integer?: boolean;
  /** Inclusive lower bound. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
  /** Exclusive lower bound (strictly-positive → `exclusiveMin: 0`). */
  exclusiveMin?: number;
}

/**
 * Strictly parses a numeric env value, failing fast on anything that is not a
 * complete, finite number within `bounds`. `Number()` (unlike parseInt/
 * parseFloat) rejects a trailing suffix — "200MB", "10abc", "1.5x" all become
 * NaN — while still accepting decimals, signs and scientific notation. Unset or
 * blank → the default.
 */
function readNumber(
  name: string,
  value: string | undefined,
  fallback: number,
  bounds: NumericBounds = {}
): number {
  const token = normalizeEnv(value);
  if (token === null) return fallback;

  const parsed = Number(token);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: «${token}» (expected a finite number)`);
  }
  if (bounds.integer && !Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: «${token}» (expected an integer)`);
  }
  if (bounds.exclusiveMin !== undefined && !(parsed > bounds.exclusiveMin)) {
    throw new Error(`Invalid ${name}: «${token}» (must be greater than ${bounds.exclusiveMin})`);
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    throw new Error(`Invalid ${name}: «${token}» (must be ≥ ${bounds.min})`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new Error(`Invalid ${name}: «${token}» (must be ≤ ${bounds.max})`);
  }
  return parsed;
}

/** Any integer (may be negative); fails fast on garbage or a non-integer. */
export function readInteger(name: string, value: string | undefined, fallback: number): number {
  return readNumber(name, value, fallback, { integer: true });
}

/** A strictly-positive integer (upload/analysis limits, retention, the poll interval). */
export function readPositiveInt(name: string, value: string | undefined, fallback: number): number {
  return readNumber(name, value, fallback, { integer: true, min: 1 });
}

/** A non-negative integer (a delay/settle where 0 = "no wait" is legitimate). */
export function readNonNegativeInt(
  name: string,
  value: string | undefined,
  fallback: number
): number {
  return readNumber(name, value, fallback, { integer: true, min: 0 });
}

/** A TCP port (1…65535). */
export function readPort(name: string, value: string | undefined, fallback: number): number {
  return readNumber(name, value, fallback, { integer: true, min: 1, max: 65535 });
}

/** A strictly-positive number (e.g. a compression ratio). */
export function readPositiveNumber(
  name: string,
  value: string | undefined,
  fallback: number
): number {
  return readNumber(name, value, fallback, { exclusiveMin: 0 });
}

/** A non-negative number (e.g. a safety-buffer fraction; 0 = "no buffer"). */
export function readNonNegativeNumber(
  name: string,
  value: string | undefined,
  fallback: number
): number {
  return readNumber(name, value, fallback, { min: 0 });
}

/**
 * A boolean env flag. Accepts true/1/yes/on and false/0/no/off (any case,
 * trimmed); unset/blank → the default. A present-but-unrecognized value (a typo
 * like `ture`) FAILS startup rather than silently taking the default — a
 * security flag such as `ORCA_SLICER_NETWORK_ISOLATED` must never be quietly
 * disabled by a typo. The lenient LIGHT_* variant records an issue instead of
 * throwing, by design.
 */
export function readBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  const token = normalizeEnv(value);
  if (token === null) return fallback;
  const normalized = token.toLowerCase();
  if (TRUE_TOKENS.has(normalized)) return true;
  if (FALSE_TOKENS.has(normalized)) return false;
  throw new Error(`Invalid ${name}: «${token}» (expected a boolean: ${BOOLEAN_TOKENS})`);
}

/** The log level Fastify/Pino will use; an unknown level fails fast here, not later inside Pino. */
export function readLogLevel(value: string | undefined, fallback: string): string {
  const token = normalizeEnv(value);
  if (token === null) return fallback;
  const level = token.toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`Invalid LOG_LEVEL: «${token}» (expected one of ${LOG_LEVELS.join(", ")})`);
  }
  return level;
}

/** Splits a shell-ish args string on whitespace (container-mode base args); empty → []. */
function readArgs(value: string | undefined): string[] {
  const token = normalizeEnv(value);
  return token === null ? [] : token.split(/\s+/);
}

const MB = 1024 * 1024;

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

/**
 * SQLite database backing the persistent print-queue model (tasks, assignments,
 * the print-run chain, audit log). Kept next to {@link stateFilePath} so the
 * same mounted `/app/data` volume holds both; defaults to `<state dir>/queue.db`.
 */
const queueDbPath =
  process.env.QUEUE_DB_PATH || path.resolve(path.dirname(stateFilePath), "queue.db");

/**
 * Root of the content-addressed artifact blob store (`sha256/<prefix>/<hash>`),
 * kept next to {@link stateFilePath} on the same mounted `/app/data` volume so
 * uploaded model/G-code bytes survive a restart. Never stored in SQLite — the
 * database keeps only the relative storage key.
 */
const artifactStorageRoot =
  process.env.ARTIFACT_STORAGE_ROOT || path.resolve(path.dirname(stateFilePath), "artifacts");

/**
 * Directory uploads are staged in before the atomic move into blob storage.
 * Defaults under the storage root so the rename stays on one filesystem
 * (atomic); an override on another device falls back to a copy.
 */
const uploadTmpDir = process.env.UPLOAD_TMP_DIR || path.join(artifactStorageRoot, ".tmp");

/**
 * Upload + analysis limits and locations. All numeric values are strictly
 * positive: an invalid override fails startup with a clear message
 * (see {@link readPositiveInt}); an unset one uses the documented default here.
 * Defaults are deliberately generous enough for real FDM slices yet bounded so a
 * hostile upload cannot exhaust disk, memory or CPU.
 */
export const uploads = Object.freeze({
  storageRoot: artifactStorageRoot,
  tmpDir: uploadTmpDir,
  /** Maximum size of a single uploaded file (bytes). */
  maxFileBytes: readPositiveInt("MAX_UPLOAD_FILE_BYTES", process.env.MAX_UPLOAD_FILE_BYTES, 200 * MB),
  /** Maximum number of files the dashboard may add in one batch (advisory; enforced client-side). */
  maxFiles: readPositiveInt("MAX_UPLOAD_FILES", process.env.MAX_UPLOAD_FILES, 20),
  /** Maximum combined size of one batch (advisory; enforced client-side). */
  maxTotalBytes: readPositiveInt("MAX_UPLOAD_TOTAL_BYTES", process.env.MAX_UPLOAD_TOTAL_BYTES, 500 * MB),
  /**
   * Hard SERVER-side cap on the total on-disk artifact store (dedup-aware sum of
   * distinct blob sizes). A new upload that would push past it is refused (413),
   * so a flood of uploads cannot fill the shared data volume. Distinct from the
   * advisory per-batch {@link maxTotalBytes} above.
   */
  maxStoredBytes: readPositiveInt("MAX_ARTIFACT_STORE_BYTES", process.env.MAX_ARTIFACT_STORE_BYTES, 20 * 1024 * MB),
  /** Hard SERVER-side cap on the number of stored artifacts. */
  maxArtifactCount: readPositiveInt("MAX_ARTIFACT_COUNT", process.env.MAX_ARTIFACT_COUNT, 5000),
  /**
   * Free-disk reserve (bytes): an upload is refused when the filesystem holding
   * the store has less than this available, so the service degrades safely
   * instead of filling the disk the JSON state + SQLite also live on.
   */
  minFreeDiskBytes: readPositiveInt("UPLOAD_MIN_FREE_DISK_BYTES", process.env.UPLOAD_MIN_FREE_DISK_BYTES, 512 * MB),
  /**
   * Cap on the number of analyses queued/running at once. Beyond it an upload is
   * refused (503) rather than growing an unbounded backlog that would keep the
   * event loop and disk busy — the "лимит общей очереди анализа" bound.
   */
  analysisMaxQueue: readPositiveInt("ANALYSIS_MAX_QUEUE", process.env.ANALYSIS_MAX_QUEUE, 200),
  /**
   * Default age cutoff (days) for the artifact retention sweep — only provably
   * unused artifacts older than this are reclaimed, and only when the operator
   * (or a cron) invokes the sweep endpoint; nothing is deleted spontaneously.
   */
  retentionDays: readPositiveInt("ARTIFACT_RETENTION_DAYS", process.env.ARTIFACT_RETENTION_DAYS, 30),
  /** Per-file analysis wall-clock budget (ms) before it is failed as timed out. */
  analysisTimeoutMs: readPositiveInt("ANALYSIS_TIMEOUT_MS", process.env.ANALYSIS_TIMEOUT_MS, 30000),
  /** How many files may be analysed concurrently by the in-process worker pool. */
  analysisConcurrency: readPositiveInt("ANALYSIS_CONCURRENCY", process.env.ANALYSIS_CONCURRENCY, 2),
  /** ZIP (3MF) safety caps — see the SafeZip reader. */
  zipMaxEntries: readPositiveInt("UPLOAD_ZIP_MAX_ENTRIES", process.env.UPLOAD_ZIP_MAX_ENTRIES, 10000),
  zipMaxEntryBytes: readPositiveInt("UPLOAD_ZIP_MAX_ENTRY_BYTES", process.env.UPLOAD_ZIP_MAX_ENTRY_BYTES, 256 * MB),
  zipMaxTotalBytes: readPositiveInt("UPLOAD_ZIP_MAX_TOTAL_BYTES", process.env.UPLOAD_ZIP_MAX_TOTAL_BYTES, 512 * MB),
  zipMaxRatio: readPositiveNumber("UPLOAD_ZIP_MAX_RATIO", process.env.UPLOAD_ZIP_MAX_RATIO, 200),
  /** Maximum size of any single XML document parsed from a 3MF. */
  xmlMaxBytes: readPositiveInt("UPLOAD_XML_MAX_BYTES", process.env.UPLOAD_XML_MAX_BYTES, 64 * MB)
});

/**
 * OrcaSlicer preset-catalog + slicing-runtime configuration.
 *
 * `command` is the executable the slicing worker spawns; when unset there is **no**
 * runtime and every slice is honestly `blocked` (nothing is faked). For network
 * isolation, set `command` to a container runtime and `baseArgs` to its
 * `run --rm --network none …` flags, and flag `networkIsolated`. The pinned version
 * defaults to the OrcaSlicer release the vendored bundles came from; the worker
 * version is bumped in code when the slice logic changes (both feed the cache key).
 */
export const slicing = Object.freeze({
  /** The vendored catalog root (`config/slicers/orca`); ships in the image. */
  catalogDir:
    process.env.ORCA_CATALOG_DIR || path.resolve(process.cwd(), "config", "slicers", "orca"),
  /** Executable to spawn (OrcaSlicer, or a container runtime); null → runtime unavailable. */
  command: process.env.ORCA_SLICER_CMD?.trim() || null,
  /** Args prepended before the slice args (container `run … <image> orca-slicer`). */
  baseArgs: readArgs(process.env.ORCA_SLICER_BASE_ARGS),
  /** Extra args appended before the model path (advanced tuning). */
  extraArgs: readArgs(process.env.ORCA_SLICER_EXTRA_ARGS),
  /** The pinned OrcaSlicer version (the bundles were exported from 2.3.0). */
  pinnedVersion: process.env.ORCA_SLICER_VERSION?.trim() || "2.3.0",
  /** The slice worker's own version — bump when the slice logic changes (cache key input). */
  workerVersion: "orca-slice-1",
  /** True when the slicer runs with the network disabled (container mode). */
  networkIsolated: readBoolean(
    "ORCA_SLICER_NETWORK_ISOLATED",
    process.env.ORCA_SLICER_NETWORK_ISOLATED,
    false
  ),
  /** Per-slice wall-clock budget (ms) before the process is killed. */
  timeoutMs: readPositiveInt("ORCA_SLICE_TIMEOUT_MS", process.env.ORCA_SLICE_TIMEOUT_MS, 600000),
  /** How many slices may run at once (slicing is heavy — default 1). */
  concurrency: readPositiveInt("ORCA_SLICE_CONCURRENCY", process.env.ORCA_SLICE_CONCURRENCY, 1),
  /** Base directory each slice gets an isolated work dir under (on the data volume). */
  tmpRoot: process.env.ORCA_SLICE_TMP_DIR || path.resolve(path.dirname(stateFilePath), "slice-tmp"),
  /** Import the catalog into the DB on first boot (idempotent). */
  autoImport: readBoolean("ORCA_AUTO_IMPORT", process.env.ORCA_AUTO_IMPORT, true)
});

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? "development",
  serviceName: process.env.SERVICE_NAME ?? "print-orchestrator",
  serviceVersion: process.env.SERVICE_VERSION ?? "v0.1.0",
  host: process.env.HOST ?? "0.0.0.0",
  port: readPort("PORT", process.env.PORT, 3100),
  logLevel: readLogLevel(process.env.LOG_LEVEL, "info"),
  /**
   * Maximum time Fastify may spend loading plugins and running startup hooks.
   * The onReady hook includes the first real device poll, whose bounded network
   * phases can legitimately take longer than Fastify's 10 s default.
   */
  startupTimeoutMs: readPositiveInt(
    "STARTUP_TIMEOUT_MS",
    process.env.STARTUP_TIMEOUT_MS,
    45_000
  ),
  /**
   * How often the farm polls real printers for live status. Must be strictly
   * positive: a `0`/negative interval would turn the poll loop into a near-
   * continuous, self-DoS-ing spin, so it fails startup rather than being accepted.
   */
  printerPollIntervalMs: readPositiveInt(
    "PRINTER_POLL_INTERVAL_MS",
    process.env.PRINTER_POLL_INTERVAL_MS,
    10000
  ),
  /**
   * How long shutdown waits for in-flight analysis/slice jobs to settle before
   * closing SQLite anyway. Whatever is still unfinished at the deadline is
   * reported explicitly and recovered as `pending` on the next boot.
   */
  shutdownDrainTimeoutMs: readNonNegativeInt(
    "SHUTDOWN_DRAIN_TIMEOUT_MS",
    process.env.SHUTDOWN_DRAIN_TIMEOUT_MS,
    15_000
  ),
  /** Hard cap on the whole graceful shutdown; past it the process force-exits. */
  shutdownTimeoutMs: readNonNegativeInt(
    "SHUTDOWN_TIMEOUT_MS",
    process.env.SHUTDOWN_TIMEOUT_MS,
    25_000
  ),
  /**
   * Night-print window shown on the dashboard (config, not telemetry). Also
   * drives the dashboard's automatic dark theme and the night-plan duration
   * checks. Deliberately NOT the chamber-light schedule — the lights follow
   * {@link env.lightSchedule} (`LIGHT_*`), so this stays a plain fixed window.
   */
  nightWindow: process.env.NIGHT_PRINT_WINDOW ?? "21:30 – 07:30",
  /**
   * Manual-scheduler night ETA safety buffer as a fraction (0.2 → +20%). Applied
   * to the source ETA for unattended-night recommendations while the farm has no
   * historical P90; the result stays flagged provisional. Configurable per the brief.
   */
  nightEtaSafetyBuffer: readNonNegativeNumber(
    "NIGHT_ETA_SAFETY_BUFFER",
    process.env.NIGHT_ETA_SAFETY_BUFFER,
    0.2
  ),
  /** Telemetry older than this (ms) is treated as stale by the scheduler → review. */
  schedulerTelemetryStaleMs: readNonNegativeInt(
    "SCHEDULER_TELEMETRY_STALE_MS",
    process.env.SCHEDULER_TELEMETRY_STALE_MS,
    120_000
  ),
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
  snapshotLightSettleMs: readNonNegativeInt(
    "SNAPSHOT_LIGHT_SETTLE_MS",
    process.env.SNAPSHOT_LIGHT_SETTLE_MS,
    1200
  ),
  /**
   * JSON file the operator queue, event feed and today counters are persisted
   * to, so they survive a restart. Defaults to `<cwd>/data/state.json`; in the
   * container `<cwd>` is `/app`, and compose mounts a volume at `/app/data`.
   */
  stateFilePath,
  /** SQLite database file for the persistent print-queue model (see above). */
  queueDbPath,
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
    readInteger("SNAPSHOT_RETAIN_PER_PRINTER", process.env.SNAPSHOT_RETAIN_PER_PRINTER, 30)
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
  /**
   * Inter-service token for the fulfillment inventory endpoints (consume/sync),
   * sent as the `x-service-token` header. Must equal fulfillment's own
   * `ATELIER_FULFILLMENT_TOKEN`. Never logged, never persisted. Empty with
   * `FULFILLMENT_API_URL` set is a misconfiguration: fulfillment answers 401
   * unless its temporary `ATELIER_FULFILLMENT_AUTH_OPTIONAL` mode is on — a
   * loud warning is logged at startup and every auth refusal surfaces as an
   * operator event (see FilamentConsumption/FilamentSync).
   */
  fulfillmentServiceToken: process.env.ATELIER_FULFILLMENT_TOKEN ?? "",
  /**
   * How long to wait before re-posting a loaded-reel sync that fulfillment
   * answered `resolved: false` (no matching stock yet). Long enough not to
   * hammer fulfillment every poll, short enough that stock added by the
   * operator is picked up before the print usually finishes.
   */
  filamentSyncRetryMs: readPositiveInt(
    "FILAMENT_SYNC_RETRY_MS",
    process.env.FILAMENT_SYNC_RETRY_MS,
    5 * 60 * 1000
  ),
  /**
   * Hard cap on the persistent filament-deduction retry queue. Beyond it the
   * OLDEST entry is dropped with an operator event and a dropped-counter bump
   * (never silently). Documented default: 200.
   */
  filamentRetryQueueMax: readPositiveInt(
    "FILAMENT_RETRY_QUEUE_MAX",
    process.env.FILAMENT_RETRY_QUEUE_MAX,
    200
  ),
  /**
   * How long a queued deduction is retried before it is dropped (loudly, with
   * an operator event + dropped counter). Documented default: 7 days.
   */
  filamentRetryMaxAgeDays: readPositiveInt(
    "FILAMENT_RETRY_MAX_AGE_DAYS",
    process.env.FILAMENT_RETRY_MAX_AGE_DAYS,
    7
  ),
  /**
   * Cross-origin origins allowed to call the API; empty = same-origin only.
   * Frozen: these gate a security decision (CORS/CSRF) and are only ever read
   * (`.includes`), so a shallow `Object.freeze(env)` alone would still leave the
   * list itself mutable — freeze it too.
   */
  corsAllowOrigins: Object.freeze(
    (process.env.CORS_ALLOW_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  ),
  /**
   * Explicit opt-in that lets MUTATIONS through with NO API token configured.
   * The default is fail-closed: without a token (and without this flag) every
   * state-changing request is refused 503 — "no auth configured" must never
   * silently mean "everyone is authorized".
   */
  allowUnauthenticatedMutations: process.env.ALLOW_UNAUTHENTICATED_MUTATIONS === "1",
  /**
   * Extra DNS *hostnames* allowed in the Host header (comma-separated). Literal
   * IPs, localhost and the compose service name pass by default; any other DNS
   * name must be allowlisted here — a DNS-rebinding attack needs a name the
   * attacker controls, which will not be on this list.
   */
  allowedHosts: Object.freeze(
    (process.env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  )
});
