import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { ProfileRevision, ProfileType } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ArtifactService } from "../artifacts/artifactService";
import { PrintQueueService } from "../printQueue/printQueueService";
import { ProfileService, type SlicerPrinterRef } from "./profileService";
import { MAX_SLICE_BATCH, SliceService } from "./sliceService";
import { FakeOrcaRunner } from "./testkit/fakeOrcaRunner";

/*
 * **Пакетная подготовка**: several models, one recipe, one printer.
 *
 * A batch is not a second way to slice — every model goes through `createSlice`
 * with all its checks — it is a request shape: the recipe refuses the whole
 * request (it would refuse every model alike), a model that cannot be sliced
 * gets its own row, and «поставить готовые в очередь» promotes each on its own.
 */

const LIMITS = {
  zipMaxEntries: 1000,
  zipMaxEntryBytes: 64 * 1024 * 1024,
  zipMaxTotalBytes: 128 * 1024 * 1024,
  zipMaxRatio: 200,
  xmlMaxBytes: 16 * 1024 * 1024
};

const PRINTERS: SlicerPrinterRef[] = [
  { id: "creality-k2", name: "Creality K2", model: "Creality K2", material: "PETG", protocol: "moonraker" }
];

let TMP: string;
let store: PrintQueueStore;
let artifacts: ArtifactService;
let runner: FakeOrcaRunner;
let slices: SliceService;
let profiles: ProfileService;
let queue: PrintQueueService;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "slice-batch-"));
  store = openPrintQueueStore(":memory:");
  const storage = new ArtifactStorage({ root: path.join(TMP, "artifacts") });
  await storage.init();
  artifacts = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 8 * 1024 * 1024,
    timeoutMs: 10000,
    concurrency: 2
  });
  runner = new FakeOrcaRunner();
  fs.mkdirSync(path.join(TMP, "work"), { recursive: true });
  slices = new SliceService(store, storage, artifacts, runner, {
    tmpRoot: path.join(TMP, "work"),
    timeoutMs: 5000,
    concurrency: 1
  });
  profiles = new ProfileService(store, runner, () => PRINTERS);
  queue = new PrintQueueService(store, { isPrinterConfigured: (id) => PRINTERS.some((p) => p.id === id) });
});

