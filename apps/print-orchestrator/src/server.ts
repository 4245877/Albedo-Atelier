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

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "print-orchestrator shutting down");
  await app.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

void start();
