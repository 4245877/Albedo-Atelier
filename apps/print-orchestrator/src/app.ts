import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions
} from "fastify";

import { AppError } from "./core/errors";
import { registerSecurity } from "./core/security";
import { getHealth } from "./infra/observability/health";
import { collectMetrics, METRICS_CONTENT_TYPE } from "./infra/observability/metrics";
import { getReadiness } from "./infra/observability/ready";
import { farmStore } from "./infra/store/farmStore";
import { registerAutomationRoutes } from "./modules/automation/routes";
import { registerDashboardRoutes } from "./modules/dashboard/routes";
import { registerPrinterRoutes } from "./modules/printers/routes";
import { registerQueueRoutes } from "./modules/queue/routes";
import { loggerConfig } from "./shared/logger";

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: loggerConfig,
    ...options
  });

  // CORS (allowlisted, not wildcard) + shared-secret guard on state-changing
  // requests. See ./core/security.
  registerSecurity(app);

  // Map the domain error taxonomy to structured JSON: { error: { code, message, details } }.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details ?? null
        }
      });
      return;
    }

    // Fastify's own errors (schema validation, bad JSON body, …) carry a
    // statusCode; anything else is an unexpected server fault.
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled error");
    }
    reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL" : "BAD_REQUEST",
        message: statusCode >= 500 ? "Internal Server Error" : error.message
      }
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} not found`
      }
    });
  });

  app.get("/health", async () => getHealth());

  // Real readiness: 503 until the first poll completes, or if the poll loop
  // goes stale. A merely degraded farm still returns 200.
  app.get("/ready", async (_request, reply) => {
    const readiness = getReadiness();
    reply.code(readiness.ready ? 200 : 503);
    return readiness;
  });

  // Prometheus metrics drawn from the live farm state.
  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", METRICS_CONTENT_TYPE);
    return collectMetrics();
  });

  // Load the real printer config and start the live poll loop with the app;
  // stop polling and close device connections (Bambu MQTT) on shutdown.
  app.addHook("onReady", async () => {
    await farmStore.start(app.log);
  });
  app.addHook("onClose", async () => {
    await farmStore.stop();
  });

  // Dashboard read model + per-resource modules (some also accept actions).
  app.register(registerDashboardRoutes, { prefix: "/api" });
  app.register(registerPrinterRoutes, { prefix: "/api/printers" });
  app.register(registerQueueRoutes, { prefix: "/api/queue" });
  app.register(registerAutomationRoutes, { prefix: "/api/automations" });

  return app;
}
