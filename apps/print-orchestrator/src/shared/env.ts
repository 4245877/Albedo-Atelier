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

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? "development",
  serviceName: process.env.SERVICE_NAME ?? "print-orchestrator",
  serviceVersion: process.env.SERVICE_VERSION ?? "v0.1.0",
  host: process.env.HOST ?? "0.0.0.0",
  port: readInteger(process.env.PORT, 3100),
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl: process.env.DATABASE_URL,
  /** How often the farm polls real printers for live status. */
  printerPollIntervalMs: readInteger(process.env.PRINTER_POLL_INTERVAL_MS, 10000),
  /** Night-print window shown on the dashboard (config, not telemetry). */
  nightWindow: process.env.NIGHT_PRINT_WINDOW ?? "23:00 – 07:30"
});
