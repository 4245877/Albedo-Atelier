import type { FastifyInstance } from "fastify";

import type { FarmCommands, NewQueueJobInput } from "../../app/FarmCommands";
import type { DashboardReadModel } from "../../app/dashboardReadModel";

/** The exact reads + commands the legacy queue adapter needs, passed at registration. */
export interface QueueRoutesOptions {
  reads: Pick<DashboardReadModel, "getQueue" | "getNight">;
  commands: Pick<
    FarmCommands,
    "addQueueJob" | "startNext" | "reviewQueueJob" | "removeQueueJob" | "startNight" | "advanceNightPick"
  >;
}

/**
 * Print queue endpoints under `/api/queue` — a thin **compatibility adapter**,
 * NOT a second queue. Every handler is a one-line delegate to a command method
 * that operates on the canonical SQLite model (`PrintQueueService` /
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
 *   POST   /             add a job (DEPRECATED — no artifact/analysis; upload instead)
 *   POST   /start-next   start the next ready job
 *   POST   /:id/review   park a job in review (stops it blocking start-next)  body: { reason? }
 *   DELETE /:id          remove a job by id
 *   POST   /night/start  launch the recommended night print
 *   POST   /night/pick   advance to the next night candidate
 */
export async function registerQueueRoutes(
  app: FastifyInstance,
  opts: QueueRoutesOptions
): Promise<void> {
  const { reads, commands } = opts;

  app.get("/", async () => reads.getQueue());

  app.get("/night", async () => reads.getNight());

  /**
   * **Deprecated.** Creates a task from a *typed* file name that is supposed to
   * already exist on a printer — no artifact, no content hash, no analysis, and
   * therefore no way for anything downstream to check that what starts is what
   * was inspected. It is a second job lifecycle running beside the real one
   * (upload → analyse → slice/enqueue → launch), and the dashboard no longer
   * offers it: «Добавить задание» goes to the upload section.
   *
   * Kept working, not deleted: external callers may still use it, and a good
   * deal of the test suite builds fixtures through it. The `Deprecation` header
   * (RFC 8594) is how a client finds out without anything breaking.
   */
  app.post<{ Body: NewQueueJobInput }>("/", async (request, reply) => {
    reply.header("Deprecation", "true");
    reply.header("Link", '</api/print/artifacts>; rel="successor-version"');
    reply.header(
      "Warning",
      '299 - "POST /api/queue creates a task with no artifact or analysis; upload the file instead"'
    );
    return { ok: true, job: commands.addQueueJob(request.body ?? {}) };
  });

  app.post("/start-next", async () => {
    const { job, printer } = await commands.startNext();
    return { ok: true, job, printer };
  });

  // Unblock a queue wedged by a first `ready` job that can never start: the
  // operator can park it for review or drop it outright. Both are mutating, so
  // the CSRF/origin + API-token guard in http/security already covers them.
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/:id/review",
    async (request) => {
      const reason = typeof request.body?.reason === "string" ? request.body.reason : undefined;
      return { ok: true, job: commands.reviewQueueJob(request.params.id, reason) };
    }
  );

  app.delete<{ Params: { id: string } }>("/:id", async (request) => ({
    ok: true,
    job: commands.removeQueueJob(request.params.id)
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
    return { ok: true, ...(await commands.startNight(preview)) };
  });

  app.post("/night/pick", async () => ({ ok: true, night: commands.advanceNightPick() }));
}
