import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { JobError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { PrintTask } from "../../domain/print/types";
import type { ProfileRevision, ProfileSet, ProfileType } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import type { PrinterConfig } from "../../infra/printers/config";
import type { PrinterFilesListing } from "../../infra/printers/files";
import type { PrinterLiveStatus } from "../../infra/printers/status";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ArtifactService } from "../artifacts/artifactService";
import { establishClearBed } from "../dispatch/testkit/bed";
import { DeviceArtifactService } from "../dispatch/deviceArtifactService";
import { DispatchService, type DispatchDeps } from "../dispatch/dispatchService";
import { RunLifecycleService } from "../dispatch/runLifecycle";
import { ManualOperationService } from "../operations/manualOperationService";
import { OperatorScheduleService } from "../operations/operatorScheduleService";
import { EligibilityQueries } from "../scheduling/eligibility";
import { SchedulerContext } from "../scheduling/context";
import { EvidenceResolver } from "../scheduling/evidence";
import type { SchedulerPrinterRef } from "../scheduling/types";
import { ProfileService } from "../slicing/profileService";
import { SliceService } from "../slicing/sliceService";
import { FakeOrcaRunner } from "../slicing/testkit/fakeOrcaRunner";
import { PrintHistory } from "./history";
import { PrintQueueService } from "./printQueueService";

/*
 * **История и повтор печати, end to end on real services.**
 *
 * A finished print is history; printing it again is a NEW print of the same
 * verified bytes. These walk the whole road on the real store, analyzer, slice
 * pipeline (fake Orca binary), delivery, dispatch and run lifecycle — only the
 * printer's filesystem and its start command are faked:
 *
 *   upload → slice → promote → deliver → start → complete → history →
 *   reprint (same G-code, no re-slice) → deliver → start → complete again
 *
 * and pin what must NOT happen: the finished print is never reopened or
 * edited, a retried request creates one print not two, a deleted file is a
 * refusal with a way forward rather than a broken job in the queue.
 */

const T0 = Date.parse("2026-10-14T09:00:00.000Z");

const PRINTERS = [
  {
    id: "k2",
    name: "Creality K2",
    model: "Creality K2",
    type: "FDM",
    protocol: "moonraker",
    host: "127.0.0.1",
    material: "PETG",
    printerClass: "k2",
    enabled: true
  }
] as unknown as PrinterConfig[];

const LIMITS = {
  zipMaxEntries: 100,
  zipMaxEntryBytes: 1 << 20,
  zipMaxTotalBytes: 4 << 20,
  zipMaxRatio: 200,
  xmlMaxBytes: 1 << 20
};

interface Harness {
  store: PrintQueueStore;
  storage: ArtifactStorage;
  artifacts: ArtifactService;
  profiles: ProfileService;
  slices: SliceService;
  queue: PrintQueueService;
  devices: DeviceArtifactService;
  dispatch: DispatchService;
  lifecycle: RunLifecycleService;
  operations: ManualOperationService;
  history: PrintHistory;
  runner: FakeOrcaRunner;
  onDevice: Map<string, { path: string; size: number }[]>;
  clock: { ms: number };
  settle: () => Promise<void>;
}

let TMP: string;
let h: Harness;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "print-history-"));
  h = await makeHarness(TMP);
});

