import type { FastifyInstance } from "fastify";

import { farmStore as defaultFarmStore } from "../../app/farmStore";

/** The farm facade the routes read from; injectable so the HTTP layer is testable. */
export type DashboardRoutesStore = typeof defaultFarmStore;

export interface DashboardRoutesOptions {
  store?: DashboardRoutesStore;
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
  opts: DashboardRoutesOptions = {}
): Promise<void> {
  const farmStore = opts.store ?? defaultFarmStore;

  // Whole board in one call — mirrors the frontend `state` object.
  app.get("/dashboard", async () => farmStore.reads.snapshot());

  // Overall service status.
  app.get("/status", async () => farmStore.reads.getService());

  // Materials: filament, resin, mismatches, queue needs.
  app.get("/materials", async () => farmStore.reads.getMaterials());

  // Cameras, projected from the printers that have one.
  app.get("/cameras", async () => farmStore.reads.getCameras());

  // Maintenance schedule per printer.
  app.get("/maintenance", async () => farmStore.reads.getMaintenance());

  // Recent events (live feed).
  app.get("/events", async () => farmStore.reads.getFeed());

  // Critical events for today.
  app.get("/critical", async () => farmStore.reads.getCritical());

  // Warnings that need attention.
  app.get("/warnings", async () => farmStore.reads.getWarnings());

  // System component status.
  app.get("/system", async () => farmStore.reads.getSystem());

  // Today's throughput counters.
  app.get("/today", async () => farmStore.reads.getToday());

  // Farm performance / load.
  app.get("/performance", async () => farmStore.reads.getPerformance());

  // Upcoming plan.
  app.get("/plan", async () => farmStore.reads.getPlan());
}
