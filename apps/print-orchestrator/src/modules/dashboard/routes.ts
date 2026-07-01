import type { FastifyInstance } from "fastify";

import { farmStore } from "../../infra/store/farmStore";

/**
 * Read-only dashboard endpoints, registered under `/api`. Each returns the
 * exact JSON shape the frontend renders, so the dashboard needs no extra
 * processing. `GET /api/dashboard` returns the whole board in one payload;
 * the rest are per-section slices for finer-grained polling or other clients.
 *
 * Resources that also accept actions (printers, queue, automations) live in
 * their own modules.
 */
export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  // Whole board in one call — mirrors the frontend `state` object.
  app.get("/dashboard", async () => farmStore.snapshot());

  // Overall service status.
  app.get("/status", async () => farmStore.getService());

  // Materials: filament, resin, mismatches, queue needs.
  app.get("/materials", async () => farmStore.getMaterials());

  // Cameras, projected from the printers that have one.
  app.get("/cameras", async () => farmStore.getCameras());

  // Maintenance schedule per printer.
  app.get("/maintenance", async () => farmStore.getMaintenance());

  // Recent events (live feed). `/events/recent` is a spec alias of `/events`.
  app.get("/events", async () => farmStore.getFeed());
  app.get("/events/recent", async () => farmStore.getFeed());

  // Active print jobs — the printers currently printing or paused.
  app.get("/jobs/active", async () => farmStore.listActivePrinters());

  // Night-print window, candidates and current pick.
  // Spec alias of `/api/queue/night`.
  app.get("/night-print", async () => farmStore.getNight());

  // Critical events for today.
  app.get("/critical", async () => farmStore.getCritical());

  // Warnings that need attention.
  app.get("/warnings", async () => farmStore.getWarnings());

  // System component status.
  app.get("/system", async () => farmStore.getSystem());

  // Today's throughput counters.
  app.get("/today", async () => farmStore.getToday());

  // Farm performance / load.
  app.get("/performance", async () => farmStore.getPerformance());

  // Upcoming plan.
  app.get("/plan", async () => farmStore.getPlan());
}
