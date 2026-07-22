import type { FastifyInstance } from "fastify";

import type { DashboardReadModel } from "../../app/dashboardReadModel";

/** The read model the dashboard routes project; passed in explicitly at registration. */
export interface DashboardRoutesOptions {
  reads: DashboardReadModel;
}

/**
 * Read-only dashboard endpoints, registered under `/api`. Each returns the
 * exact JSON shape the frontend renders, so the dashboard needs no extra
 * processing. `GET /api/dashboard` returns the whole board in one payload;
 * the rest are per-section slices for finer-grained polling or other clients.
 *
 * Resources that also accept actions (printers, queue, automations) live in
 * their own modules. The canonical event/night/active-printer routes are
 * `/api/events`, `/api/queue/night` and `/api/printers/active`; the historical
 * spec aliases (`/events/recent`, `/night-print`, `/jobs/active`) duplicated
 * them 1:1, were called by nothing, and have been removed.
 */
export async function registerDashboardRoutes(
  app: FastifyInstance,
  opts: DashboardRoutesOptions
): Promise<void> {
  const { reads } = opts;

  // Whole board in one call — mirrors the frontend `state` object.
  app.get("/dashboard", async () => reads.snapshot());

  // Overall service status.
  app.get("/status", async () => reads.getService());

  // Materials: filament, resin, mismatches, queue needs.
  app.get("/materials", async () => reads.getMaterials());

  // Cameras, projected from the printers that have one.
  app.get("/cameras", async () => reads.getCameras());

  // Maintenance schedule per printer.
  app.get("/maintenance", async () => reads.getMaintenance());

  // Recent events (live feed).
  app.get("/events", async () => reads.getFeed());

  // Critical events for today.
  app.get("/critical", async () => reads.getCritical());

  // Warnings that need attention.
  app.get("/warnings", async () => reads.getWarnings());

  // System component status.
  app.get("/system", async () => reads.getSystem());

  // Today's throughput counters.
  app.get("/today", async () => reads.getToday());

  // Farm performance / load.
  app.get("/performance", async () => reads.getPerformance());

  // Upcoming plan.
  app.get("/plan", async () => reads.getPlan());
}
