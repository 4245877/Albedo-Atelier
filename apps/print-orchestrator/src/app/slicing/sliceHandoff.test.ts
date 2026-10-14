import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { ProfileRevision, ProfileType } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import { normalizePrinterConfig } from "../../infra/printers/config";
import { buildDeviceFileName } from "../../infra/printers/files";
import type { PrinterLiveStatus } from "../../infra/printers/status";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import { ArtifactService } from "../artifacts/artifactService";
import { blockersOf } from "../dispatch/dispatchGate";
import { SchedulerContext } from "../scheduling/context";
import { EligibilityQueries } from "../scheduling/eligibility";
import { EvidenceResolver } from "../scheduling/evidence";
import type { SchedulerPrinterRef } from "../scheduling/types";
import { PrintQueueService } from "../printQueue/printQueueService";
import { ProfileService, type SlicerPrinterRef } from "./profileService";
import { SliceService } from "./sliceService";
import { FakeOrcaRunner } from "./testkit/fakeOrcaRunner";

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
let storage: ArtifactStorage;
let artifacts: ArtifactService;
let runner: FakeOrcaRunner;
let slice: SliceService;
let profiles: ProfileService;
let printQueue: PrintQueueService;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "slice-handoff-"));
  store = openPrintQueueStore(":memory:");
  storage = new ArtifactStorage({ root: path.join(TMP, "artifacts") });
  await storage.init();
  artifacts = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 8 * 1024 * 1024,
    timeoutMs: 10000,
    concurrency: 2
  });
  runner = new FakeOrcaRunner();
  fs.mkdirSync(path.join(TMP, "work"), { recursive: true });
  slice = new SliceService(store, storage, artifacts, runner, {
    tmpRoot: path.join(TMP, "work"),
    timeoutMs: 5000,
    concurrency: 1
  });
  profiles = new ProfileService(store, runner, () => PRINTERS);
  printQueue = new PrintQueueService(store, {
    isPrinterConfigured: (id) => PRINTERS.some((p) => p.id === id)
  });
});