afterEach(async () => {
  await h.settle();
  h.slices.close();
  h.artifacts.close();
  h.store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function makeHarness(tmp: string): Promise<Harness> {
  const store = openPrintQueueStore(":memory:");
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms);
  establishClearBed(store, "k2", new Date(T0 - 60_000));
  const storage = new ArtifactStorage({ root: path.join(tmp, "artifacts") });
  await storage.init();
  const onDevice = new Map<string, { path: string; size: number }[]>();

  const artifacts = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 8 * 1024 * 1024,
    timeoutMs: 15_000,
    concurrency: 2
  });
  const runner = new FakeOrcaRunner();
  runner.sourceBox = { x: 20, y: 20, z: 20 };
  fs.mkdirSync(path.join(tmp, "work"), { recursive: true });
  const slicerRefs = () =>
    PRINTERS.map((p) => ({
      id: p.id,
      name: p.name,
      model: p.model,
      material: "PETG",
      protocol: p.protocol,
      nozzleMm: 0.4,
      printerClass: p.printerClass ?? null
    }));
  const slices = new SliceService(store, storage, artifacts, runner, {
    tmpRoot: path.join(tmp, "work"),
    timeoutMs: 5000,
    concurrency: 1,
    listPrinters: slicerRefs
  });
  const profiles = new ProfileService(store, runner, slicerRefs);
  const queue = new PrintQueueService(store, {
    now,
    isPrinterConfigured: (id) => PRINTERS.some((p) => p.id === id),
    resolvePrinter: (id) => PRINTERS.find((p) => p.id === id)
  });

  const listFiles = async (printer: PrinterConfig, dir: string): Promise<PrinterFilesListing> => ({
    path: dir,
    entries: (onDevice.get(printer.id) ?? []).map((f) => ({
      name: f.path.split("/").pop() ?? f.path,
      path: f.path,
      type: "file" as const,
      size: f.size,
      printable: true
    }))
  });
  const devices = new DeviceArtifactService({
    store,
    storage,
    resolvePrinter: (id) => PRINTERS.find((p) => p.id === id),
    listFiles,
    uploadFile: async (printer, remotePath, bytes) => {
      const files = onDevice.get(printer.id) ?? [];
      onDevice.set(printer.id, [...files.filter((f) => f.path !== remotePath), { path: remotePath, size: bytes.byteLength }]);
      return { remotePath, sizeBytes: bytes.byteLength };
    },
    deleteFile: async (printer, remotePath) => {
      onDevice.set(printer.id, (onDevice.get(printer.id) ?? []).filter((f) => f.path !== remotePath));
    },
    now
  });

  const refs = (): SchedulerPrinterRef[] =>
    PRINTERS.map((p) => ({
      id: p.id,
      name: p.name,
      model: p.model,
      protocol: p.protocol,
      printerClass: p.printerClass ?? null,
      material: "PETG",
      nozzleMm: 0.4,
      buildVolume: { x: 256, y: 256, z: 256 },
      online: true,
      status: "idle" as const,
      remoteStartSupported: true,
      ams: false,
      faults: [],
      mediaPresent: true,
      telemetryAgeMs: 1_000,
      materialRemainingSufficient: null,
      printingTimeLeftMs: null,
      activeRunState: null
    }));
  const eligibility = (): EligibilityQueries => {
    const ctx = new SchedulerContext(store, refs, {
      now,
      runtimeAvailable: true,
      nightSafetyBufferRatio: 0.2,
      nightWindow: "21:30 – 07:30",
      farmTimeZone: "UTC",
      compatibility: { telemetryStaleMs: 120_000 },
      unknownEtaAssumptionS: 4 * 3600
    });
    return new EligibilityQueries(ctx, new EvidenceResolver(ctx));
  };
  const deps: DispatchDeps = {
    store,
    resolvePrinter: (ref) => PRINTERS.find((p) => p.id === ref.trim().toLowerCase()),
    getStatus: () => undefined,
    startPhysical: async () => ({ confirmed: true }),
    classifyError: () => "unknown",
    listFiles,
    evaluateEligibility: (input) => eligibility().evaluate(input),
    now
  };

  const operations = new ManualOperationService(store, new OperatorScheduleService(store));
  const housekeeping: Promise<unknown>[] = [];
  const lifecycle = new RunLifecycleService(store, {
    now,
    operations,
    reclaimStorage: (printerId) => void housekeeping.push(devices.reclaim({ printerId }))
  });
  const history = new PrintHistory({
    store,
    printQueue: queue,
    blobExists: (key) => storage.exists(key),
    printerName: (id) => PRINTERS.find((p) => p.id === id)?.name ?? null,
    now
  });

  return {
    store,
    storage,
    artifacts,
    profiles,
    slices,
    queue,
    devices,
    dispatch: new DispatchService(deps),
    lifecycle,
    operations,
    history,
    runner,
    onDevice,
    clock,
    settle: async () => {
      while (housekeeping.length) await housekeeping.shift();
    }
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function cubeStl(size = 20): Buffer {
  const s = size;
  const tris: [number, number, number][][] = [
    [[0, 0, 0], [s, 0, 0], [s, s, 0]],
    [[0, 0, 0], [s, s, 0], [0, s, 0]],
    [[0, 0, s], [s, 0, s], [s, s, s]],
    [[0, 0, 0], [0, 0, s], [s, 0, s]]
  ];
  const header = Buffer.alloc(84);
  header.writeUInt32LE(tris.length, 80);
  const body = Buffer.concat(
    tris.map((tri) => {
      const buf = Buffer.alloc(50);
      let o = 12;
      for (const v of tri) {
        buf.writeFloatLE(v[0], o);
        buf.writeFloatLE(v[1], o + 4);
        buf.writeFloatLE(v[2], o + 8);
        o += 12;
      }
      return buf;
    })
  );
  return Buffer.concat([header, body]);
}

/** An uploaded third-party G-code the analyzer reads as schedulable. */
const UPLOADED_GCODE = Buffer.from(
  ["; generated by PrusaSlicer 2.7.1", "; printer_model = MK4", "; filament_type = PLA", "G21", "G90", "G1 X0 Y0", "G1 X30 Y20"].join(
    "\n"
  )
);

function revision(type: ProfileType, name: string, settings: Record<string, unknown>): ProfileRevision {
  const raw = JSON.stringify({ name, type, ...settings });
  const sha = createHash("sha256").update(raw).digest("hex");
  const iso = new Date(T0).toISOString();
  const rev: ProfileRevision = {
    id: newId(ID_PREFIX.profileRevision),
    logicalId: `${type}:${name}`,
    type,
    name,
    inherits: null,
    status: "active",
    rawJson: raw,
    rawSha256: sha,
    resolvedJson: raw,
    resolvedSha256: sha,
    orcaVersion: "2.3.0",
    source: null,
    warnings: [],
    blockers: [],
    createdAt: iso,
    updatedAt: iso,
    version: 1,
    metadata: {}
  };
  h.store.repositories.profileRevisions.insert(rev);
  return rev;
}

function approvedSet(): ProfileSet {
  const machine = revision("machine", "K2", {
    printer_model: "Creality K2",
    nozzle_diameter: ["0.4"],
    printable_area: ["0x0", "256x0", "256x256", "0x256"],
    printable_height: "256",
    gcode_flavor: "klipper"
  });
  const process = revision("process", "0.2 @K2", { layer_height: "0.2", initial_layer_print_height: "0.2" });
  const filament = revision("filament", "PETG @K2", {
    filament_type: ["PETG"],
    nozzle_temperature: ["245"],
    nozzle_temperature_initial_layer: ["245"],
    hot_plate_temp: ["80"]
  });
  const set = h.profiles.createSet({
    name: "K2 · PETG",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerClass: "k2"
  });
  h.profiles.approveSet(set.id, "miha");
  return h.store.repositories.profileSets.getById(set.id)!;
}

function status(over: Partial<PrinterLiveStatus>): PrinterLiveStatus {
  return {
    id: "k2",
    online: true,
    status: "idle",
    currentFile: null,
    progressPct: null,
    remainingMinutes: null,
    filamentUsedMm: null,
    amsTrays: null,
    nozzleDiameterMm: 0.4,
    faults: [],
    mediaPresent: true,
    error: null,
    updatedAt: new Date(h.clock.ms).toISOString(),
    ...over
  } as PrinterLiveStatus;
}

function tick(minutes = 1): void {
  h.clock.ms += minutes * 60_000;
}

async function uploadModel(name = "cube.stl", size = 20): Promise<string> {
  const uploaded = await h.artifacts.ingest({ source: Readable.from(cubeStl(size)), fileName: name });
  await h.artifacts.whenIdle();
  h.artifacts.confirmModelScale(uploaded.artifact.id, { units: "millimeter", actor: "miha" });
  return uploaded.artifact.id;
}

/** Slice a model for the K2 and promote it: a queued, printer-pinned job. */
async function sliceAndQueue(artifactId: string, set: ProfileSet): Promise<PrintTask> {
  const variant = await h.slices.createSlice({ artifactId, profileSetId: set.id, targetPrinterId: "k2" });
  await h.slices.whenIdle();
  const ready = h.slices.getVariant(variant.id);
  assert.equal(ready.state, "ready", ready.error ?? "");
  return h.queue.promoteSliceVariant(variant.id).task;
}

/** Deliver, start and finish a queued job on the K2; then clear the plate. */
async function printToCompletion(taskId: string): Promise<string> {
  tick();
  const assignment = h.queue.assignTask(taskId, "k2", { reason: "test" });
  const prepared = await h.devices.prepare(assignment.id);
  assert.equal(prepared.ready, true, "the file is delivered and verified");
  const started = await h.dispatch.startAssignment(assignment.id, { mode: "manual", actor: "miha" });
  const file = prepared.deviceArtifact.remotePath;
  const printing = status({ status: "printing", currentFile: file, progressPct: 10 });
  h.lifecycle.observe("k2", undefined, printing);
  tick(30);
  h.lifecycle.observe("k2", printing, status({ status: "idle", stateText: "complete", progressPct: 100 }));
  await h.settle();
  assert.equal(h.store.repositories.printRuns.getById(started.runId)?.state, "SUCCEEDED");
  for (const op of h.operations.openClearanceOperations("k2")) h.operations.complete(op.id, { actor: "miha" });
  return started.runId;
}

// ── History ─────────────────────────────────────────────────────────────────

test("a finished sliced print is history: run, printer, file and the exact recipe it was made with", async () => {
  const set = approvedSet();
  const source = await uploadModel();
  const task = await sliceAndQueue(source, set);
  const runId = await printToCompletion(task.id);

  const page = await h.history.list();
  assert.equal(page.entries.length, 1);
  assert.equal(page.nextCursor, null);
  const entry = page.entries[0];
  assert.equal(entry.taskId, task.id);
  assert.equal(entry.state, "COMPLETED");
  assert.equal(entry.run?.id, runId);
  assert.equal(entry.run?.state, "SUCCEEDED");
  assert.equal(entry.run?.printerName, "Creality K2", "the operator's name for the printer, not its id");
  assert.equal(entry.runCount, 1);
  assert.equal(entry.file?.artifactId, task.artifactId);
  assert.equal(entry.source?.artifactId, source);

  // The settings — recorded at slicing time, not read off today's recipe.
  assert.equal(entry.recipe?.profileSetId, set.id);
  assert.equal(entry.recipe?.profileSetName, "K2 · PETG");
  assert.equal(entry.recipe?.profileSetUsable, true);
  assert.deepEqual(
    [entry.recipe?.machine, entry.recipe?.process, entry.recipe?.filament],
    ["K2", "0.2 @K2", "PETG @K2"]
  );
  assert.equal(entry.recipe?.targetPrinterId, "k2");
  assert.equal(entry.recipe?.scaleFactor, 1, "cut at the confirmed millimetres");

  assert.deepEqual(entry.actions.reprint, { allowed: true, code: null, reason: null, route: "variant" });
  assert.equal(entry.actions.retry.allowed, false, "only a FAILED print is retried as the same job");
  assert.deepEqual(entry.actions.reprepare, { artifactId: source, printerId: "k2", profileSetId: set.id });
});

test("reprint: a NEW print of the same verified G-code — no re-slice, the finished print untouched", async () => {
  const set = approvedSet();
  const source = await uploadModel();
  const task = await sliceAndQueue(source, set);
  await printToCompletion(task.id);
  const before = h.store.repositories.tasks.getById(task.id)!;
  const slicesBefore = h.runner.sliceCount;

  tick();
  const result = await h.history.reprintTask(task.id, { requestId: "req-1", actor: "miha" });
  assert.equal(result.route, "variant");
  assert.equal(result.deduplicated, false);
  const reprint = result.detail.task;
  assert.notEqual(reprint.id, task.id);
  assert.equal(reprint.state, "QUEUED");
  assert.equal(result.detail.queueEntry?.state, "WAITING", "it is in the queue, not just marked queued");
  assert.equal(reprint.artifactId, before.artifactId, "the same G-code artifact — the same bytes");
  assert.equal(reprint.onDeviceFile, before.onDeviceFile, "content-addressed: the same device name");
  assert.equal(reprint.pinnedPrinterId, "k2", "the printer-scoped slice pins its printer again");
  assert.equal(reprint.metadata.reprintOf, task.id);
  assert.equal(reprint.title, before.title);
  assert.equal(reprint.unattendedAllowed, false, "per-print permissions are asked again, never inherited");

  // Its own copy of the variant: same output, same pinned scale, linked back.
  assert.notEqual(reprint.sliceVariantId, before.sliceVariantId);
  const copy = h.store.repositories.sliceVariants.getById(reprint.sliceVariantId!)!;
  const original = h.store.repositories.sliceVariants.getById(before.sliceVariantId!)!;
  assert.equal(copy.taskId, reprint.id);
  assert.equal(copy.outputArtifactId, original.outputArtifactId);
  assert.equal(copy.profileSetId, original.profileSetId);
  assert.deepEqual(copy.metadata.scale, original.metadata.scale);
  assert.equal(copy.metadata.reprintOf, original.id);
  assert.equal(h.runner.sliceCount, slicesBefore, "OrcaSlicer was not run again");

  // The finished print: same row, byte for byte; one audit line says what happened.
  assert.deepEqual(h.store.repositories.tasks.getById(task.id), before);
  const audit = h.store.repositories.audit.listByEntity("print_task", task.id).filter((e) => e.action === "reprinted");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail.newTaskId, reprint.id);
  assert.equal(audit[0].actor, "miha");

  // A retried request answers with the print it already made.
  const again = await h.history.reprintTask(task.id, { requestId: "req-1" });
  assert.equal(again.deduplicated, true);
  assert.equal(again.detail.task.id, reprint.id);
  assert.equal(h.store.repositories.tasks.list().filter((t) => t.metadata.reprintOf === task.id).length, 1);

  // And history links the two.
  const entry = await h.history.entry(task.id);
  assert.deepEqual(entry.lineage.reprintedAs, [reprint.id]);
});

