import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";

import type { FarmCommands } from "../../app/FarmCommands";
import type {
  CreateTaskInput,
  ManualTaskInput,
  TaskSchedulingPatch
} from "../../app/printQueue/printQueueService";
import type { PrintServices } from "../../bootstrap/createRuntime";
import { ValidationError } from "../../core/errors";
import type { DayNightPreference } from "../../domain/print/types";
import { uploads } from "../../shared/env";
import { registerAssignmentRoutes } from "./assignmentRoutes";
import { registerLaunchRoutes } from "./launchRoutes";
import { registerOperationsRoutes } from "./operationsRoutes";
import { registerSlicingRoutes } from "./slicingRoutes";

/** The services + commands the print / scheduler / artifact routes need, passed explicitly. */
export interface PrintRoutesOptions {
  services: PrintServices;
  commands: Pick<FarmCommands, "resolveRun">;
}

/**
 * The persistent print-queue API under `/api/print` — the surface for the
 * **canonical** SQLite-backed model, and the scheduler that plans over it
 * (`/api/print/scheduler`). It is authoritative: SQLite is the single source of
 * truth for the queue. The legacy `/api/queue` is a thin compatibility adapter
 * that projects the *same* model through the *same* application use cases (see
 * `src/modules/queue/routes.ts`) — the two are views over one queue, never two
 * queues. `GET /queue` here is the legacy-shape projection this API exposes for
 * clients that still want the flat job shape.
 *
 * Reads:
 *   GET  /tasks         all tasks (any state; launched tasks are never deleted)
 *   GET  /tasks/:id     one task with its full chain (assignments → runs) + audit
 *   GET  /queue         the open queue projected into the legacy job shape
 *   GET  /audit         recent audit events
 *
 * Actions (guarded by the shared CSRF/token middleware like every mutation):
 *   POST /tasks              create a task (DEPRECATED — no artifact/analysis; upload instead)
 *   POST /tasks/:id/hold     park for review         body: { reason? }
 *   POST /tasks/:id/release  return to the queue
 *   POST /tasks/:id/cancel   cancel (kept as history) body: { reason? }
 *   POST /tasks/:id/assign   bind to a printer        body: { printer }
 *   POST /tasks/:id/enqueue  queue an already-executable upload (G-code / sliced 3MF)
 *
 * Uploads (the new SQLite-only file-analysis surface; see modules/print):
 *   GET  /artifacts              list uploaded artifacts (+ latest analysis, draft task)
 *   GET  /artifacts/:id          one artifact with its analyses + audit
 *   GET  /artifacts/config       upload limits for the dashboard
 *   POST /artifacts              multipart upload of one file → Artifact + DRAFT task + pending analysis
 *   POST /artifacts/:id/analyze  re-run analysis (after a failed attempt)
 *   POST /artifacts/:id/scale    state what an STL's units are  body: { units, scaleFactor? }
 *   POST /artifacts/:id/review   accept a `review` verdict      body: { note?, operator? }
 *   DELETE /artifacts/:id        delete one stored file (409 while it is in use)
 */