afterEach(() => {
  slices.close();
  artifacts.close();
  store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function binaryStl(seed: number): Buffer {
  const header = Buffer.alloc(84);
  header.writeUInt32LE(1, 80);
  const tri = Buffer.alloc(50);
  let o = 12;
  for (const v of [[0, 0, 0], [10, 0, 0], [10, 10, seed]]) {
    tri.writeFloatLE(v[0], o);
    tri.writeFloatLE(v[1], o + 4);
    tri.writeFloatLE(v[2], o + 8);
    o += 12;
  }
  return Buffer.concat([header, tri]);
}

async function upload(name: string, bytes: Buffer): Promise<string> {
  const res = await artifacts.ingest({ source: Readable.from(bytes), fileName: name });
  await artifacts.whenIdle();
  return res.artifact.id;
}

function insertRevision(type: ProfileType, name: string, resolved: Record<string, unknown>): ProfileRevision {
  const raw = JSON.stringify({ name, type, ...resolved });
  const rev: ProfileRevision = {
    id: newId(ID_PREFIX.profileRevision),
    logicalId: `${type}:${name}`,
    type,
    name,
    inherits: null,
    status: "active",
    rawJson: raw,
    rawSha256: `${name}-${Math.random()}`,
    resolvedJson: raw,
    resolvedSha256: `${name}-resolved`,
    orcaVersion: "2.3.0",
    source: null,
    warnings: [],
    blockers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    metadata: {}
  };
  store.repositories.profileRevisions.insert(rev);
  return rev;
}

function makeSet(approve = true): string {
  const machine = insertRevision("machine", "Creality K2 0.4", {
    nozzle_diameter: ["0.4"],
    printer_variant: "0.4",
    printer_model: "Creality K2",
    gcode_flavor: "klipper",
    max_layer_height: ["0.3"],
    min_layer_height: ["0.08"],
    printable_area: ["0x0", "260x0", "260x260", "0x260"],
    printable_height: "260"
  });
  const process = insertRevision("process", "K2 Standard 0.2", { layer_height: "0.2", initial_layer_print_height: "0.2" });
  const filament = insertRevision("filament", "PETG @K2", {
    filament_type: ["PETG"],
    nozzle_temperature: ["245"],
    nozzle_temperature_initial_layer: ["245"]
  });
  const set = profiles.createSet({
    name: "K2 · PETG",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId: "creality-k2"
  });
  if (approve) profiles.approveSet(set.id);
  return set.id;
}

const GCODE = Buffer.from(["; generated by PrusaSlicer 2.7.1", "; printer_model = MK4", "; filament_type = PLA", "G1 X1 Y1"].join("\n"));

test("a batch slices every model with one recipe; one that is not a model gets its own row", async () => {
  const setId = makeSet();
  const a = await upload("a.stl", binaryStl(3));
  const b = await upload("b.stl", binaryStl(7));
  const g = await upload("part.gcode", GCODE);

  const batch = await slices.createBatch({ artifactIds: [a, g, b], profileSetId: setId, targetPrinterId: "creality-k2" });
  assert.match(batch.batchId, /^sbt_/);
  assert.deepEqual(batch.items.map((i) => [i.artifactId, i.ok]), [[a, true], [g, false], [b, true]]);
  const refused = batch.items[1];
  assert.equal(refused.ok ? null : refused.code, "VALIDATION");
  assert.match(refused.ok ? "" : refused.error, /исходной моделью/);

  await slices.whenIdle();
  const variants = batch.items.flatMap((i) => (i.ok ? [slices.getVariant(i.variant.id)] : []));
  assert.deepEqual(variants.map((v) => v.state), ["ready", "ready"]);
  assert.ok(variants.every((v) => v.metadata.batchId === batch.batchId), "each variant knows its batch");
  assert.ok(variants.every((v) => v.targetPrinterId === "creality-k2"));
  assert.equal(new Set(variants.map((v) => v.taskId)).size, 2, "one preparation per model, never shared");

  const promoted = queue.promoteSliceVariants(variants.map((v) => v.id));
  assert.ok(promoted.every((p) => p.ok));
  for (const item of promoted) {
    const task = store.repositories.tasks.getById(item.ok ? item.taskId : "")!;
    assert.equal(task.state, "QUEUED");
    assert.equal(store.repositories.queue.findByTaskId(task.id)?.state, "WAITING");
  }
});

test("the recipe refuses the whole request; an empty, oversized or duplicated list is shaped first", async () => {
  const a = await upload("a.stl", binaryStl(3));
  const unapproved = makeSet(false);
  await assert.rejects(() => slices.createBatch({ artifactIds: [a], profileSetId: unapproved }), JobError);
  await assert.rejects(() => slices.createBatch({ artifactIds: [a], profileSetId: "pset_missing" }), NotFoundError);

  const setId = makeSet();
  await assert.rejects(() => slices.createBatch({ artifactIds: [], profileSetId: setId }), ValidationError);
  await assert.rejects(
    () =>
      slices.createBatch({
        artifactIds: Array.from({ length: MAX_SLICE_BATCH + 1 }, (_, i) => `art_${i}`),
        profileSetId: setId
      }),
    ValidationError
  );

  const once = await slices.createBatch({ artifactIds: [a, a, ` ${a} `], profileSetId: setId });
  assert.equal(once.items.length, 1, "the same model twice is one slice");
  assert.equal(slices.listVariants().length, 1);
});

test("an unknown model is a row, not a failed request", async () => {
  const setId = makeSet();
  const a = await upload("a.stl", binaryStl(3));
  const batch = await slices.createBatch({ artifactIds: ["art_missing", a], profileSetId: setId });
  assert.deepEqual(batch.items.map((i) => i.ok), [false, true]);
  assert.equal(batch.items[0].ok ? null : batch.items[0].code, "NOT_FOUND");
});

test("promoting a batch: a variant that is not ready is reported in its row, the others are queued", async () => {
  const setId = makeSet();
  const a = await upload("a.stl", binaryStl(3));
  const b = await upload("b.stl", binaryStl(9));
  runner.behavior = "ok";
  const batch = await slices.createBatch({ artifactIds: [a, b], profileSetId: setId });
  await slices.whenIdle();
  const [va, vb] = batch.items.map((i) => (i.ok ? i.variant.id : ""));

  // Make one fail its slice by re-running it against a broken slicer.
  runner.behavior = "fail";
  slices.rerun(vb);
  await slices.whenIdle();
  assert.equal(slices.getVariant(vb).state, "failed");

  const items = queue.promoteSliceVariants([va, vb, "slc_missing"]);
  assert.deepEqual(items.map((i) => i.ok), [true, false, false]);
  assert.match(items[1].ok ? "" : items[1].error, /не готов/);
  assert.equal(items[2].ok ? null : items[2].code, "NOT_FOUND");
  assert.throws(() => queue.promoteSliceVariants([]), ValidationError);
});

test("a second batch of models already in the queue prepares NEW prints from the cache, never touching the queued ones", async () => {
  const setId = makeSet();
  const a = await upload("a.stl", binaryStl(3));
  const first = await slices.createBatch({ artifactIds: [a], profileSetId: setId });
  await slices.whenIdle();
  const firstVariant = first.items[0].ok ? first.items[0].variant.id : "";
  const [queued] = queue.promoteSliceVariants([firstVariant]);
  const queuedTask = store.repositories.tasks.getById(queued.ok ? queued.taskId : "")!;
  const sliced = runner.sliceCount;

  const second = await slices.createBatch({ artifactIds: [a], profileSetId: setId });
  const variant = second.items[0].ok ? second.items[0].variant : null;
  assert.equal(variant?.state, "ready", "served from the cache");
  assert.equal(runner.sliceCount, sliced, "OrcaSlicer was not run again");
  assert.notEqual(variant?.taskId, queuedTask.id);
  assert.deepEqual(store.repositories.tasks.getById(queuedTask.id), queuedTask, "the queued print is untouched");
});