test("the reprint really prints: delivered, started and completed like any job, then listed with its origin", async () => {
  const set = approvedSet();
  const task = await sliceAndQueue(await uploadModel(), set);
  await printToCompletion(task.id);
  // The lifecycle reclaimed the printer's storage after the first print — the
  // reprint must deliver the file again, from the same stored blob.
  assert.deepEqual(h.onDevice.get("k2"), []);

  tick();
  const reprint = (await h.history.reprintTask(task.id)).detail.task;
  await printToCompletion(reprint.id);
  assert.equal(h.store.repositories.tasks.getById(reprint.id)?.state, "COMPLETED");

  const page = await h.history.list();
  assert.deepEqual(
    page.entries.map((e) => e.taskId),
    [reprint.id, task.id],
    "newest first"
  );
  assert.equal(page.entries[0].lineage.reprintOf, task.id);
});

test("two reprints without a request id are two prints — «ещё раз» twice means two parts", async () => {
  const task = await sliceAndQueue(await uploadModel(), approvedSet());
  await printToCompletion(task.id);
  const a = await h.history.reprintTask(task.id);
  const b = await h.history.reprintTask(task.id);
  assert.notEqual(a.detail.task.id, b.detail.task.id);
  assert.equal((await h.history.entry(task.id)).lineage.reprintedAs.length, 2);
});

