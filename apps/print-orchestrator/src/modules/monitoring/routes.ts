import type { FastifyInstance } from "fastify";

import { farmStore as defaultFarmStore } from "../../app/farmStore";

/** The farm facade the routes call; injectable so the HTTP layer is testable. */
export type MonitoringRoutesStore = typeof defaultFarmStore;

export interface MonitoringRoutesOptions {
  store?: MonitoringRoutesStore;
}

/**
 * Active-monitoring lease, registered under `/api/monitoring`.
 *
 *   POST /lease — create or extend the farm-wide "operator is watching" lease.
 *
 * The dashboard calls it every ~30 s while its tab is visible; the lease
 * expires by itself (no release endpoint), so a closed tab or a backend
 * restart safely returns the lights to the schedule. A POST, deliberately not
 * a side effect of any camera/image read (the nginx proxy keeps blocking
 * `camera.jpg?ensureLight=1`), and protected exactly like every other mutating
 * endpoint by the global security hook (CSRF origin check + API token).
 */
export async function registerMonitoringRoutes(
  app: FastifyInstance,
  opts: MonitoringRoutesOptions = {}
): Promise<void> {
  const farmStore = opts.store ?? defaultFarmStore;

  app.post("/lease", async () => farmStore.renewMonitoringLease());
}