afterEach(() => {
  slice.close();
  artifacts.close();
  store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function binaryStl(seed = 5): Buffer {
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

async function uploadModel(): Promise<{ artifactId: string; taskId: string }> {
  const res = await artifacts.ingest({ source: Readable.from(binaryStl()), fileName: "cube.stl" });
  await artifacts.whenIdle();
  return { artifactId: res.artifact.id, taskId: res.task.id };
}

async function approvedSet(): Promise<string> {
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
  const process = insertRevision("process", "K2 Standard 0.2", {
    layer_height: "0.2",
    initial_layer_print_height: "0.2"
  });
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
  profiles.approveSet(set.id);
  return set.id;
}

function idleStatus(): PrinterLiveStatus {
  return {
    id: "creality-k2",
    online: true,
    status: "idle",
    currentFile: null,
    progressPct: null,
    remainingMinutes: null,
    filamentUsedMm: null,
    amsTrays: null
  } as PrinterLiveStatus;
}

// ── Test ──────────────────────────────────────────────────────────────────────

test("handoff: a ready slice is promoted onto its task, which becomes dispatchable", async () => {
  const { artifactId, taskId } = await uploadModel();
  const setId = await approvedSet();

  // Before the handoff the task is bound to the STL — an un-prepared model.
  const before = printQueue.getTaskDetail(taskId);
  assert.equal(before.task.artifactId, artifactId);
  assert.equal(before.task.state, "DRAFT");
  assert.equal(before.analyses.at(-1)?.verdict, "needs_preparation");

  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  const ready = slice.getVariant(variant.id);
  assert.equal(ready.state, "ready");
  assert.ok(ready.outputArtifactId);

  // Promote: bind the verified output onto the task and enqueue it.
  const detail = printQueue.promoteSliceVariant(ready.id);
  assert.equal(detail.task.state, "QUEUED");
  assert.equal(detail.task.artifactId, ready.outputArtifactId); // now the sliced G-code
  // Typed binding (migration 009): the queue references the exact slice, its
  // source model and the on-device path — not a free-form metadata blob.
  // The on-device name is generated from the output artifact: a sanitized stem
  // plus its content hash, so two same-named models cannot share a device slot.
  const expectedFile = buildDeviceFileName({
    name: "cube.gcode",
    sha256: printQueue.getTaskDetail(detail.task.id).artifact?.sha256 ?? null
  });
  assert.equal(detail.task.onDeviceFile, expectedFile); // an on-device path to start
  assert.equal(detail.task.sourceArtifactId, artifactId); // provenance preserved
  assert.equal(detail.task.sliceVariantId, ready.id);
  assert.equal(detail.task.metadata.file, expectedFile); // legacy projection field kept
  assert.equal(detail.task.pinnedPrinterId, "creality-k2"); // pinned to the sliced-for printer
  assert.equal(detail.queueEntry?.state, "WAITING");

  // The authoritative eligibility now reads the OUTPUT's clean analysis — no
  // NO_FILE, and the verdict/format/blocker checks pass (they blocked on the raw
  // STL before). Same component the physical dispatch runs.
  const printer = normalizePrinterConfig({
    id: "creality-k2",
    name: "Creality K2",
    host: "127.0.0.1",
    protocol: "moonraker",
    material: "PETG"
  });
  assert.ok(printer);
  const eligibility = eligibilityFor(idleStatus());
  const codes = blockersOf(
    eligibility.evaluate({
      taskId: detail.task.id,
      printerId: "creality-k2",
      mode: "manual",
      deviceFileIdentity: "name+size"
    })
  ).map((b) => b.code);
  for (const gone of ["NO_FILE", "ANALYSIS_VERDICT", "ANALYSIS_BLOCKERS", "FORMAT_UNKNOWN"]) {
    assert.ok(!codes.includes(gone), `expected ${gone} cleared, got ${JSON.stringify(codes)}`);
  }
});

/** The production eligibility component over the test store + a fake K2. */
function eligibilityFor(status: PrinterLiveStatus): EligibilityQueries {
  const ref: SchedulerPrinterRef = {
    id: "creality-k2",
    name: "Creality K2",
    model: "Creality K2",
    protocol: "moonraker",
    printerClass: null,
    material: "PETG",
    nozzleMm: 0.4,
    buildVolume: { x: 350, y: 350, z: 350 },
    online: status.online,
    status: status.status as SchedulerPrinterRef["status"],
    remoteStartSupported: true,
    ams: null,
    faults: [],
    mediaPresent: null,
    telemetryAgeMs: 1000,
    materialRemainingSufficient: null,
    printingTimeLeftMs: null,
    activeRunState: null
  };
  const ctx = new SchedulerContext(store, () => [ref], {
    now: () => new Date(),
    runtimeAvailable: true,
    nightSafetyBufferRatio: 0.2,
    nightWindow: "21:30 - 07:30",
    farmTimeZone: "UTC",
    compatibility: { telemetryStaleMs: 120_000 },
    unknownEtaAssumptionS: 4 * 3600
  });
  return new EligibilityQueries(ctx, new EvidenceResolver(ctx));
}

// ── HIGH-09: preparing a promoted model again ────────────────────────────────
//
// Promotion moves a task's executable from the source model onto its slice. The
// model is still the operator's to print again — and slicing it again must open
// a NEW print, never fail for want of a task, and never reach back into the
// first one: that task (queued, printing or finished) and its history stay
// exactly as they were.

/** Upload → slice → promote: the first print of a model, as the operator makes it. */
async function firstPrint(): Promise<{ artifactId: string; setId: string; taskId: string; variantId: string }> {
  const { artifactId, taskId } = await uploadModel();
  const setId = await approvedSet();
  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  const promoted = printQueue.promoteSliceVariant(variant.id);
  assert.equal(promoted.task.id, taskId);
  assert.equal(promoted.task.state, "QUEUED");
  return { artifactId, setId, taskId, variantId: variant.id };
}

/** Everything that is the first print's record: the row, its queue entry, its audit trail. */
function recordOf(taskId: string) {
  const repos = store.repositories;
  return {
    task: repos.tasks.getById(taskId),
    entry: repos.queue.findByTaskId(taskId),
    audit: repos.audit.listByEntity("print_task", taskId),
    variants: repos.sliceVariants.listByTask(taskId)
  };
}

function tasksOfModel(artifactId: string) {
  return store.repositories.tasks.listReferencingArtifact(artifactId);
}

test("HIGH-09: upload → slice → promote → slice the same model again opens a new print; the first is untouched", async () => {
  const first = await firstPrint();
  const before = recordOf(first.taskId);

  // Fresh slice (no cache) of the same model with the same approved set.
  const again = await slice.createSlice({ artifactId: first.artifactId, profileSetId: first.setId, force: true });
  await slice.whenIdle();
  const ready = slice.getVariant(again.id);
  assert.equal(ready.state, "ready");

  // A NEW draft, bound to the source model, linked to the print it repeats.
  assert.notEqual(ready.taskId, first.taskId);
  const draft = store.repositories.tasks.getById(ready.taskId);
  assert.ok(draft);
  assert.equal(draft.state, "DRAFT");
  assert.equal(draft.artifactId, first.artifactId);
  assert.equal(draft.sourceArtifactId, first.artifactId);
  assert.equal(draft.sliceVariantId, null);
  assert.equal(draft.onDeviceFile, null);
  assert.equal(draft.title, before.task?.title);
  assert.equal(draft.metadata.source, "reprepare");
  assert.equal(draft.metadata.previousTaskId, first.taskId);
  assert.equal(store.repositories.queue.findByTaskId(draft.id), null, "a draft is not enqueued");
  const created = store.repositories.audit.listByEntity("print_task", draft.id);
  assert.deepEqual(
    created.map((e) => [e.action, e.detail?.via, e.detail?.previousTaskId]),
    [["created", "reprepare", first.taskId]]
  );

  // The first print: same row (version included), same entry, same history.
  assert.deepEqual(recordOf(first.taskId), before);

  // Promoting the new slice makes a second, independent queued print.
  const second = printQueue.promoteSliceVariant(ready.id);
  assert.equal(second.task.id, draft.id);
  assert.equal(second.task.state, "QUEUED");
  assert.equal(second.task.artifactId, ready.outputArtifactId);
  assert.equal(second.task.sliceVariantId, ready.id);
  assert.equal(second.task.sourceArtifactId, first.artifactId);
  assert.equal(second.queueEntry?.state, "WAITING");
  assert.notEqual(second.queueEntry?.id, before.entry?.id);
  assert.deepEqual(recordOf(first.taskId), before, "promoting the second print leaves the first one alone");

  // Each print's detail carries only its own slices.
  assert.deepEqual(printQueue.getTaskDetail(first.taskId).sliceVariants.map((v) => v.id), [first.variantId]);
  assert.deepEqual(printQueue.getTaskDetail(draft.id).sliceVariants.map((v) => v.id), [ready.id]);
  assert.equal(tasksOfModel(first.artifactId).length, 2);
});

test("HIGH-09: a cache hit on the repeat slice still opens its own print, sharing the verified output", async () => {
  const first = await firstPrint();
  const firstOutput = slice.getVariant(first.variantId).outputArtifactId;
  const before = recordOf(first.taskId);
  const slicesBefore = runner.sliceCount;

  const again = await slice.createSlice({ artifactId: first.artifactId, profileSetId: first.setId });
  assert.equal(again.state, "ready", "same model + same profiles → served from cache");
  assert.equal(runner.sliceCount, slicesBefore, "OrcaSlicer was not run again");
  assert.equal(again.outputArtifactId, firstOutput);
  assert.notEqual(again.taskId, first.taskId);
  assert.equal(store.repositories.tasks.getById(again.taskId)?.state, "DRAFT");

  const second = printQueue.promoteSliceVariant(again.id);
  assert.equal(second.task.artifactId, firstOutput);
  assert.notEqual(second.task.id, first.taskId);
  assert.deepEqual(recordOf(first.taskId), before);
});

test("HIGH-09: repeat slices before promotion join one new draft — not a draft each", async () => {
  const first = await firstPrint();

  const a = await slice.createSlice({ artifactId: first.artifactId, profileSetId: first.setId, force: true });
  const b = await slice.createSlice({ artifactId: first.artifactId, profileSetId: first.setId, force: true });
  await slice.whenIdle();
  const c = await slice.createSlice({ artifactId: first.artifactId, profileSetId: first.setId });

  assert.notEqual(a.taskId, first.taskId);
  assert.equal(b.taskId, a.taskId);
  assert.equal(c.taskId, a.taskId);
  assert.equal(tasksOfModel(first.artifactId).length, 2, "the first print and ONE new preparation");
});

test("HIGH-09: a refused repeat slice leaves no empty draft behind", async () => {
  const first = await firstPrint();
  const tasksBefore = store.repositories.tasks.list().length;

  // The set is bound to the K2: a request aimed elsewhere is refused — after the
  // point where a preparation used to be opened.
  await assert.rejects(
    slice.createSlice({ artifactId: first.artifactId, profileSetId: first.setId, targetPrinterId: "creality-ke" }),
    /привязан к принтеру/
  );
  assert.equal(store.repositories.tasks.list().length, tasksBefore);
  assert.equal(store.repositories.tasks.findPreparableBySource(first.artifactId), null);
});

test("HIGH-09: a double-submitted repeat slice opens one draft and runs OrcaSlicer once", async () => {
  const first = await firstPrint();
  // An unpinned runtime probes the slicer before keying the cache — an `await`
  // inside createSlice, so two requests really interleave. A different detected
  // version keys a cache miss: the second request must find the FIRST one's
  // in-flight slice, on the draft the first one opened.
  const unpinned = new FakeOrcaRunner({ pinnedVersion: null, detectedVersion: "2.3.1" });
  const racing = new SliceService(store, storage, artifacts, unpinned, {
    tmpRoot: path.join(TMP, "work"),
    timeoutMs: 5000,
    concurrency: 1
  });
  try {
    const [x, y] = await Promise.all([
      racing.createSlice({ artifactId: first.artifactId, profileSetId: first.setId }),
      racing.createSlice({ artifactId: first.artifactId, profileSetId: first.setId })
    ]);
    await racing.whenIdle();
    assert.equal(x.id, y.id, "the second request is answered by the first one's slice");
    assert.notEqual(x.taskId, first.taskId);
    assert.equal(tasksOfModel(first.artifactId).length, 2, "one new draft, not two");
    assert.deepEqual(store.repositories.sliceVariants.listByTask(x.taskId).map((v) => v.id), [x.id]);
    assert.equal(unpinned.sliceCount, 1);
    assert.equal(racing.getVariant(x.id).state, "ready");
  } finally {
    racing.close();
  }
});

test("HIGH-09: dedup never hands back an in-flight slice made for another print", async () => {
  // Two uploads of the same bytes are two prints with one cache key. A slice of
  // the second must belong to the second, even while the first's is in flight.
  const one = await uploadModel();
  const two = await uploadModel();
  const setId = await approvedSet();

  const forOne = await slice.createSlice({ artifactId: one.artifactId, profileSetId: setId });
  const forTwo = await slice.createSlice({ artifactId: two.artifactId, profileSetId: setId });
  await slice.whenIdle();

  assert.equal(forOne.taskId, one.taskId);
  assert.equal(forTwo.taskId, two.taskId);
  assert.notEqual(forTwo.id, forOne.id);
  assert.equal(slice.getVariant(forTwo.id).sourceArtifactId, two.artifactId);
});

test("HIGH-09: a model whose first print is closed is prepared again; the closed print keeps its record", async () => {
  for (const close of ["CANCELLED", "COMPLETED"] as const) {
    const first = await firstPrint();
    if (close === "CANCELLED") {
      printQueue.cancelTask(first.taskId, "оператор передумал");
    } else {
      // The run lifecycle's end state, written directly: this test is about what
      // slicing does to a finished print, not about how a print finishes.
      const t = store.repositories.tasks.getById(first.taskId);
      assert.ok(t);
      store.repositories.tasks.update({ ...t, state: "COMPLETED", updatedAt: new Date().toISOString() });
    }
    const before = recordOf(first.taskId);
    assert.equal(before.task?.state, close);

    // The upload card returns to the model's own flow instead of "already in
    // work": first the steps the model still owes (its units) …
    const owed = artifacts.getArtifactDetail(first.artifactId);
    assert.equal(owed.status.next.kind, "confirm_scale");
    assert.equal(owed.status.next.taskId, null);
    artifacts.confirmModelScale(first.artifactId, { units: "millimeter", actor: "miha" });

    // … then the slice that opens the next print.
    const card = artifacts.getArtifactDetail(first.artifactId);
    assert.equal(card.status.next.kind, "slice", `card after ${close}: ${card.status.next.explanation}`);
    assert.equal(card.status.next.taskId, null);
    assert.match(card.status.next.explanation, /нарежьте модель заново/);

    const again = await slice.createSlice({ artifactId: first.artifactId, profileSetId: first.setId });
    assert.notEqual(again.taskId, first.taskId);
    const draft = store.repositories.tasks.getById(again.taskId);
    assert.equal(draft?.metadata.previousTaskId, first.taskId);
    assert.deepEqual(recordOf(first.taskId), before, `the ${close} print is history and stays so`);

    // The card now follows the new preparation.
    assert.equal(artifacts.getArtifactDetail(first.artifactId).task?.id, again.taskId);
  }
});

test("HIGH-09: re-running a promoted variant is refused — it would rewrite that print's output", async () => {
  const first = await firstPrint();
  const variantBefore = slice.getVariant(first.variantId);
  const before = recordOf(first.taskId);

  assert.throws(() => slice.rerun(first.variantId), /стал заданием/);
  await slice.whenIdle();
  assert.deepEqual(slice.getVariant(first.variantId), variantBefore);
  assert.deepEqual(recordOf(first.taskId), before);
});

test("handoff refuses a variant whose output is not schedulable", async () => {
  const { artifactId } = await uploadModel();
  const setId = await approvedSet();
  // A forbidden command in the output → the variant is blocked (see #3), never ready.
  runner.gcode = "; generated by OrcaSlicer 2.3.0\n; printer_model = Creality K2\n; filament_type = PETG\nG21\nG90\nM502\nG1 X10 Y10 E1\n";
  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  const blockedVariant = slice.getVariant(variant.id);
  assert.equal(blockedVariant.state, "blocked");
  // Promoting a non-ready variant is refused outright.
  assert.throws(() => printQueue.promoteSliceVariant(blockedVariant.id), /не готов|непровер/i);
});
