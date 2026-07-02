import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions
} from "fastify";

import { AppError } from "./core/errors";
import { getHealth } from "./infra/observability/health";
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

  // Permissive CORS. The dashboard is normally same-origin — nginx serves the
  // page and proxies /api/print-orchestrator/* to this service — so this only
  // matters when the API is called cross-origin (e.g. during development).
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
      reply.code(204).send();
      return;
    }
    done();
  });

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
  app.get("/ready", async () => getReadiness());

  // Load the real printer config and start the live poll loop with the app;
  // stop polling and close device connections (Bambu MQTT) on shutdown.
  app.addHook("onReady", async () => {
    await farmStore.start(app.log);
  });
  app.addHook("onClose", async () => {
    farmStore.stop();
  });

  // Dashboard read model + per-resource modules (some also accept actions).
  app.register(registerDashboardRoutes, { prefix: "/api" });
  app.register(registerPrinterRoutes, { prefix: "/api/printers" });
  app.register(registerQueueRoutes, { prefix: "/api/queue" });
  app.register(registerAutomationRoutes, { prefix: "/api/automations" });

  return app;
}
