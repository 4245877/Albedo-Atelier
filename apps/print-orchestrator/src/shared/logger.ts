import { env } from "./env";

/**
 * Header names whose values must never reach the logs. Kept as a list so the
 * `headers.*` and Pino-serialized `req.headers.*` redaction paths stay in sync.
 */
const SECRET_HEADERS = ["authorization", "cookie", "set-cookie", "x-api-token", "x-service-token"];

/** `["authorization", …]` → `['headers["authorization"]', 'req.headers["authorization"]', …]`. */
function redactionPaths(headers: readonly string[]): string[] {
  const shapes = ["headers", "req.headers", "request.headers"];
  return shapes.flatMap((shape) => headers.map((name) => `${shape}["${name}"]`));
}

/**
 * Fastify/Pino logger configuration. `level` is validated at config read
 * (see {@link env.logLevel} / readLogLevel), so an unknown level fails fast with
 * a clear message instead of crashing Pino later at startup.
 *
 * `redact` is defence-in-depth: nothing in the service logs request headers
 * today, but if a header object is ever logged — a custom serializer, an
 * `{ err }` that carries a request, an explicit `{ headers }` — the
 * credential-bearing ones (the shared API token, the inter-service token,
 * cookies) must be censored rather than written in the clear.
 */
export const loggerConfig = {
  level: env.logLevel,
  redact: {
    paths: redactionPaths(SECRET_HEADERS),
    censor: "[redacted]"
  }
};

/**
 * The minimal structural logger the application services and stores accept.
 * Fastify's request/app logger satisfies it; tests pass `{}` or a recorder.
 * Every method is optional so a collaborator can be built before the real
 * logger exists (e.g. the state store loads during construction).
 */
export type StoreLogger = {
  info?: (obj: unknown, message?: string) => void;
  warn?: (obj: unknown, message?: string) => void;
  error?: (obj: unknown, message?: string) => void;
};
