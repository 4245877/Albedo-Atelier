import { buildApp } from "./app";
import { env } from "./shared/env";

const app = buildApp();

async function start(): Promise<void> {
  try {
    await app.listen({ host: env.host, port: env.port });
  } catch (error) {
    app.log.error({ err: error }, "print-orchestrator failed to start");
    process.exit(1);
  }
}

/**
 * Graceful shutdown protocol:
 *  - first signal: stop accepting mutations, close the app (farm store drains
 *    workers and closes SQLite last), then exit 0;
 *  - a bounded deadline force-exits if the graceful path hangs, after logging
 *    that the shutdown was forced (unfinished work is recovered on next boot);
 *  - a SECOND signal is an operator insisting — force-exit immediately.
 */
let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    app.log.warn({ signal }, "second shutdown signal — forcing exit now");
    process.exit(130);
  }
  shutdownStarted = true;
  app.log.info({ signal }, "print-orchestrator shutting down");

  (app as typeof app & { markShuttingDown?: () => void }).markShuttingDown?.();

  const deadline = setTimeout(() => {
    app.log.error(
      { timeoutMs: env.shutdownTimeoutMs },
      "graceful shutdown deadline hit — forcing exit; unfinished work will be recovered on next boot"
    );
    process.exit(1);
  }, env.shutdownTimeoutMs);
  deadline.unref();

  try {
    await app.close();
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "graceful shutdown failed");
    process.exit(1);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

void start();
