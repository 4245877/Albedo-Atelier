/**
 * Build identity for `GET /version`.
 *
 * Answers the question a deploy could not previously answer at all: *which code
 * is actually running right now?* Images carried no revision label, there was no
 * endpoint, and `deploy.sh` recorded the commit being deployed under a field
 * named for the commit a rollback returns to — so a partial deploy (orchestrator
 * updated, dashboard not) was invisible while every health check stayed green.
 *
 * The values are baked in at build time as ARG → ENV in the Dockerfile. A local
 * `pnpm dev` run has none of them, which is reported honestly as "unknown"
 * rather than faked.
 */
export interface VersionResponse {
  service: string;
  /** Full git SHA the image was built from, or "unknown" outside a real build. */
  revision: string;
  /** Short SHA, for logs and operator output. */
  revisionShort: string;
  /** ISO-8601 build timestamp, or null. */
  builtAt: string | null;
  /** package.json version. */
  version: string;
  /** True when the working tree had uncommitted changes at build time. */
  dirty: boolean;
  startedAt: string;
  uptimeSeconds: number;
}

const STARTED_AT = new Date().toISOString();

export function getVersion(serviceName: string, appVersion: string): VersionResponse {
  const revision = process.env.GIT_COMMIT?.trim() || "unknown";
  const builtAt = process.env.BUILD_TIME?.trim() || null;
  return {
    service: serviceName,
    revision,
    revisionShort: revision === "unknown" ? "unknown" : revision.slice(0, 12),
    builtAt,
    version: appVersion,
    dirty: process.env.GIT_DIRTY === "1",
    startedAt: STARTED_AT,
    uptimeSeconds: Math.round(process.uptime())
  };
}