export async function registerPrintQueueRoutes(
  app: FastifyInstance,
  opts: PrintRoutesOptions
): Promise<void> {
  const { services, commands } = opts;

  // Scoped to this plugin: multipart is only for the upload route. One file per
  // request (accurate per-file progress on the client), streamed — never
  // buffered — with the configured single-file size limit enforced by the plugin.
  await app.register(fastifyMultipart, {
    limits: { fileSize: uploads.maxFileBytes, files: 1, fields: 8 }
  });

  registerArtifactRoutes(app, services);
  registerSlicingRoutes(app, services);
  registerAssignmentRoutes(app, services);
  registerLaunchRoutes(app, services);
  registerOperationsRoutes(app, services);
  registerSchedulerRoutes(app, services);

  app.get("/tasks", async () => ({ tasks: services.printQueue.listTasks() }));

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request) =>
    services.printQueue.getTaskDetail(request.params.id)
  );

  app.get("/queue", async () => ({ queue: services.printQueue.projectLegacyQueue() }));

  app.get<{ Querystring: { limit?: string } }>("/audit", async (request) => {
    const limit = Number.parseInt(request.query.limit ?? "", 10);
    return { events: services.printQueue.listAudit(Number.isFinite(limit) ? limit : undefined) };
  });

  /**
   * **Deprecated**, for the same reason as `POST /api/queue`: it can mint a task
   * around a typed on-printer file name, with no artifact, no content hash and
   * no analysis behind it. Nothing downstream can then prove that the file it
   * starts is the file anybody looked at. The supported route is an upload
   * (`POST /artifacts`) followed by `POST /tasks/:id/enqueue` or a slice.
   *
   * Still served — external clients and a large part of the test suite build
   * fixtures through it — and still audited exactly as before.
   */
  app.post<{ Body: unknown }>("/tasks", async (request, reply) => {
    reply.header("Deprecation", "true");
    reply.header("Link", '</api/print/artifacts>; rel="successor-version"');
    // The same three headers `POST /api/queue` sends. A client that only looks
    // for `Warning` — the one a browser console surfaces on its own — learned
    // nothing from the two silent ones, so the deprecation was announced to
    // exactly the clients already reading the docs.
    reply.header(
      "Warning",
      '299 - "POST /api/print/tasks creates a task with no artifact or analysis; upload the file instead"'
    );
    return { ok: true, task: services.printQueue.createTask(shapeCreateInput(request.body)) };
  });

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/tasks/:id/hold",
    async (request) => ({
      ok: true,
      task: services.printQueue.holdTask(request.params.id, optionalString(request.body?.reason))
    })
  );

  app.post<{ Params: { id: string } }>("/tasks/:id/release", async (request) => ({
    ok: true,
    task: services.printQueue.releaseTask(request.params.id)
  }));

  // The route an uploaded G-code / sliced 3MF takes into the queue — the
  // counterpart of `POST /slicing/variants/:id/promote` for work that needs no
  // slicing. Deliberately NOT `release`: that moves a task to QUEUED without
  // creating a queue entry, which for a draft produces a queued task that is in
  // no queue. See `ExecutableEnqueue`.
  app.post<{
    Params: { id: string };
    Body: { onDeviceFile?: unknown; material?: unknown; operator?: unknown };
  }>("/tasks/:id/enqueue", async (request) => {
    const body = request.body ?? {};
    return {
      ok: true,
      task: services.printQueue.enqueueExecutableArtifact(
        request.params.id,
        {
          ...(optionalString(body.onDeviceFile) ? { onDeviceFile: optionalString(body.onDeviceFile) } : {}),
          ...(optionalString(body.material) ? { material: optionalString(body.material) } : {})
        },
        optionalString(body.operator)
      )
    };
  });

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/tasks/:id/cancel",
    async (request) => ({
      ok: true,
      task: services.printQueue.cancelTask(request.params.id, optionalString(request.body?.reason))
    })
  );

  // Manual placement: creates an EXECUTABLE assignment (see QueueCommands.assignTask).
  // The follow-up steps live under /assignments/:id — prepare-file, then start.
  app.post<{ Params: { id: string }; Body: { printer?: unknown; reason?: unknown } }>(
    "/tasks/:id/assign",
    async (request) => {
      const printer = optionalString(request.body?.printer);
      if (!printer) throw new ValidationError("Поле «printer» обязательно");
      const reason = optionalString(request.body?.reason);
      return {
        ok: true,
        assignment: services.printQueue.assignTask(
          request.params.id,
          printer,
          reason ? { reason } : {}
        )
      };
    }
  );

  // Operator resolution of a run stuck in UNKNOWN (lost completion, restart
  // mid-print) after physically checking the printer. Refused while the device
  // is observably printing the run's file; completion is recorded exactly once.
  app.post<{ Params: { id: string }; Body: { outcome?: unknown; reason?: unknown } }>(
    "/runs/:id/resolve",
    async (request) => {
      const outcome = request.body?.outcome;
      if (outcome !== "SUCCEEDED" && outcome !== "FAILED" && outcome !== "CANCELLED") {
        throw new ValidationError("Поле «outcome» обязательно: SUCCEEDED | FAILED | CANCELLED");
      }
      return {
        ok: true,
        run: commands.resolveRun(request.params.id, outcome, optionalString(request.body?.reason))
      };
    }
  );
}

/**
 * The `/api/print/artifacts` upload + analysis surface. Kept separate from the
 * task/queue routes above but on the same plugin, so the shared CSRF/token guard
 * covers the mutations (upload, re-analyze) exactly like every other action.
 * These never touch `/api/queue` or `state.json`.
 */
