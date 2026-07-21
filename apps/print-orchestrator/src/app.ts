import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions
} from "fastify";

import { AppError, toClientError } from "./core/errors";
import { registerSecurity } from "./http/security";
import { getHealth } from "./infra/observability/health";
import { collectMetrics, METRICS_CONTENT_TYPE } from "./infra/observability/metrics";
import { getReadiness } from "./infra/observability/ready";
import { farmStore } from "./app/farmStore";
import { registerAutomationRoutes } from "./modules/automation/routes";
import { registerDashboardRoutes } from "./modules/dashboard/routes";
import { registerMonitoringRoutes } from "./modules/monitoring/routes";
import { registerPrintQueueRoutes } from "./modules/print/routes";
import { registerPrinterRoutes } from "./modules/printers/routes";
import { registerQueueRoutes } from "./modules/queue/routes";
import { env } from "./shared/env";
import { loggerConfig } from "./shared/logger";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: loggerConfig,
    // onReady waits for the first real-printer poll. Its status, light and
    // camera phases each have bounded network timeouts, so Fastify's 10 s
    // default is too short for a valid degraded startup. Callers/tests can
    // still override this through `options`.
    pluginTimeout: env.startupTimeoutMs,
    ...options
  });

  // Shutdown drain: once the process received a stop signal, no NEW mutation
  // is accepted (503) — reads keep working while in-flight requests finish, and
  // nothing can start a print into a farm that is closing its database.
  let shuttingDown = false;
  (app as FastifyInstance & { markShuttingDown?: () => void }).markShuttingDown = () => {
    shuttingDown = true;
  };
  app.addHook("onRequest", (request, reply, done) => {
    if (shuttingDown && MUTATING.has(request.method)) {
      reply.code(503).send({
        error: { code: "SHUTTING_DOWN", message: "Сервис завершает работу — изменения не принимаются" }
      });
      return;
    }
    done();
  });

  // CORS (allowlisted, not wildcard) + shared-secret guard on state-changing
  // requests. See ./http/security.
  registerSecurity(app);

  // Map the domain error taxonomy to structured JSON: { error: { code, message, details } }.
  // toClientError is the single client-safe projection — it emits only
  // code/message/details (details guarded to a plain object) and never the
  // original `error.cause`.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: toClientError(error) });
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
  // Persistent print-queue model (SQLite) — the durable successor to /api/queue.
  app.register(registerPrintQueueRoutes, { prefix: "/api/print" });
  app.register(registerAutomationRoutes, { prefix: "/api/automations" });
  app.register(registerMonitoringRoutes, { prefix: "/api/monitoring" });

  return app;
}
