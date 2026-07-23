import { envVar, type EnvSource } from "./registry";

const VARS = {
  /**
   * Shared secret required on state-changing requests (pause/resume/cancel/…).
   * Empty disables the guard — reads stay open either way.
   */
  apiToken: envVar("ORCHESTRATOR_API_TOKEN", "security", (_n, raw) => raw ?? ""),
  /**
   * Cross-origin origins allowed to call the API; empty = same-origin only.
   * Frozen: these gate a security decision (CORS/CSRF) and are only ever read
   * (`.includes`), so a shallow `Object.freeze(env)` alone would still leave the
   * list itself mutable — freeze it too.
   */
  corsAllowOrigins: envVar("CORS_ALLOW_ORIGINS", "security", (_n, raw) =>
    Object.freeze(
      (raw ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    )
  ),
  /**
   * Explicit opt-in that lets MUTATIONS through with NO API token configured.
   * The default is fail-closed: without a token (and without this flag) every
   * state-changing request is refused 503 — "no auth configured" must never
   * silently mean "everyone is authorized".
   */
  allowUnauthenticatedMutations: envVar(
    "ALLOW_UNAUTHENTICATED_MUTATIONS",
    "security",
    (_n, raw) => raw === "1"
  ),
  /**
   * Extra DNS *hostnames* allowed in the Host header (comma-separated). Literal
   * IPs, localhost and the compose service name pass by default; any other DNS
   * name must be allowlisted here — a DNS-rebinding attack needs a name the
   * attacker controls, which will not be on this list.
   */
  allowedHosts: envVar("ALLOWED_HOSTS", "security", (_n, raw) =>
    Object.freeze(
      (raw ?? "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean)
    )
  )
};

/** API auth / CORS / host-allowlist settings. */
export function buildSecurityConfig(source: EnvSource) {
  return {
    apiToken: VARS.apiToken.read(source),
    corsAllowOrigins: VARS.corsAllowOrigins.read(source),
    allowUnauthenticatedMutations: VARS.allowUnauthenticatedMutations.read(source),
    allowedHosts: VARS.allowedHosts.read(source)
  };
}
