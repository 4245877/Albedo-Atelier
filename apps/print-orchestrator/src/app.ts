import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { getHealth } from "./infra/observability/health";
import { getReadiness } from "./infra/observability/ready";
import { registerPrinterRoutes } from "./modules/printers/routes";
import { loggerConfig } from "./shared/logger";

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: loggerConfig,
    ...options
  });

  app.get("/health", async () => getHealth());
  app.get("/ready", async () => getReadiness());

  app.register(registerPrinterRoutes, { prefix: "/api/printers" });

  return app;
}
