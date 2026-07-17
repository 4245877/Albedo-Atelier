import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";

import { farmStore } from "../../app/farmStore";
import type {
  CreateTaskInput,
  ManualTaskInput,
  TaskSchedulingPatch
} from "../../app/printQueue/printQueueService";
import { ValidationError } from "../../core/errors";
import type { DayNightPreference } from "../../domain/print/types";
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
  registerSchedulerRoutes(app);

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

/**
 * The manual-scheduler API under `/api/print/scheduler`. Every handler goes
 * through the application services (`farmStore.printQueue` / `farmStore.scheduler`)
 * — the HTTP layer only shapes untrusted input and never touches SQLite, and
 * never the legacy `/api/queue` or `state.json`.
 *
 * Queue:
 *   GET  /scheduler/queue                the open scheduler queue (task + entry + artifact)
 *   POST /scheduler/queue                add a task           body: { title, artifactId?, material?, priority?, notBefore?, deadline?, dayNightPreference?, pinnedPrinterId?, unattendedAllowed?, night? }
 *   POST /scheduler/tasks/:id/params     update scheduling    body: { priority?, notBefore?, deadline?, dayNightPreference?, unattendedAllowed?, night?, material?, expectedVersion? }
 *   POST /scheduler/tasks/:id/reorder    move in queue        body: { position, expectedVersion }
 *   POST /scheduler/tasks/:id/pin        pin a printer        body: { printer }
 *   POST /scheduler/tasks/:id/unpin      remove the pin
 *
 * Planning:
 *   GET  /scheduler/compatibility        task × printer matrix (compatible/review/blocked)
 *   GET  /scheduler/plans                all plans (revisions/history)
 *   GET  /scheduler/plans/:id            one plan with assignments + explanations + unplaced
 *   POST /scheduler/plans                build a fresh DRAFT plan   body: { name?, window? }
 *   POST /scheduler/plans/:id/recompute  recompute into a new DRAFT revision
 *   POST /scheduler/plans/:id/confirm    confirm a DRAFT (→ ACTIVE)
 *   GET  /scheduler/night                night (unattended) candidates + rejections
 */
function registerSchedulerRoutes(app: FastifyInstance): void {
  app.get("/scheduler/queue", async () => ({ queue: farmStore.printQueue.listOpenQueue() }));

  app.post<{ Body: unknown }>("/scheduler/queue", async (request) => ({
    ok: true,
    task: farmStore.printQueue.addTask(shapeManualTask(request.body))
  }));

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/scheduler/tasks/:id/params",
    async (request) => ({
      ok: true,
      task: farmStore.printQueue.setTaskScheduling(request.params.id, shapeSchedulingPatch(request.body))
    })
  );

  app.post<{ Params: { id: string }; Body: { position?: unknown; expectedVersion?: unknown } }>(
    "/scheduler/tasks/:id/reorder",
    async (request) => {
      const position = Number(request.body?.position);
      const expectedVersion = Number(request.body?.expectedVersion);
      if (!Number.isFinite(position)) throw new ValidationError("Поле «position» обязательно (число)");
      if (!Number.isFinite(expectedVersion)) {
        throw new ValidationError("Поле «expectedVersion» обязательно (число)");
      }
      return {
        ok: true,
        entry: farmStore.printQueue.reorderTask(request.params.id, position, expectedVersion)
      };
    }
  );

  app.post<{ Params: { id: string }; Body: { printer?: unknown } }>(
    "/scheduler/tasks/:id/pin",
    async (request) => {
      const printer = optionalString(request.body?.printer);
      if (!printer) throw new ValidationError("Поле «printer» обязательно");
      return { ok: true, task: farmStore.printQueue.pinPrinter(request.params.id, printer) };
    }
  );

  app.post<{ Params: { id: string } }>("/scheduler/tasks/:id/unpin", async (request) => ({
    ok: true,
    task: farmStore.printQueue.unpinPrinter(request.params.id)
  }));

  app.get("/scheduler/compatibility", async () => farmStore.scheduler.compatibilityMatrix());

  app.get("/scheduler/plans", async () => ({ plans: farmStore.scheduler.listPlans() }));

  app.get<{ Params: { id: string } }>("/scheduler/plans/:id", async (request) =>
    farmStore.scheduler.getPlan(request.params.id)
  );

  app.post<{ Body: { name?: unknown; window?: unknown } }>("/scheduler/plans", async (request) => ({
    ok: true,
    plan: farmStore.scheduler.buildDraftPlan({
      name: optionalString(request.body?.name),
      window: optionalString(request.body?.window)
    })
  }));

  app.post<{ Params: { id: string } }>("/scheduler/plans/:id/recompute", async (request) => ({
    ok: true,
    plan: farmStore.scheduler.recomputePlan(request.params.id)
  }));

  app.post<{ Params: { id: string }; Body: { expectedVersion?: unknown } }>(
    "/scheduler/plans/:id/confirm",
    async (request) => {
      const raw = request.body?.expectedVersion;
      const expectedVersion =
        typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
      return {
        ok: true,
        plan: farmStore.scheduler.confirmPlan(request.params.id, undefined, expectedVersion)
      };
    }
  );

  app.get("/scheduler/night", async () => farmStore.scheduler.nightCandidates());

  // Operator material overrides — the manual "enough filament loaded" assertion the
  // night gate reads (the farm has no remaining-material telemetry).
  app.get("/scheduler/material", async () => ({
    overrides: farmStore.scheduler.listActiveMaterialOverrides()
  }));

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/scheduler/printers/:id/material",
    async (request) => ({
      ok: true,
      override: farmStore.scheduler.setMaterialOverride(request.params.id, shapeMaterialOverride(request.body))
    })
  );
}

