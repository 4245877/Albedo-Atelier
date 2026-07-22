import type { FastifyInstance } from "fastify";

import type { FarmCommands } from "../../app/FarmCommands";

/** The commands the monitoring routes call; passed in explicitly at registration. */
export interface MonitoringRoutesOptions {
  commands: Pick<FarmCommands, "renewMonitoringLease" | "filamentQueueStats">;
}

/**
 * Active-monitoring lease, registered under `/api/monitoring`.
 *
 *   POST /lease — create or extend the farm-wide "operator is watching" lease.
 *
 *   GET /filament-queue — filament-deduction retry-queue metrics: backlog size
 *   and the per-reason counters of finally-dropped deductions.
 *
 * The dashboard calls the lease every ~30 s while its tab is visible; the lease
 * expires by itself (no release endpoint), so a closed tab or a backend
 * restart safely returns the lights to the schedule. A POST, deliberately not
 * a side effect of any camera/image read (the nginx proxy keeps blocking
 * `camera.jpg?ensureLight=1`), and protected exactly like every other mutating
 * endpoint by the global security hook (CSRF origin check + API token).
 */
export async function registerMonitoringRoutes(
  app: FastifyInstance,
  opts: MonitoringRoutesOptions
): Promise<void> {
  const { commands } = opts;

  app.post("/lease", async () => commands.renewMonitoringLease());

  app.get("/filament-queue", async () => commands.filamentQueueStats());
}