test("a print that is not finished cannot be «repeated» — it is still the print", async () => {
  const task = await sliceAndQueue(await uploadModel(), approvedSet());
  await assert.rejects(
    () => h.history.reprintTask(task.id),
    (error: unknown) => error instanceof JobError && error.details?.code === "not_finished"
  );
});

test("a deleted file: history says why and offers preparing the model again; the reprint is refused", async () => {
  const set = approvedSet();
  const source = await uploadModel();
  const task = await sliceAndQueue(source, set);
  await printToCompletion(task.id);
  const output = h.store.repositories.artifacts.getById(task.artifactId!)!;
  await h.storage.remove(output.source!);

  const entry = await h.history.entry(task.id);
  assert.equal(entry.actions.reprint.allowed, false);
  assert.equal(entry.actions.reprint.code, "file_deleted");
  assert.deepEqual(entry.actions.reprepare, { artifactId: source, printerId: "k2", profileSetId: set.id });
  await assert.rejects(
    () => h.history.reprintTask(task.id),
    (error: unknown) => error instanceof JobError && error.details?.code === "file_deleted"
  );
  assert.equal(
    h.store.repositories.tasks.list().filter((t) => t.metadata.reprintOf === task.id).length,
    0,
    "a refusal leaves nothing behind"
  );
});

