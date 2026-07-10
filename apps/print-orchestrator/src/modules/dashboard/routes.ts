import type { FastifyInstance } from "fastify";

import { farmStore } from "../../app/farmStore";

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
  app.get("/dashboard", async () => farmStore.reads.snapshot());

  // Overall service status.
  app.get("/status", async () => farmStore.reads.getService());

  // Materials: filament, resin, mismatches, queue needs.
  app.get("/materials", async () => farmStore.reads.getMaterials());

  // Cameras, projected from the printers that have one.
  app.get("/cameras", async () => farmStore.reads.getCameras());

  // Maintenance schedule per printer.
  app.get("/maintenance", async () => farmStore.reads.getMaintenance());

  // Recent events (live feed). `/events/recent` is a spec alias of `/events`.
  app.get("/events", async () => farmStore.reads.getFeed());
  app.get("/events/recent", async () => farmStore.reads.getFeed());

  // Active print jobs — the printers currently printing or paused.
  app.get("/jobs/active", async () => farmStore.reads.listActivePrinters());

  // Night-print window, candidates and current pick.
  // Spec alias of `/api/queue/night`.
  app.get("/night-print", async () => farmStore.reads.getNight());

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
