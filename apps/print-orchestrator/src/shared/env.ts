import path from "node:path";

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
  /** Night-print window shown on the dashboard (config, not telemetry). */
  nightWindow: process.env.NIGHT_PRINT_WINDOW ?? "23:00 – 07:30",
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