/** Narrows an untrusted body into the material-override input; only present fields are set. */
function shapeMaterialOverride(body: unknown): {
  sufficient?: boolean;
  coverageHours?: number | null;
  note?: string | null;
  validForHours?: number | null;
} {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: {
    sufficient?: boolean;
    coverageHours?: number | null;
    note?: string | null;
    validForHours?: number | null;
  } = {};
  if (typeof src.sufficient === "boolean") out.sufficient = src.sufficient;
  if (typeof src.coverageHours === "number" && Number.isFinite(src.coverageHours)) {
    out.coverageHours = src.coverageHours;
  }
  if (typeof src.validForHours === "number" && Number.isFinite(src.validForHours)) {
    out.validForHours = src.validForHours;
  }
  const note = optionalString(src.note);
  if (note) out.note = note;
  return out;
}

/** A trimmed non-empty string, or undefined — the shape the service expects. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toDayNight(value: unknown): DayNightPreference | undefined {
  return value === "any" || value === "day" || value === "night" ? value : undefined;
}

/** Narrows an untrusted body into {@link ManualTaskInput}; `title` is validated by the service. */
function shapeManualTask(body: unknown): ManualTaskInput {
  const src = (body ?? {}) as Record<string, unknown>;
  const input: ManualTaskInput = {
    title: typeof src.title === "string" ? src.title : ""
  };
  const artifactId = optionalString(src.artifactId);
  if (artifactId) input.artifactId = artifactId;
  const material = optionalString(src.material);
  if (material) input.material = material;
  const notBefore = optionalString(src.notBefore);
  if (notBefore) input.notBefore = notBefore;
  const deadline = optionalString(src.deadline);
  if (deadline) input.deadline = deadline;
  const dayNight = toDayNight(src.dayNightPreference);
  if (dayNight) input.dayNightPreference = dayNight;
  const pinned = optionalString(src.pinnedPrinterId ?? src.printer);
  if (pinned) input.pinnedPrinterId = pinned;
  if (src.unattendedAllowed === true) input.unattendedAllowed = true;
  if (src.night === true) input.night = true;
  if (typeof src.priority === "number" && Number.isFinite(src.priority)) input.priority = src.priority;
  return input;
}

/** Narrows an untrusted body into {@link TaskSchedulingPatch}; only present fields are set. */
function shapeSchedulingPatch(body: unknown): TaskSchedulingPatch {
  const src = (body ?? {}) as Record<string, unknown>;
  const patch: TaskSchedulingPatch = {};
  if (typeof src.priority === "number" && Number.isFinite(src.priority)) patch.priority = src.priority;
  if ("notBefore" in src) patch.notBefore = optionalString(src.notBefore) ?? null;
  if ("deadline" in src) patch.deadline = optionalString(src.deadline) ?? null;
  const dayNight = toDayNight(src.dayNightPreference);
  if (dayNight) patch.dayNightPreference = dayNight;
  if (typeof src.unattendedAllowed === "boolean") patch.unattendedAllowed = src.unattendedAllowed;
  if (typeof src.night === "boolean") patch.night = src.night;
  if ("material" in src) patch.material = optionalString(src.material) ?? null;
  if (typeof src.expectedVersion === "number" && Number.isFinite(src.expectedVersion)) {
    patch.expectedVersion = src.expectedVersion;
  }
  return patch;
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
