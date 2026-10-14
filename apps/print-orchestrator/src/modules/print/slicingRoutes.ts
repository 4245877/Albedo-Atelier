import type { FastifyInstance } from "fastify";

import type { PrintServices } from "../../bootstrap/createRuntime";
import type { CreateProfileSetInput } from "../../app/slicing/profileService";
import type { CreateSliceBatchInput, CreateSliceInput } from "../../app/slicing/sliceService";
import { ValidationError } from "../../core/errors";
import type { ProfileType } from "../../domain/slicing/types";

/**
 * The OrcaSlicer preset + slicing API, mounted under `/api/print/slicing` on the
 * same plugin as the artifact routes — so the shared CSRF/token guard covers every
 * mutation (import, create/approve set, slice, rerun) exactly like the rest of the
 * durable model. Every handler goes through the application services
 * (`services.slicing.*`); none touches SQLite, the file system or a process
 * directly, and none writes to the legacy `/api/queue`. The services are passed
 * in from the parent `/api/print` plugin (no module-level singleton).
 *
 * Reads:
 *   GET  /slicing/runtime               OrcaSlicer runtime status + profile counts + coverage
 *   GET  /slicing/profiles[?type=]      profile revisions (active/quarantined/invalid)
 *   GET  /slicing/profiles/:id          one profile revision (raw + resolved + findings)
 *   GET  /slicing/profile-sets          profile sets
 *   GET  /slicing/profile-sets/:id      one profile set
 *   GET  /slicing/variants[?taskId=]    slice variants
 *   GET  /slicing/variants/:id          one slice variant
 *
 * Actions (guarded):
 *   POST /slicing/presets/import        (re)import the vendored catalog → profile revisions
 *   POST /slicing/profile-sets          create a set                body: { name, machine, process, filament, printer?/printerClass? }
 *   POST /slicing/profile-sets/:id/approve  approve (refused if blockers or a member was superseded)
 *   POST /slicing/profile-sets/:id/successor  new unapproved set on the members' current revisions
 *   POST /slicing/slice                 start slicing               body: { artifactId, profileSetId, targetPrinterId?, force? }
 *   POST /slicing/variants/:id/rerun    re-run a finished variant
 *   POST /slicing/variants/:id/promote  hand off a ready variant's output → queued print task
 *   POST /slicing/variants/:id/reprint  a NEW print from a ready variant (its own task closed)  body: { requestId? }
 *   POST /slicing/batches               slice several models with one recipe  body: { artifactIds[], profileSetId, targetPrinterId? }
 *   POST /slicing/batches/promote       promote several ready variants, each on its own  body: { variantIds[] }
 */
export function registerSlicingRoutes(
  app: FastifyInstance,
  services: Pick<PrintServices, "printQueue" | "slicing" | "history">
): void {
  // ── Runtime & profiles ─────────────────────────────────────────────────────

  app.get("/slicing/runtime", async () => services.slicing.profiles.runtimeReport());

  app.get<{ Querystring: { type?: string } }>("/slicing/profiles", async (request) => ({
    profiles: services.slicing.profiles.listProfiles(toProfileType(request.query.type))
  }));

  app.get<{ Params: { id: string } }>("/slicing/profiles/:id", async (request) => ({
    profile: services.slicing.profiles.getProfile(request.params.id)
  }));

  // ── Profile sets ────────────────────────────────────────────────────────────

  app.get("/slicing/profile-sets", async () => ({ sets: services.slicing.profiles.listSets() }));

  app.get<{ Params: { id: string } }>("/slicing/profile-sets/:id", async (request) => ({
    set: services.slicing.profiles.getSet(request.params.id)
  }));

  app.post<{ Body: unknown }>("/slicing/profile-sets", async (request) => ({
    ok: true,
    set: services.slicing.profiles.createSet(shapeCreateSet(request.body))
  }));

  app.post<{ Params: { id: string } }>("/slicing/profile-sets/:id/approve", async (request) => ({
    ok: true,
    set: services.slicing.profiles.approveSet(request.params.id)
  }));

  app.post<{ Params: { id: string } }>("/slicing/profile-sets/:id/successor", async (request) => ({
    ok: true,
    set: services.slicing.profiles.createSuccessorSet(request.params.id)
  }));

  // ── Presets import ─────────────────────────────────────────────────────────

  app.post("/slicing/presets/import", async () => {
    const result = await services.slicing.presets.import("operator");
    // A re-import can flip a revision `active → quarantined` (e.g. a vendor parent
    // went missing) on the very ids an approved set pins — so re-validate every set
    // now and revoke any approval a changed member invalidated, instead of leaving
    // it showing a stale `approved/valid` until someone happens to open it.
    services.slicing.profiles.revalidateSets("operator");
    return { ok: true, result };
  });

  // ── Slice variants ──────────────────────────────────────────────────────────

  app.get<{ Querystring: { taskId?: string } }>("/slicing/variants", async (request) => {
    const taskId = optionalString(request.query.taskId);
    return {
      variants: taskId
        ? services.slicing.slices.listByTask(taskId)
        : services.slicing.slices.listVariants()
    };
  });

  app.get<{ Params: { id: string } }>("/slicing/variants/:id", async (request) => ({
    variant: services.slicing.slices.getVariant(request.params.id)
  }));

  app.post<{ Body: unknown }>("/slicing/slice", async (request) => ({
    ok: true,
    variant: await services.slicing.slices.createSlice(shapeCreateSlice(request.body))
  }));

  app.post<{ Params: { id: string } }>("/slicing/variants/:id/rerun", async (request) => ({
    ok: true,
    variant: services.slicing.slices.rerun(request.params.id)
  }));

  // The slice → print handoff: bind a ready variant's verified output onto its task
  // and enqueue it, so it becomes an executable print job (not a stuck STL).
  app.post<{ Params: { id: string }; Body: unknown }>("/slicing/variants/:id/promote", async (request) => ({
    ok: true,
    task: services.printQueue.promoteSliceVariant(request.params.id, shapePromote(request.body))
  }));

  // A NEW print from a ready variant whose own task is closed or was promoted onto
  // another slice — the verified G-code reused, never re-sliced. A variant its own
  // draft can still take is refused here with `promote_instead`.
  app.post<{ Params: { id: string }; Body: { requestId?: unknown } }>(
    "/slicing/variants/:id/reprint",
    async (request) => {
      const result = await services.history.reprintVariant(request.params.id, {
        requestId: optionalString(request.body?.requestId) ?? null
      });
      return { ok: true, task: result.detail, route: result.route, deduplicated: result.deduplicated };
    }
  );

  // ── Batches: several models, one recipe ────────────────────────────────────
  // Each model is sliced exactly as POST /slicing/slice would; per-model refusals
  // come back as rows, a recipe problem refuses the whole request.
  app.post<{ Body: unknown }>("/slicing/batches", async (request) => ({
    ok: true,
    batch: await services.slicing.slices.createBatch(shapeCreateBatch(request.body))
  }));

  // «Поставить готовые в очередь»: each variant promoted on its own.
  app.post<{ Body: unknown }>("/slicing/batches/promote", async (request) => ({
    ok: true,
    items: services.printQueue.promoteSliceVariants(shapeVariantIds(request.body))
  }));
}