test("«подготовить заново» with the recorded recipe: a new draft linked to that print, served from the cache", async () => {
  const set = approvedSet();
  const source = await uploadModel();
  const task = await sliceAndQueue(source, set);
  await printToCompletion(task.id);
  const hint = (await h.history.entry(task.id)).actions.reprepare!;

  const variant = await h.slices.createSlice({
    artifactId: hint.artifactId,
    profileSetId: hint.profileSetId!,
    targetPrinterId: hint.printerId,
    previousTaskId: task.id
  });
  assert.equal(variant.state, "ready", "the same model, recipe and target come straight from the cache");
  assert.notEqual(variant.taskId, task.id, "a new preparation, never the finished print");
  const draft = h.store.repositories.tasks.getById(variant.taskId)!;
  assert.equal(draft.state, "DRAFT");
  assert.equal(draft.metadata.previousTaskId, task.id);
});

test("an uploaded G-code is reprinted as the file itself; a cancelled queued job is history too", async () => {
  const uploaded = await h.artifacts.ingest({ source: Readable.from(UPLOADED_GCODE), fileName: "part.gcode" });
  await h.artifacts.whenIdle();
  const queued = h.queue.enqueueExecutableArtifact(uploaded.task.id, {}, "miha");
  tick();
  h.queue.cancelTask(queued.task.id, "передумали");

  const entry = (await h.history.list()).entries.find((e) => e.taskId === queued.task.id);
  assert.ok(entry, "a cancelled job that was in the queue is history");
  assert.equal(entry.state, "CANCELLED");
  assert.equal(entry.run, null, "it never reached a printer");
  assert.equal(entry.recipe, null, "nothing was sliced here");
  assert.equal(entry.actions.reprint.route, "executable");

  const result = await h.history.reprintTask(queued.task.id);
  assert.equal(result.route, "executable");
  assert.equal(result.detail.task.artifactId, uploaded.artifact.id, "the uploaded bytes themselves");
  assert.equal(result.detail.task.sliceVariantId, null);
  assert.equal(result.detail.task.state, "QUEUED");
  assert.equal(h.store.repositories.tasks.getById(queued.task.id)?.state, "CANCELLED", "the original stays cancelled");
});

