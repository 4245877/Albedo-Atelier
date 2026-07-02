import type { FastifyInstance } from "fastify";

import { farmStore, type NewQueueJobInput } from "../../infra/store/farmStore";

/**
 * Print queue endpoints under `/api/queue`.
 *
 * Reads:
 *   GET  /               the queue
 *   GET  /night          night-print window + candidates + current pick
 *
 * Actions:
 *   POST /               add a job          body: { title, printer?, material?, eta?, at?, night? }
 *   POST /start-next     start the next ready job
 *   POST /night/start    launch the recommended night print
 *   POST /night/pick     advance to the next night candidate
 */
export async function registerQueueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => farmStore.getQueue());

  app.get("/night", async () => farmStore.getNight());

  app.post<{ Body: NewQueueJobInput }>("/", async (request) => ({
    ok: true,
    job: farmStore.addQueueJob(request.body ?? {})
  }));

  app.post("/start-next", async () => ({ ok: true, job: farmStore.startNext() }));

  app.post("/night/start", async () => ({ ok: true, ...farmStore.startNight() }));

  app.post("/night/pick", async () => ({ ok: true, night: farmStore.advanceNightPick() }));
}
