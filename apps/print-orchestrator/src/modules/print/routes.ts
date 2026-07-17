import type { FastifyInstance } from "fastify";

import { farmStore } from "../../app/farmStore";
import type { CreateTaskInput } from "../../app/printQueue/printQueueService";
import { ValidationError } from "../../core/errors";

/**
 * The persistent print-queue API under `/api/print` — the surface for the new
 * SQLite-backed model. It sits alongside the legacy `/api/queue` (which still
 * drives the existing dashboard and remote dispatch) rather than replacing it;
 * this stage introduces the durable backbone, and a later stage makes it
 * authoritative.
 *
 * Reads:
 *   GET  /tasks         all tasks (any state; launched tasks are never deleted)
 *   GET  /tasks/:id     one task with its full chain (assignments → runs) + audit
 *   GET  /queue         the open queue projected into the legacy job shape
 *   GET  /audit         recent audit events
 *
 * Actions (guarded by the shared CSRF/token middleware like every mutation):
 *   POST /tasks              create a task           body: { title, printer?, material?, file?, night?, priority?, eta?, at? }
 *   POST /tasks/:id/hold     park for review         body: { reason? }
 *   POST /tasks/:id/release  return to the queue
 *   POST /tasks/:id/cancel   cancel (kept as history) body: { reason? }
 *   POST /tasks/:id/assign   bind to a printer        body: { printer }
 */
export async function registerPrintQueueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks", async () => ({ tasks: farmStore.printQueue.listTasks() }));

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request) =>
    farmStore.printQueue.getTaskDetail(request.params.id)
  );

  app.get("/queue", async () => ({ queue: farmStore.printQueue.projectLegacyQueue() }));

  app.get<{ Querystring: { limit?: string } }>("/audit", async (request) => {
    const limit = Number.parseInt(request.query.limit ?? "", 10);
    return { events: farmStore.printQueue.listAudit(Number.isFinite(limit) ? limit : undefined) };
  });

  app.post<{ Body: unknown }>("/tasks", async (request) => ({
    ok: true,
    task: farmStore.printQueue.createTask(shapeCreateInput(request.body))
  }));

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/tasks/:id/hold",
    async (request) => ({
      ok: true,
      task: farmStore.printQueue.holdTask(request.params.id, optionalString(request.body?.reason))
    })
  );

  app.post<{ Params: { id: string } }>("/tasks/:id/release", async (request) => ({
    ok: true,
    task: farmStore.printQueue.releaseTask(request.params.id)
  }));

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/tasks/:id/cancel",
    async (request) => ({
      ok: true,
      task: farmStore.printQueue.cancelTask(request.params.id, optionalString(request.body?.reason))
    })
  );

  app.post<{ Params: { id: string }; Body: { printer?: unknown } }>(
    "/tasks/:id/assign",
    async (request) => {
      const printer = optionalString(request.body?.printer);
      if (!printer) throw new ValidationError("Поле «printer» обязательно");
      return { ok: true, assignment: farmStore.printQueue.assignTask(request.params.id, printer) };
    }
  );
}

/** A trimmed non-empty string, or undefined — the shape the service expects. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Narrows an untrusted request body into {@link CreateTaskInput}. `title` is
 * left for the service to validate (it raises the operator-facing error); every
 * other field is coerced to its expected type or dropped.
 */
function shapeCreateInput(body: unknown): CreateTaskInput {
  const source = (body ?? {}) as Record<string, unknown>;
  const input: CreateTaskInput = {
    title: typeof source.title === "string" ? source.title : ""
  };
  const printer = optionalString(source.printer);
  if (printer) input.printer = printer;
  const material = optionalString(source.material);
  if (material) input.material = material;
  const file = optionalString(source.file);
  if (file) input.file = file;
  const eta = optionalString(source.eta);
  if (eta) input.eta = eta;
  const at = optionalString(source.at);
  if (at) input.at = at;
  if (source.night === true) input.night = true;
  if (typeof source.priority === "number" && Number.isFinite(source.priority)) {
    input.priority = source.priority;
  }
  return input;
}
