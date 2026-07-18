import type { FastifyInstance } from "fastify";

import { farmStore } from "../../app/farmStore";
import type { CreateProfileSetInput } from "../../app/slicing/profileService";
import type { CreateSliceInput } from "../../app/slicing/sliceService";
import { ValidationError } from "../../core/errors";
import type { ProfileType } from "../../domain/slicing/types";

/**
 * The OrcaSlicer preset + slicing API, mounted under `/api/print/slicing` on the
 * same plugin as the artifact routes — so the shared CSRF/token guard covers every
 * mutation (import, create/approve set, slice, rerun) exactly like the rest of the
 * durable model. Every handler goes through the application services
 * (`farmStore.slicing.*`); none touches SQLite, the file system or a process
 * directly, and none writes to the legacy `/api/queue`.
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
 *   POST /slicing/profile-sets/:id/approve  approve (refused if blockers)
 *   POST /slicing/slice                 start slicing               body: { artifactId, profileSetId, targetPrinterId?, force? }
 *   POST /slicing/variants/:id/rerun    re-run a finished variant
 *   POST /slicing/variants/:id/promote  hand off a ready variant's output → queued print task
 */
export function registerSlicingRoutes(app: FastifyInstance): void {
  // ── Runtime & profiles ─────────────────────────────────────────────────────

  app.get("/slicing/runtime", async () => farmStore.slicing.profiles.runtimeReport());

  app.get<{ Querystring: { type?: string } }>("/slicing/profiles", async (request) => ({
    profiles: farmStore.slicing.profiles.listProfiles(toProfileType(request.query.type))
  }));

  app.get<{ Params: { id: string } }>("/slicing/profiles/:id", async (request) => ({
    profile: farmStore.slicing.profiles.getProfile(request.params.id)
  }));

  // ── Profile sets ────────────────────────────────────────────────────────────

  app.get("/slicing/profile-sets", async () => ({ sets: farmStore.slicing.profiles.listSets() }));

  app.get<{ Params: { id: string } }>("/slicing/profile-sets/:id", async (request) => ({
    set: farmStore.slicing.profiles.getSet(request.params.id)
  }));

  app.post<{ Body: unknown }>("/slicing/profile-sets", async (request) => ({
    ok: true,
    set: farmStore.slicing.profiles.createSet(shapeCreateSet(request.body))
  }));

  app.post<{ Params: { id: string } }>("/slicing/profile-sets/:id/approve", async (request) => ({
    ok: true,
    set: farmStore.slicing.profiles.approveSet(request.params.id)
  }));

  // ── Presets import ─────────────────────────────────────────────────────────

  app.post("/slicing/presets/import", async () => ({
    ok: true,
    result: await farmStore.slicing.presets.import("operator")
  }));

  // ── Slice variants ──────────────────────────────────────────────────────────

  app.get<{ Querystring: { taskId?: string } }>("/slicing/variants", async (request) => {
    const taskId = optionalString(request.query.taskId);
    return {
      variants: taskId
        ? farmStore.slicing.slices.listByTask(taskId)
        : farmStore.slicing.slices.listVariants()
    };
  });

  app.get<{ Params: { id: string } }>("/slicing/variants/:id", async (request) => ({
    variant: farmStore.slicing.slices.getVariant(request.params.id)
  }));

  app.post<{ Body: unknown }>("/slicing/slice", async (request) => ({
    ok: true,
    variant: await farmStore.slicing.slices.createSlice(shapeCreateSlice(request.body))
  }));

  app.post<{ Params: { id: string } }>("/slicing/variants/:id/rerun", async (request) => ({
    ok: true,
    variant: farmStore.slicing.slices.rerun(request.params.id)
  }));

  // The slice → print handoff: bind a ready variant's verified output onto its task
  // and enqueue it, so it becomes an executable print job (not a stuck STL).
  app.post<{ Params: { id: string }; Body: unknown }>("/slicing/variants/:id/promote", async (request) => ({
    ok: true,
    task: farmStore.printQueue.promoteSliceVariant(request.params.id, shapePromote(request.body))
  }));
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
  return input;
}