function registerArtifactRoutes(
  app: FastifyInstance,
  services: Pick<PrintServices, "artifacts">
): void {
  app.get("/artifacts", async () => ({ artifacts: services.artifacts.listArtifacts() }));

  app.get("/artifacts/config", async () => ({
    maxFileBytes: uploads.maxFileBytes,
    maxFiles: uploads.maxFiles,
    maxTotalBytes: uploads.maxTotalBytes,
    // The four things the analyzers actually admit. `.gcode.3mf` is not a
    // separate extension (it ends in `.3mf`), but naming it is what tells an
    // operator that a finished plate package is welcome here too.
    acceptedExtensions: [".stl", ".3mf", ".gcode", ".gco", ".g"]
  }));

  app.get<{ Params: { id: string } }>("/artifacts/:id", async (request) =>
    services.artifacts.getArtifactDetail(request.params.id)
  );

  app.post("/artifacts", async (request, reply) => {
    if (!request.isMultipart()) {
      throw new ValidationError("Ожидается multipart/form-data с одним файлом");
    }
    const part = await request.file();
    if (!part) throw new ValidationError("Файл не передан");

    const result = await services.artifacts.ingest({
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
    analysis: services.artifacts.reanalyze(request.params.id)
  }));

  // An STL stores no unit, so its bounding box is numbers without a scale. This
  // is the operator saying what they mean; it is bound to the artifact's content
  // hash and lapses if the file is replaced. Without it the scheduler reports
  // `model_scale_unknown` and refuses an unattended start.
  app.post<{ Params: { id: string }; Body: { units?: unknown; scaleFactor?: unknown } }>(
    "/artifacts/:id/scale",
    async (request) => {
      const body = request.body ?? {};
      return {
        ok: true,
        ...services.artifacts.confirmModelScale(request.params.id, {
          units: body.units,
          scaleFactor: body.scaleFactor
        })
      };
    }
  );

  app.delete<{ Params: { id: string } }>("/artifacts/:id/scale", async (request) => ({
    ok: true,
    ...services.artifacts.clearModelScale(request.params.id)
  }));

  // A `review` verdict is the analyzer being honest about parameters it cannot
  // vouch for — a sliced 3MF carries someone else's machine profile. This is a
  // named operator saying they have read it. It is bound to the artifact's hash
  // and to the analysis id, so a re-upload or a re-analysis lapses it, and it
  // never clears an analysis blocker or authorises an unattended start.
  app.post<{ Params: { id: string }; Body: { note?: unknown; operator?: unknown } }>(
    "/artifacts/:id/review",
    async (request) => {
      const body = request.body ?? {};
      return {
        ok: true,
        ...services.artifacts.confirmAnalysisReview(request.params.id, {
          ...(optionalString(body.operator) ? { actor: optionalString(body.operator) } : {}),
          note: optionalString(body.note) ?? null
        })
      };
    }
  );

  app.delete<{ Params: { id: string } }>("/artifacts/:id/review", async (request) => ({
    ok: true,
    ...services.artifacts.clearAnalysisReview(request.params.id)
  }));

  // Safe manual deletion of one stored file (STL / 3MF / G-code alike — an
  // artifact is an artifact). Refused with 409 and the reason (`details.blocker`)
  // while any live task, run, analysis, assignment, device upload or slice
  // variant still uses it — a state conflict the caller may retry after a
  // refresh, not a malformed request; 404 when the id is unknown. Deduplicated
  // blobs are only unlinked when the LAST reference goes, and the row is removed
  // before the bytes, never the other way round.
  app.delete<{ Params: { id: string } }>("/artifacts/:id", async (request) => ({
    ok: true,
    ...(await services.artifacts.deleteArtifact(request.params.id))
  }));

  // Retention sweep (dry-run by default — pass {"dryRun": false} to act).
  app.post<{ Body: { olderThanDays?: unknown; dryRun?: unknown; maxDelete?: unknown } }>(
    "/artifacts/retention/sweep",
    async (request) => {
      const body = request.body ?? {};
      const olderThanDays =
        typeof body.olderThanDays === "number" && Number.isFinite(body.olderThanDays) && body.olderThanDays >= 0
          ? body.olderThanDays
          : uploads.retentionDays;
      const maxDelete =
        typeof body.maxDelete === "number" && Number.isFinite(body.maxDelete) && body.maxDelete > 0
          ? Math.floor(body.maxDelete)
          : undefined;
      return {
        ok: true,
        ...(await services.artifacts.retentionSweep({
          olderThanDays,
          dryRun: body.dryRun !== false,
          maxDelete
        }))
      };
    }
  );

  // Orphan reconciliation between the blob store and the DB (dry-run by default).
  app.post<{ Body: { dryRun?: unknown; maxDelete?: unknown } }>(
    "/artifacts/orphans/sweep",
    async (request) => {
      const body = request.body ?? {};
      const maxDelete =
        typeof body.maxDelete === "number" && Number.isFinite(body.maxDelete) && body.maxDelete > 0
          ? Math.floor(body.maxDelete)
          : undefined;
      return {
        ok: true,
        ...(await services.artifacts.orphanSweep({ dryRun: body.dryRun !== false, maxDelete }))
      };
    }
  );
}

/**
 * The manual-scheduler API under `/api/print/scheduler`. Every handler goes
 * through the application services (`services.printQueue` / `services.scheduler`)
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
 *   POST /scheduler/plans/:id/recompute  recompute into a new DRAFT revision   body: { trigger? }
 *   POST /scheduler/recompute            recompute the live plan (or build the first) body: { trigger? }
 *   POST /scheduler/plans/:id/confirm    confirm a DRAFT (→ ACTIVE)
 *   GET  /scheduler/night                night (unattended) candidates + rejections
 *
 * Everything here is a **recommendation**: a plan names a printer, a slice and a
 * window, and stops there. No handler uploads a file, reserves a bed or sends a
 * printer command — those live behind the dispatch API and its `DispatchEligibility`
 * gate, and they always need a separate, explicit operator action.
 */
function registerSchedulerRoutes(
  app: FastifyInstance,
  services: Pick<PrintServices, "printQueue" | "scheduler">
): void {
  app.get("/scheduler/queue", async () => ({ queue: services.printQueue.listOpenQueue() }));

  app.post<{ Body: unknown }>("/scheduler/queue", async (request) => ({
    ok: true,
    task: services.printQueue.addTask(shapeManualTask(request.body))
  }));

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/scheduler/tasks/:id/params",
    async (request) => ({
      ok: true,
      task: services.printQueue.setTaskScheduling(request.params.id, shapeSchedulingPatch(request.body))
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
        entry: services.printQueue.reorderTask(request.params.id, position, expectedVersion)
      };
    }
  );

  app.post<{ Params: { id: string }; Body: { printer?: unknown } }>(
    "/scheduler/tasks/:id/pin",
    async (request) => {
      const printer = optionalString(request.body?.printer);
      if (!printer) throw new ValidationError("Поле «printer» обязательно");
      return { ok: true, task: services.printQueue.pinPrinter(request.params.id, printer) };
    }
  );

  app.post<{ Params: { id: string } }>("/scheduler/tasks/:id/unpin", async (request) => ({
    ok: true,
    task: services.printQueue.unpinPrinter(request.params.id)
  }));

  app.get("/scheduler/compatibility", async () => services.scheduler.compatibilityMatrix());

  app.get("/scheduler/plans", async () => ({ plans: services.scheduler.listPlans() }));

  app.get<{ Params: { id: string } }>("/scheduler/plans/:id", async (request) =>
    services.scheduler.getPlan(request.params.id)
  );

  app.post<{ Body: { name?: unknown; window?: unknown } }>("/scheduler/plans", async (request) => ({
    ok: true,
    plan: services.scheduler.buildDraftPlan({
      name: optionalString(request.body?.name),
      window: optionalString(request.body?.window)
    })
  }));

  app.post<{ Params: { id: string }; Body: { trigger?: unknown } }>(
    "/scheduler/plans/:id/recompute",
    async (request) => ({
      ok: true,
      plan: services.scheduler.recomputePlan(request.params.id, shapeTrigger(request.body?.trigger))
    })
  );

  // The single "recalculate the recommendations" command, for every event the
  // brief lists. Explicit on purpose: nothing schedules it, and it produces a
  // DRAFT — no upload, no reservation, no printer command.
  app.post<{ Body: { trigger?: unknown } }>("/scheduler/recompute", async (request) => ({
    ok: true,
    plan: services.scheduler.recomputeRecommendations(shapeTrigger(request.body?.trigger))
  }));

  app.post<{ Params: { id: string }; Body: { expectedVersion?: unknown } }>(
    "/scheduler/plans/:id/confirm",
    async (request) => {
      const raw = request.body?.expectedVersion;
      const expectedVersion =
        typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
      // Actor is intentionally omitted → the service stamps confirmedBy = "operator".
      // The whole API is guarded by one shared token (single-operator model), so
      // there is no distinct principal to attribute yet; when per-user auth lands,
      // pass the authenticated identity here as the second argument.
      return {
        ok: true,
        plan: services.scheduler.confirmPlan(request.params.id, undefined, expectedVersion)
      };
    }
  );

  app.get("/scheduler/night", async () => services.scheduler.nightCandidates());

  // Operator material overrides — the manual "enough filament loaded" assertion the
  // night gate reads (the farm has no remaining-material telemetry).
  app.get("/scheduler/material", async () => ({
    overrides: services.scheduler.listActiveMaterialOverrides()
  }));

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/scheduler/printers/:id/material",
    async (request) => ({
      ok: true,
      override: services.scheduler.setMaterialOverride(request.params.id, shapeMaterialOverride(request.body))
    })
  );
}

/**
 * The stable vocabulary of events that may prompt a recalculation. It is a
 * closed list so the audit trail groups by a real code instead of by whatever
 * free text a caller sent; anything unrecognised becomes `manual`.
 */
const RECOMPUTE_TRIGGERS = new Set([
  "manual",
  "task_added",
  "task_removed",
  "priority_changed",
  "deadline_changed",
  "print_finished",
  "operation_opened",
  "operation_completed",
  "schedule_changed",
  "printer_state_changed",
  "slice_ready",
  "assignment_changed",
  "device_error"
]);

function shapeTrigger(raw: unknown): string {
  return typeof raw === "string" && RECOMPUTE_TRIGGERS.has(raw) ? raw : "manual";
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
