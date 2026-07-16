import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { env } from "../shared/env";

// Requests that change farm state and therefore require the API token when one
// is configured. Reads (GET/HEAD) and preflight (OPTIONS) are always allowed —
// except the one side-effectful GET (camera.jpg?ensureLight=1), gated in its
// route via isRequestAuthorized.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CORS, a browser CSRF guard and a shared-secret guard for the control API.
 *
 * The dashboard is normally same-origin — nginx serves the page and proxies
 * `/api/print-orchestrator/*` to this service — so CORS is closed by default:
 * no `Access-Control-Allow-Origin` is emitted unless the caller's Origin is in
 * the `CORS_ALLOW_ORIGINS` allowlist.
 *
 * CORS alone is NOT CSRF protection: it only stops the attacker's page from
 * *reading* the response, while a simple no-body POST (pause/resume/cancel)
 * still executes. So every state-changing request with an `Origin` header is
 * additionally verified against the request's own Host (same-origin через the
 * nginx proxy) or the allowlist, and refused with 403 otherwise. Requests
 * without an Origin (curl, fulfillment server-to-server) are not a browser
 * CSRF vector and pass this check; the token guard below still applies.
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

    if (MUTATING_METHODS.has(request.method)) {
      if (!isTrustedOrigin(request)) {
        reply.code(403).send({
          error: {
            code: "FORBIDDEN_ORIGIN",
            message: "Запрос с этого Origin не разрешён (защита от CSRF)"
          }
        });
        return;
      }

      if (!isRequestAuthorized(request)) {
        reply
          .code(401)
          .header("WWW-Authenticate", "Bearer")
          .send({ error: { code: "UNAUTHORIZED", message: "Valid API token required" } });
        return;
      }
    }

    done();
  });
}

/**
 * Browser CSRF guard: a state-changing request that carries an `Origin` header
 * must originate from the API's own origin (the nginx-proxied dashboard — its
 * Origin host equals the request's Host) or from an allowlisted cross-origin
 * client. Non-browser clients send no Origin and pass. `Origin: null`
 * (sandboxed iframes, some redirects) is refused — it is never the dashboard.
 */
export function isTrustedOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  if (env.corsAllowOrigins.includes(origin)) return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes "null" and malformed values
  }

  const host = request.headers.host;
  return typeof host === "string" && parsed.host.toLowerCase() === host.trim().toLowerCase();
}

/**
 * True when the shared-secret guard is satisfied: no token is configured, or
 * the request carries the valid one. Used by the hook for mutating methods and
 * by side-effectful reads (camera.jpg?ensureLight=1) in their routes.
 */
export function isRequestAuthorized(request: FastifyRequest): boolean {
  return !env.apiToken || hasValidToken(request);
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

/** Constant-time string comparison; length mismatch short-circuits to false. */
function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}