function shapeCreateBatch(body: unknown): CreateSliceBatchInput {
  const src = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(src.artifactIds)) throw new ValidationError("Поле «artifactIds» должно быть списком");
  const input: CreateSliceBatchInput = {
    artifactIds: src.artifactIds.filter((id): id is string => typeof id === "string"),
    profileSetId: requireString(src.profileSetId ?? src.profileSet, "profileSetId")
  };
  const printerId = optionalString(src.targetPrinterId ?? src.printerId);
  if (printerId) input.targetPrinterId = printerId;
  const printerClass = optionalString(src.targetPrinterClass ?? src.printerClass);
  if (printerClass) input.targetPrinterClass = printerClass;
  return input;
}

function shapeVariantIds(body: unknown): string[] {
  const src = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(src.variantIds)) throw new ValidationError("Поле «variantIds» должно быть списком");
  return src.variantIds.filter((id): id is string => typeof id === "string");
}

/** The optional on-device file override for a slice handoff. */
function shapePromote(body: unknown): { onDeviceFile?: string | null } {
  const src = (body ?? {}) as Record<string, unknown>;
  const onDeviceFile = optionalString(src.onDeviceFile ?? src.file);
  return onDeviceFile ? { onDeviceFile } : {};
}

// ── Body shaping (narrow untrusted input) ─────────────────────────────────────

function toProfileType(value: unknown): ProfileType | undefined {
  return value === "machine" || value === "process" || value === "filament" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireString(value: unknown, field: string): string {
  const s = optionalString(value);
  if (!s) throw new ValidationError(`Поле «${field}» обязательно`);
  return s;
}

function shapeCreateSet(body: unknown): CreateProfileSetInput {
  const src = (body ?? {}) as Record<string, unknown>;
  const input: CreateProfileSetInput = {
    name: requireString(src.name, "name"),
    machineRevisionId: requireString(src.machine ?? src.machineRevisionId, "machine"),
    processRevisionId: requireString(src.process ?? src.processRevisionId, "process"),
    filamentRevisionId: requireString(src.filament ?? src.filamentRevisionId, "filament")
  };
  const printerId = optionalString(src.printerId ?? src.printer);
  if (printerId) input.printerId = printerId;
  const printerClass = optionalString(src.printerClass);
  if (printerClass) input.printerClass = printerClass;
  return input;
}

function shapeCreateSlice(body: unknown): CreateSliceInput {
  const src = (body ?? {}) as Record<string, unknown>;
  const input: CreateSliceInput = {
    artifactId: requireString(src.artifactId, "artifactId"),
    profileSetId: requireString(src.profileSetId ?? src.profileSet, "profileSetId")
  };
  const printerId = optionalString(src.targetPrinterId ?? src.printerId);
  if (printerId) input.targetPrinterId = printerId;
  const printerClass = optionalString(src.targetPrinterClass ?? src.printerClass);
  if (printerClass) input.targetPrinterClass = printerClass;
  if (src.force === true) input.force = true;
  // «Подготовить заново» from history names the print it repeats (lineage only).
  const previousTaskId = optionalString(src.previousTaskId);
  if (previousTaskId) input.previousTaskId = previousTaskId;
  return input;
}
