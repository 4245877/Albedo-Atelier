import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { env } from "../shared/env";

// Requests that change farm state and therefore require the API token when one
// is configured. Reads (GET/HEAD) and preflight (OPTIONS) are always allowed —
// except the one side-effectful GET (camera.jpg?ensureLight=1), gated in its
// route via isRequestAuthorized.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Host names that are always acceptable without configuration. */
const BUILTIN_HOSTS = new Set(["localhost", "print-orchestrator"]);

/** A literal IPv4/IPv6 host (rebinding needs a DNS *name*, so literals pass). */
const IP_HOST_RE = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i;

/**
 * The control-plane guard stack, fail-closed by default:
 *
 * 1. **Host allowlist** (anti DNS-rebinding). A rebinding attack reaches the
 *    service with the attacker's DNS name in `Host`; the service is only ever
 *    legitimately addressed by a literal IP, `localhost`, its compose service
 *    name, or a hostname the operator explicitly allowlisted (`ALLOWED_HOSTS`).
 *    Anything else is refused for EVERY method — reads leak state too.
 * 2. **CORS** (allowlisted, no wildcard) + browser CSRF Origin check and a
 *    `Sec-Fetch-Site: cross-site` refusal on mutations.
 * 3. **Shared-secret guard**: with `ORCHESTRATOR_API_TOKEN` set, mutations must
 *    carry it. With NO token configured, mutations are refused 503 — unless the
 *    operator explicitly opted in via `ALLOW_UNAUTHENTICATED_MUTATIONS=1`
 *    (e.g. an isolated dev VLAN). "Not configured" never means "open".
 * 4. **Security headers** on every response: `X-Frame-Options: DENY`,
 *    `Content-Security-Policy: frame-ancestors 'none'` (the API is never
 *    framed), `X-Content-Type-Options: nosniff`, `Referrer-Policy`.
 *
 * Client-supplied proxy headers (X-Forwarded-*) are deliberately NOT consulted
 * for any trust decision — there is no trusted-proxy configuration, so they
 * are attacker-controlled.
 */
export function registerSecurity(app: FastifyInstance): void {
  if (!env.apiToken && !env.allowUnauthenticatedMutations) {
    app.log.warn(
      "ORCHESTRATOR_API_TOKEN is not set — state-changing requests are REFUSED (fail-closed). " +
        "Set the token, or explicitly opt in with ALLOW_UNAUTHENTICATED_MUTATIONS=1 on an isolated network."
    );
  } else if (!env.apiToken) {
    app.log.warn(
      "ALLOW_UNAUTHENTICATED_MUTATIONS=1 — printer control actions are unauthenticated; keep this service on a trusted, isolated network"
    );
  }

  app.addHook("onRequest", (request, reply, done) => {
    applySecurityHeaders(reply);
    applyCors(request, reply);

    if (!isAllowedHost(request)) {
      reply.code(403).send({
        error: {
          code: "FORBIDDEN_HOST",
          message: "Запрос с этим Host не разрешён (защита от DNS rebinding) — добавьте имя в ALLOWED_HOSTS"
        }
      });
      return;
    }

    if (request.method === "OPTIONS") {
      reply.code(204).send();
      return;
    }

    if (MUTATING_METHODS.has(request.method)) {
      if (!isTrustedOrigin(request) || isCrossSiteFetch(request)) {
        reply.code(403).send({
          error: {
            code: "FORBIDDEN_ORIGIN",
            message: "Запрос с этого Origin не разрешён (защита от CSRF)"
          }
        });
        return;
      }

      if (!env.apiToken) {
        if (!env.allowUnauthenticatedMutations) {
          reply.code(503).send({
            error: {
              code: "AUTH_NOT_CONFIGURED",
              message:
                "Аутентификация не настроена — изменения запрещены. Задайте ORCHESTRATOR_API_TOKEN " +
                "(или явно ALLOW_UNAUTHENTICATED_MUTATIONS=1 в изолированной сети)"
            }
          });
          return;
        }
      } else if (!isRequestAuthorized(request)) {
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
 * Host-header allowlist. Literal IPs (with optional port), localhost, the
 * compose service name and operator-allowlisted names pass; every other DNS
 * name — the only kind a rebinding attacker can present — is refused. A
 * missing/malformed Host is refused too (fail-closed).
 */
export function isAllowedHost(request: FastifyRequest): boolean {
  const raw = request.headers.host;
  if (typeof raw !== "string" || raw.trim() === "") return false;
  const host = stripPort(raw.trim().toLowerCase());
  if (!host) return false;
  if (BUILTIN_HOSTS.has(host)) return true;
  if (IP_HOST_RE.test(host)) return true;
  return env.allowedHosts.includes(host);
}

/** `host[:port]` → `host` (IPv6 literal keeps its brackets for the regex). */
function stripPort(value: string): string {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? "" : value.slice(0, end + 1);
  }
  return value.split(":", 1)[0] ?? "";
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
 * Modern-browser second belt: `Sec-Fetch-Site: cross-site` on a mutation is a
 * cross-site request whatever the Origin header claims. Absent header (older
 * browsers, curl, server-to-server) passes — the Origin/token checks still apply.
 */
export function isCrossSiteFetch(request: FastifyRequest): boolean {
  const site = request.headers["sec-fetch-site"];
  return typeof site === "string" && site.toLowerCase() === "cross-site";
}

/**
 * True when the shared-secret guard is satisfied: the request carries the valid
 * token. With no token configured this returns true ONLY when the explicit
 * unauthenticated opt-in is set — side-effectful reads (camera.jpg?ensureLight=1)
 * use this too and must not silently open up.
 */
export function isRequestAuthorized(request: FastifyRequest): boolean {
  if (!env.apiToken) return env.allowUnauthenticatedMutations;
  return hasValidToken(request);
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

function applySecurityHeaders(reply: FastifyReply): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Content-Security-Policy", "frame-ancestors 'none'");
  reply.header("Referrer-Policy", "no-referrer");
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
