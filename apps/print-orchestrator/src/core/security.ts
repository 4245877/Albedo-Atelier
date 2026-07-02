import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { env } from "../shared/env";

// Requests that change farm state and therefore require the API token when one
// is configured. Reads (GET/HEAD) and preflight (OPTIONS) are always allowed.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CORS and a shared-secret guard for the control API.
 *
 * The dashboard is normally same-origin — nginx serves the page and proxies
 * `/api/print-orchestrator/*` to this service — so CORS is closed by default:
 * no `Access-Control-Allow-Origin` is emitted unless the caller's Origin is in
 * the `CORS_ALLOW_ORIGINS` allowlist. This replaces the previous wildcard `*`,
 * which let any web page in the browser drive the printers cross-origin.
 *
 * When `ORCHESTRATOR_API_TOKEN` is set, every state-changing request must carry
 * it as `Authorization: Bearer <token>` (or `X-Api-Token`). Reads and health
 * checks stay open. When it is unset the guard is disabled and a warning is
 * logged, because otherwise pause/resume/cancel are callable by anyone who can
 * reach the service.
 */
export function registerSecurity(app: FastifyInstance): void {
  if (!env.apiToken) {
    app.log.warn(
      "ORCHESTRATOR_API_TOKEN is not set — printer control actions are unauthenticated; keep this service on a trusted network"
    );
  }

  app.addHook("onRequest", (request, reply, done) => {
    applyCors(request, reply);

    if (request.method === "OPTIONS") {
      reply.code(204).send();
      return;
    }

    if (env.apiToken && MUTATING_METHODS.has(request.method) && !hasValidToken(request)) {
      reply
        .code(401)
        .header("WWW-Authenticate", "Bearer")
        .send({ error: { code: "UNAUTHORIZED", message: "Valid API token required" } });
      return;
    }

    done();
  });
}

function applyCors(request: FastifyRequest, reply: FastifyReply): void {
  reply.header("Vary", "Origin");

  const origin = request.headers.origin;
  if (typeof origin !== "string" || !env.corsAllowOrigins.includes(origin)) {
    return;
  }

  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Token");
  reply.header("Access-Control-Max-Age", "600");
}

function hasValidToken(request: FastifyRequest): boolean {
  const header = request.headers.authorization;
  const bearer =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : "";

  const apiTokenHeader = request.headers["x-api-token"];
  const provided = bearer || (typeof apiTokenHeader === "string" ? apiTokenHeader.trim() : "");

  return provided.length > 0 && safeEqual(provided, env.apiToken);
}

/** Constant-time string comparison; length mismatch short-circuits to false. */
function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}
