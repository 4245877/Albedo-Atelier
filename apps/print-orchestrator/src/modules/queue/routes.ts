import type { FastifyInstance } from "fastify";

import type { NewQueueJobInput } from "../../infra/store/farmStore";
import {
  addQueueJob,
  getNightPrint,
  listQueue,
  pickNightCandidate,
  startNext,
  startNight
} from "./service";

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
  app.get("/", async () => listQueue());

  app.get("/night", async () => getNightPrint());

  app.post<{ Body: NewQueueJobInput }>("/", async (request) => ({
    ok: true,
    job: addQueueJob(request.body ?? {})
  }));

  app.post("/start-next", async () => ({ ok: true, job: startNext() }));

  app.post("/night/start", async () => ({ ok: true, ...startNight() }));

  app.post("/night/pick", async () => ({ ok: true, night: pickNightCandidate() }));
}