test("an upload's draft cancelled before it ever entered the queue is not a print", async () => {
  const uploaded = await h.artifacts.ingest({ source: Readable.from(UPLOADED_GCODE), fileName: "noise.gcode" });
  await h.artifacts.whenIdle();
  h.queue.cancelTask(uploaded.task.id, "не тот файл");
  assert.equal((await h.history.list()).entries.length, 0);
});

test("a FAILED print can be retried as the same job; it then leaves history", async () => {
  const task = await sliceAndQueue(await uploadModel(), approvedSet());
  tick();
  const assignment = h.queue.assignTask(task.id, "k2", { reason: "test" });
  await h.devices.prepare(assignment.id);
  const started = await h.dispatch.startAssignment(assignment.id, { mode: "manual" });
  h.lifecycle.completeRun(started.runId, "FAILED", { reason: "отлипла деталь" });
  await h.settle();

  const entry = await h.history.entry(task.id);
  assert.equal(entry.state, "FAILED");
  assert.equal(entry.actions.retry.allowed, true);
  assert.equal(entry.actions.reprint.allowed, true);

  h.queue.releaseTask(task.id, "miha");
  assert.equal((await h.history.list()).entries.length, 0, "a retried print is back in the queue, not in history");
});

test("filters and paging: by state, by printer, newest first, a cursor that neither skips nor repeats", async () => {
  const set = approvedSet();
  const printed = await sliceAndQueue(await uploadModel("a.stl", 20), set);
  await printToCompletion(printed.id);

  const ids: string[] = [printed.id];
  for (const name of ["b.gcode", "c.gcode"]) {
    const uploaded = await h.artifacts.ingest({
      source: Readable.from(Buffer.concat([UPLOADED_GCODE, Buffer.from(`\n; ${name}`)])),
      fileName: name
    });
    await h.artifacts.whenIdle();
    const queued = h.queue.enqueueExecutableArtifact(uploaded.task.id, {});
    tick();
    h.queue.cancelTask(queued.task.id);
    ids.unshift(queued.task.id);
  }

  const all = await h.history.list();
  assert.deepEqual(all.entries.map((e) => e.taskId), ids, "newest first");

  const first = await h.history.list({ limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.ok(first.nextCursor);
  const second = await h.history.list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual([...first.entries, ...second.entries].map((e) => e.taskId), ids);
  assert.equal(second.nextCursor, null);

  assert.deepEqual((await h.history.list({ state: "COMPLETED" })).entries.map((e) => e.taskId), [printed.id]);
  assert.deepEqual((await h.history.list({ printerId: "k2" })).entries.map((e) => e.taskId), [printed.id]);
  assert.equal((await h.history.list({ printerId: "elsewhere" })).entries.length, 0);

  await assert.rejects(() => h.history.list({ state: "QUEUED" }), ValidationError);
  await assert.rejects(() => h.history.list({ cursor: "garbage" }), ValidationError);
});

test("variant reprint: a ready slice whose task is history prints again; one its draft can still take is promoted instead", async () => {
  const set = approvedSet();
  const source = await uploadModel();
  const task = await sliceAndQueue(source, set);
  await printToCompletion(task.id);
  const variantId = h.store.repositories.tasks.getById(task.id)!.sliceVariantId!;

  const result = await h.history.reprintVariant(variantId, { requestId: "v-1" });
  assert.equal(result.route, "variant");
  assert.equal(result.detail.task.state, "QUEUED");
  assert.equal(result.detail.task.metadata.reprintOf, task.id);
  const again = await h.history.reprintVariant(variantId, { requestId: "v-1" });
  assert.equal(again.detail.task.id, result.detail.task.id, "retry-safe");

  // A fresh slice of a NEW upload: its draft is waiting for exactly this slice.
  const other = await uploadModel("other.stl", 15);
  const fresh = await h.slices.createSlice({ artifactId: other, profileSetId: set.id, targetPrinterId: "k2" });
  await h.slices.whenIdle();
  await assert.rejects(
    () => h.history.reprintVariant(fresh.id),
    (error: unknown) => error instanceof JobError && error.details?.code === "promote_instead"
  );
});
