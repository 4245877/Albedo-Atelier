import type { FastifyInstance } from "fastify";

import { farmStore } from "../../app/farmStore";
import type { NewQueueJobInput } from "../../app/queueStore";

/**
 * Print queue endpoints under `/api/queue`.
 *
 * Reads:
 *   GET  /               the queue
 *   GET  /night          night-print window + candidates + current pick
 *
 * Actions:
 *   POST   /             add a job          body: { title, printer?, material?, eta?, at?, night? }
 *   POST   /start-next   start the next ready job
 *   POST   /:id/review   park a job in review (stops it blocking start-next)  body: { reason? }
 *   DELETE /:id          remove a job by id
 *   POST   /night/start  launch the recommended night print
 *   POST   /night/pick   advance to the next night candidate
 */
export async function registerQueueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => farmStore.reads.getQueue());

  app.get("/night", async () => farmStore.reads.getNight());

  app.post<{ Body: NewQueueJobInput }>("/", async (request) => ({
    ok: true,
    job: farmStore.addQueueJob(request.body ?? {})
  }));

  app.post("/start-next", async () => {
    const { job, printer } = await farmStore.startNext();
    return { ok: true, job, printer };
  });

  // Unblock a queue wedged by a first `ready` job that can never start: the
  // operator can park it for review or drop it outright. Both are mutating, so
  // the CSRF/origin + API-token guard in http/security already covers them.
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/:id/review",
    async (request) => {
      const reason = typeof request.body?.reason === "string" ? request.body.reason : undefined;
      return { ok: true, job: farmStore.reviewQueueJob(request.params.id, reason) };
    }
  );

  app.delete<{ Params: { id: string } }>("/:id", async (request) => ({
    ok: true,
    job: farmStore.removeQueueJob(request.params.id)
  }));

  app.post("/night/start", async () => ({ ok: true, ...(await farmStore.startNight()) }));

  app.post("/night/pick", async () => ({ ok: true, night: farmStore.advanceNightPick() }));
}
