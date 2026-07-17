import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";

import { farmStore } from "../../app/farmStore";
import type { CreateTaskInput } from "../../app/printQueue/printQueueService";
import { ValidationError } from "../../core/errors";
import { uploads } from "../../shared/env";
import { registerSlicingRoutes } from "./slicingRoutes";

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
 *
 * Uploads (the new SQLite-only file-analysis surface; see modules/print):
 *   GET  /artifacts              list uploaded artifacts (+ latest analysis, draft task)
 *   GET  /artifacts/:id          one artifact with its analyses + audit
 *   GET  /artifacts/config       upload limits for the dashboard
 *   POST /artifacts              multipart upload of one file → Artifact + DRAFT task + pending analysis
 *   POST /artifacts/:id/analyze  re-run analysis (after a failed attempt)
 */
export async function registerPrintQueueRoutes(app: FastifyInstance): Promise<void> {
  // Scoped to this plugin: multipart is only for the upload route. One file per
  // request (accurate per-file progress on the client), streamed — never
  // buffered — with the configured single-file size limit enforced by the plugin.
  await app.register(fastifyMultipart, {
    limits: { fileSize: uploads.maxFileBytes, files: 1, fields: 8 }
  });

  registerArtifactRoutes(app);
  registerSlicingRoutes(app);

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

/**
 * The `/api/print/artifacts` upload + analysis surface. Kept separate from the
 * task/queue routes above but on the same plugin, so the shared CSRF/token guard
 * covers the mutations (upload, re-analyze) exactly like every other action.
 * These never touch `/api/queue` or `state.json`.
 */
function registerArtifactRoutes(app: FastifyInstance): void {
  app.get("/artifacts", async () => ({ artifacts: farmStore.artifacts.listArtifacts() }));

  app.get("/artifacts/config", async () => ({
    maxFileBytes: uploads.maxFileBytes,
    maxFiles: uploads.maxFiles,
    maxTotalBytes: uploads.maxTotalBytes,
    acceptedExtensions: [".stl", ".3mf", ".gcode"]
  }));

  app.get<{ Params: { id: string } }>("/artifacts/:id", async (request) =>
    farmStore.artifacts.getArtifactDetail(request.params.id)
  );

  app.post("/artifacts", async (request, reply) => {
    if (!request.isMultipart()) {
      throw new ValidationError("Ожидается multipart/form-data с одним файлом");
    }
    const part = await request.file();
    if (!part) throw new ValidationError("Файл не передан");

    const result = await farmStore.artifacts.ingest({
      source: part.file,
      fileName: part.filename || "upload.bin",
      mimeType: part.mimetype,
      // The multipart plugin flags the part truncated when it hit the size limit.
      truncated: () => part.file.truncated
    });

    reply.code(result.blobExisted ? 200 : 201);
    return {
      ok: true,
      blobExisted: result.blobExisted,
      artifact: result.artifact,
      task: result.task,
      analysis: result.analysis
    };
  });

  app.post<{ Params: { id: string } }>("/artifacts/:id/analyze", async (request) => ({
    ok: true,
    analysis: farmStore.artifacts.reanalyze(request.params.id)
  }));
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
