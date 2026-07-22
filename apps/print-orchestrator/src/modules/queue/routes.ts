import type { FastifyInstance } from "fastify";

import { farmStore, type NewQueueJobInput } from "../../app/farmStore";

/**
 * Print queue endpoints under `/api/queue` — a thin **compatibility adapter**,
 * NOT a second queue. Every handler is a one-line delegate to a `farmStore`
 * method that operates on the canonical SQLite model (`PrintQueueService` /
 * `DispatchService`) exactly as the scheduler API (`/api/print/scheduler`) does:
 * same tasks, same order, same lifecycle. The reads it serves are legacy-shape
 * *projections* of that model (`projectLegacyQueue` for the queue,
 * `nightPlanner` projecting the canonical `evaluateDispatchGate` for the night
 * section) — there is no independent queue state, DTO source or rule set here.
 *
 * Kept because the main dashboard's simplified queue/night section still drives
 * these paths (add job, start-next, night start/pick) and external clients may
 * too. Removal condition: retire once the dashboard's quick actions move to
 * `/api/print/scheduler` (+ a dispatch endpoint there) and no external caller
 * depends on `/api/queue`; the reads (`GET /`, `GET /night`) are already served
 * to the dashboard via `/api/dashboard`, and `DELETE /:id` + `/:id/review` are
 * operator escape hatches with no scheduler equivalent yet.
 *
 * Reads:
 *   GET  /               the queue (projection of the SQLite model)
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

  // The body carries the immutable preview identity the operator confirmed
  // (taskId + taskVersion + artifact hash from GET /night). Drift between the
  // preview and this call — queue change, task edit, re-analysis, file change —
  // answers 409 PREVIEW_CONFLICT instead of starting something unseen. A
  // body-less call (legacy client) still re-validates everything server-side.
  app.post<{
    Body: { taskId?: unknown; expectedTaskVersion?: unknown; artifactSha256?: unknown };
  }>("/night/start", async (request) => {
    const body = request.body ?? {};
    const preview: {
      taskId?: string;
      expectedTaskVersion?: number;
      artifactSha256?: string | null;
    } = {};
    if (typeof body.taskId === "string" && body.taskId.trim()) preview.taskId = body.taskId.trim();
    if (typeof body.expectedTaskVersion === "number" && Number.isFinite(body.expectedTaskVersion)) {
      preview.expectedTaskVersion = body.expectedTaskVersion;
    }
    if (typeof body.artifactSha256 === "string") preview.artifactSha256 = body.artifactSha256;
    else if (body.artifactSha256 === null) preview.artifactSha256 = null;
    return { ok: true, ...(await farmStore.startNight(preview)) };
  });

  app.post("/night/pick", async () => ({ ok: true, night: farmStore.advanceNightPick() }));
}
