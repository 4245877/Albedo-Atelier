import { readLogLevel, readNonNegativeInt, readPort, readPositiveInt } from "./readers";
import { envVar, type EnvSource } from "./registry";

const VARS = {
  nodeEnv: envVar("NODE_ENV", "server", (_n, raw) => raw ?? "development"),
  serviceName: envVar("SERVICE_NAME", "server", (_n, raw) => raw ?? "print-orchestrator"),
  serviceVersion: envVar("SERVICE_VERSION", "server", (_n, raw) => raw ?? "v0.1.0"),
  host: envVar("HOST", "server", (_n, raw) => raw ?? "0.0.0.0"),
  port: envVar("PORT", "server", (n, raw) => readPort(n, raw, 3100)),
  logLevel: envVar("LOG_LEVEL", "server", (_n, raw) => readLogLevel(raw, "info")),
  /**
   * Maximum time Fastify may spend loading plugins and running startup hooks.
   * The onReady hook includes the first real device poll, whose bounded network
   * phases can legitimately take longer than Fastify's 10 s default.
   */
  startupTimeoutMs: envVar("STARTUP_TIMEOUT_MS", "server", (n, raw) => readPositiveInt(n, raw, 45_000)),
  /**
   * How often the farm polls real printers for live status. Must be strictly
   * positive: a `0`/negative interval would turn the poll loop into a near-
   * continuous, self-DoS-ing spin, so it fails startup rather than being accepted.
   */
  printerPollIntervalMs: envVar("PRINTER_POLL_INTERVAL_MS", "server", (n, raw) =>
    readPositiveInt(n, raw, 10000)
  ),
  /**
   * How long shutdown waits for in-flight analysis/slice jobs to settle before
   * closing SQLite anyway. Whatever is still unfinished at the deadline is
   * reported explicitly and recovered as `pending` on the next boot.
   */
  shutdownDrainTimeoutMs: envVar("SHUTDOWN_DRAIN_TIMEOUT_MS", "server", (n, raw) =>
    readNonNegativeInt(n, raw, 15_000)
  ),
  /** Hard cap on the whole graceful shutdown; past it the process force-exits. */
  shutdownTimeoutMs: envVar("SHUTDOWN_TIMEOUT_MS", "server", (n, raw) =>
    readNonNegativeInt(n, raw, 25_000)
  )
};

/** Fastify/service process settings (identity, listen address, timeouts). */
export function buildServerConfig(source: EnvSource) {
  return {
    nodeEnv: VARS.nodeEnv.read(source),
    serviceName: VARS.serviceName.read(source),
    serviceVersion: VARS.serviceVersion.read(source),
    host: VARS.host.read(source),
    port: VARS.port.read(source),
    logLevel: VARS.logLevel.read(source),
    startupTimeoutMs: VARS.startupTimeoutMs.read(source),
    printerPollIntervalMs: VARS.printerPollIntervalMs.read(source),
    shutdownDrainTimeoutMs: VARS.shutdownDrainTimeoutMs.read(source),
    shutdownTimeoutMs: VARS.shutdownTimeoutMs.read(source)
  };
}
