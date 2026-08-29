import type { FastifyInstance } from "fastify";

import type { FarmCommands } from "../../app/FarmCommands";

/** The commands the monitoring routes call; passed in explicitly at registration. */
export interface MonitoringRoutesOptions {
  commands: Pick<
    FarmCommands,
    | "renewMonitoringLease"
    | "filamentQueueStats"
    | "listFilamentDebts"
    | "acknowledgeFilamentDebt"
    | "settleFilamentDebt"
  >;
}

/**
 * Active-monitoring lease, registered under `/api/monitoring`.
 *
 *   POST /lease — create or extend the farm-wide "operator is watching" lease.
 *
 *   GET /filament-queue — filament-deduction retry-queue metrics: backlog size
 *   and the per-reason counters of finally-dropped deductions.
 *
 *   GET  /filament-debts          outstanding deductions the warehouse never applied
 *   POST /filament-debts/:id/settle       post the debt's measured deduction now
 *   POST /filament-debts/:id/acknowledge  mark it settled outside the system
 *
 * The debts read is deliberately here rather than folded into `/api/dashboard`:
 * it is an operator worklist, not a board tile, and it must stay readable when
 * the warehouse is down — which is exactly when debts accumulate.
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

  app.get("/filament-debts", async () => ({ items: commands.listFilamentDebts() }));

  // Settling re-posts the ORIGINAL payload (same idempotency key), so a debt for
  // a delivery that had in fact landed answers `duplicate` on fulfillment's side
  // and moves nothing. A refusal leaves the debt standing with the new reason —
  // a debt that vanishes on a failed settlement is the drift this prevents.
  app.post("/filament-debts/:id/settle", async (req, reply) => {
    const { id } = req.params as { id: string };
    // `grams` is the operator stating a figure for a print nothing could
    // measure (an external spool with no tray_weight). Absent: settle the
    // measured deduction the debt already carries.
    const body = (req.body ?? {}) as { grams?: unknown };
    const grams = body.grams === undefined || body.grams === null ? undefined : Number(body.grams);
    if (grams !== undefined && !Number.isFinite(grams)) {
      reply.code(400);
      return { settled: false, reason: "grams должно быть числом" };
    }
    const result = await commands.settleFilamentDebt(id, grams);
    if (!result.settled) reply.code(409);
    return result;
  });

  app.post("/filament-debts/:id/acknowledge", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = commands.acknowledgeFilamentDebt(id);
    if (!result.cleared) reply.code(404);
    return result;
  });
}
