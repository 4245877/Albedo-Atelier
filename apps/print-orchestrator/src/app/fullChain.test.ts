import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { ID_PREFIX, newId } from "../domain/print/ids";
import type { PrintQueueStore } from "../domain/print/repositories";
import type { ProfileRevision, ProfileSet, ProfileType } from "../domain/slicing/types";
import { openPrintQueueStore } from "../infra/db/store";
import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterFilesListing } from "../infra/printers/files";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { ArtifactStorage } from "../infra/storage/artifactStorage";
import { ArtifactService } from "./artifacts/artifactService";
import { DeviceArtifactService } from "./dispatch/deviceArtifactService";
import { DispatchService, type DispatchDeps } from "./dispatch/dispatchService";
import { RunLifecycleService } from "./dispatch/runLifecycle";
import { EventFeed } from "./eventFeed";
import { FilamentConsumption } from "./filamentConsumption";
import { ManualOperationService } from "./operations/manualOperationService";
import { OperatorScheduleService } from "./operations/operatorScheduleService";
import { PrintQueueService } from "./printQueue/printQueueService";
import { EligibilityQueries } from "./scheduling/eligibility";
import { SchedulerContext } from "./scheduling/context";
import { EvidenceResolver } from "./scheduling/evidence";
import type { SchedulerPrinterRef } from "./scheduling/types";
import { SliceService } from "./slicing/sliceService";
import { ProfileService } from "./slicing/profileService";
import { FakeOrcaRunner } from "./slicing/testkit/fakeOrcaRunner";

/*
 * **The whole chain, end to end, on real services.**
 *
 * Every fix in this audit closed one link. This walks all of them in order, on
 * the actual implementations — the real SQLite store, the real analyzer, the
 * real slice pipeline (with a fake Orca binary), the real delivery, dispatch,
 * run lifecycle, operations and consumption — because a chain can be correct
 * link by link and still not connect:
 *
 *   upload → analyse → confirm scale → slice → ingest the result →
 *   evaluate compatibility → prepare the device file → upload → start →
 *   observe RUNNING → observe completion → close the run → open the removal
 *   operation → reconcile filament → reclaim the remote file
 *
 * Only the two device boundaries are faked (the printer's filesystem and its
 * start command), because everything above them is what this is testing.
 */

const ISO = "2026-08-28T12:00:00.000Z";

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
  },
  {
    id: "bambu-a1",
    name: "Bambu Lab A1",
    model: "Bambu Lab A1",
    type: "FDM",
    protocol: "bambu",
    host: "127.0.0.2",
    material: "PETG",
    serial: "03919D551805635",
    accessCode: "d1eea97d",
    allowInsecureTls: true,
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
  filament: FilamentConsumption;
  runner: FakeOrcaRunner;
  onDevice: Map<string, { path: string; size: number }[]>;
  deletes: { printerId: string; remotePath: string }[];
  startCalls: { printerId: string; file: string }[];
  consumed: Record<string, unknown>[];
  /**
   * Awaits the housekeeping the lifecycle starts and deliberately does not wait
   * for. Closing a run must not block on a printer's filesystem, so the reclaim
   * is fire-and-forget in production; a test still has to join it, or it asserts
   * against a race and leaks work past the store it runs on.
   */
  settle: () => Promise<void>;
}

let TMP: string;
let h: Harness;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "full-chain-"));
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
  const storage = new ArtifactStorage({ root: path.join(tmp, "artifacts") });
  await storage.init();

  const onDevice = new Map<string, { path: string; size: number }[]>();
  const deletes: Harness["deletes"] = [];
  const startCalls: Harness["startCalls"] = [];
  const consumed: Harness["consumed"] = [];

  const artifacts = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 8 * 1024 * 1024,
    timeoutMs: 15_000,
    concurrency: 2
  });
  const runner = new FakeOrcaRunner();
  fs.mkdirSync(path.join(tmp, "work"), { recursive: true });
  const slices = new SliceService(store, storage, artifacts, runner, {
    tmpRoot: path.join(tmp, "work"),
    timeoutMs: 5000,
    concurrency: 1,
    listPrinters: () => slicerRefs()
  });
  const profiles = new ProfileService(store, runner, () => slicerRefs());
  const queue = new PrintQueueService(store, {
    now: () => new Date(ISO),
    isPrinterConfigured: (id) => PRINTERS.some((p) => p.id === id)
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
      onDevice.set(printer.id, [
        ...files.filter((f) => f.path !== remotePath),
        { path: remotePath, size: bytes.byteLength }
      ]);
      return { remotePath, sizeBytes: bytes.byteLength };
    },
    deleteFile: async (printer, remotePath) => {
      const files = onDevice.get(printer.id) ?? [];
      onDevice.set(printer.id, files.filter((f) => f.path !== remotePath));
      deletes.push({ printerId: printer.id, remotePath });
    },
    now: () => new Date(ISO)
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

  const eligibility = (): EligibilityQueries => {
    const ctx = new SchedulerContext(store, refs, {
      now: () => new Date(ISO),
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
    startPhysical: async (printerId, file) => void startCalls.push({ printerId, file }),
    classifyError: () => "unknown",
    listFiles,
    evaluateEligibility: (input) => eligibility().evaluate(input),
    now: () => new Date(ISO)
  };

  const operations = new ManualOperationService(store, new OperatorScheduleService(store));
  const housekeeping: Promise<unknown>[] = [];
  const lifecycle = new RunLifecycleService(store, {
    operations,
    reclaimStorage: (printerId) => void housekeeping.push(devices.reclaim({ printerId }))
  });
  const filament = new FilamentConsumption(
    {
      enabled: true,
      consume: async (input) => void consumed.push(input as unknown as Record<string, unknown>)
    },
    new EventFeed()
  );

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
    filament,
    runner,
    onDevice,
    deletes,
    startCalls,
    consumed,
    settle: async () => {
      while (housekeeping.length) await housekeeping.shift();
    }
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A 20 mm cube as a binary STL — unit-less, like every STL. */
function cubeStl(): Buffer {
  const tris: [number, number, number][][] = [
    [[0, 0, 0], [20, 0, 0], [20, 20, 0]],
    [[0, 0, 0], [20, 20, 0], [0, 20, 0]],
    [[0, 0, 20], [20, 0, 20], [20, 20, 20]],
    [[0, 0, 0], [0, 0, 20], [20, 0, 20]]
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

function revision(type: ProfileType, name: string, settings: Record<string, unknown>): ProfileRevision {
  const raw = JSON.stringify({ name, type, ...settings });
  const rev: ProfileRevision = {
    id: newId(ID_PREFIX.profileRevision),
    logicalId: `${type}:${name}`,
    type,
    name,
    inherits: null,
    status: "active",
    rawJson: raw,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    resolvedJson: raw,
    resolvedSha256: createHash("sha256").update(raw).digest("hex"),
    orcaVersion: "2.3.0",
    source: null,
    warnings: [],
    blockers: [],
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  h.store.repositories.profileRevisions.insert(rev);
  return rev;
}

/** An approved profile set targeting the K2 class. */
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
    nozzleType: null,
    activeFilament: null,
    nozzleTemp: null,
    nozzleTarget: null,
    bedTemp: null,
    bedTarget: null,
    chamberTemp: null,
    light: null,
    stateText: null,
    stateMessage: null,
    faults: [],
    mediaPresent: true,
    error: null,
    updatedAt: ISO,
    ...over
  } as PrinterLiveStatus;
}

// ── The whole chain ─────────────────────────────────────────────────────────

test("STL → analysis → slice → prepare → start → print → completion → clearance → accounting → cleanup", async () => {
  // The fake slicer produces a G-code whose box really is the model's, so the
  // size the checks verified and the size that was sliced can be compared.
  h.runner.sourceBox = { x: 20, y: 20, z: 20 };

  // 1 ── Upload a model. The analyzer runs for real.
  const uploaded = await h.artifacts.ingest({ source: Readable.from(cubeStl()), fileName: "cube.stl" });
  await h.artifacts.whenIdle();
  const sourceAnalysis = h.store.repositories.artifactAnalyses.latestForArtifact(uploaded.artifact.id);
  assert.equal(sourceAnalysis?.state, "ready");
  assert.equal(sourceAnalysis?.verdict, "needs_preparation", "an STL is source, not a print");
  assert.equal(
    (sourceAnalysis?.data.geometry as { scaleKnown: boolean }).scaleKnown,
    false,
    "an STL declares no unit — nobody may assume millimetres"
  );

  // 2 ── The operator states what the numbers mean. Bound to these exact bytes.
  h.artifacts.confirmModelScale(uploaded.artifact.id, { units: "millimeter", actor: "miha" });

  // 3 ── Slice. The confirmed scale reaches the slicer, and the produced size is
  //      verified against the size the checks will use.
  const set = approvedSet();
  const variant = await h.slices.createSlice({
    artifactId: uploaded.artifact.id,
    profileSetId: set.id,
    targetPrinterClass: "k2"
  });
  await h.slices.whenIdle();
  const sliced = h.slices.getVariant(variant.id);
  assert.equal(sliced.state, "ready", sliced.error ?? "");
  assert.equal(h.runner.lastScaleFactor, 1, "millimetres need no factor");
  assert.ok(sliced.outputArtifactId, "the slice produced a real, analysed artifact");
  assert.ok((sliced.orcaEtaS ?? 0) > 0, "and the slicer's own ETA came back with it");

  // 4 ── Promote onto the queue, place it, and deliver the file.
  const detail = h.queue.promoteSliceVariant(variant.id);
  const assignment = h.queue.assignTask(detail.task.id, "k2", { reason: "свободен" });
  const prepared = await h.devices.prepare(assignment.id);
  assert.equal(prepared.ready, true);
  const remotePath = prepared.deviceArtifact.remotePath;
  assert.match(remotePath, /\.gcode$/, "Klipper is handed a bare .gcode");
  assert.deepEqual(
    (h.onDevice.get("k2") ?? []).map((f) => f.path),
    [remotePath],
    "the bytes really are on the device"
  );

  // 5 ── Start. The eligibility gate runs inside the dispatch transaction.
  const started = await h.dispatch.startAssignment(assignment.id, { mode: "manual", actor: "miha" });
  assert.deepEqual(h.startCalls, [{ printerId: "k2", file: remotePath }]);
  const runId = started.runId;
  assert.equal(h.store.repositories.printRuns.getById(runId)?.state, "RUNNING");

  // 6 ── The printer reports the job under its own name for the file.
  const printing = status({ status: "printing", currentFile: remotePath, progressPct: 5 });
  h.lifecycle.observe("k2", undefined, printing);
  const running = h.store.repositories.printRuns.getById(runId)!;
  assert.equal(running.state, "RUNNING", "identity survives the round trip");
  assert.equal(running.metadata.identityLost, undefined);

  // 7 ── The ending is OBSERVED, with an explicit terminal state.
  h.lifecycle.observe(
    "k2",
    printing,
    status({ status: "idle", stateText: "complete", progressPct: 100, filamentUsedMm: 4200 })
  );
  await h.settle();
  const finished = h.store.repositories.printRuns.getById(runId)!;
  assert.equal(finished.state, "SUCCEEDED");
  assert.equal(h.store.repositories.tasks.getById(detail.task.id)?.state, "COMPLETED");
  assert.equal(
    h.store.repositories.assignments.getById(assignment.id)?.state,
    "RELEASED",
    "the placement is consumed, not left open"
  );

  // 8 ── The bed asks for the part, and a real operation exists to ask with.
  const bed = h.store.repositories.bedCycles.getById(finished.bedCycleId!)!;
  assert.equal(bed.state, "AWAITING_CLEARANCE");
  const clearance = h.operations.openClearanceOperations("k2");
  assert.equal(clearance.length, 1, "a removal operation is waiting for a human");

  // 9 ── Accounting: a measured length is deducted; nothing is invented.
  h.filament.consumeForPrint(
    PRINTERS[0],
    printing,
    status({ status: "idle", filamentUsedMm: 4200 }),
    { printId: runId, amsStart: null, estimatedGrams: sliced.filamentG },
    remotePath
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.consumed.length, 1, "the print's filament was posted to the warehouse");
  assert.equal(h.consumed[0].lengthMm, 4200);
  assert.equal(h.filament.listUnreconciled().length, 0, "and nothing is left owing");

  // 10 ── Closing the run invited the printer's storage to be freed, and it was —
  //       the delete is housekeeping the lifecycle starts but never waits for.
  assert.deepEqual(h.deletes, [{ printerId: "k2", remotePath }]);
  assert.deepEqual(h.onDevice.get("k2"), [], "the printer's storage is freed");
  // Repeating it is a no-op rather than a second delete or an error: sweeps run
  // on a timer, and the row is already NOT_PRESENT.
  const again = await h.devices.reclaim({ printerId: "k2" });
  assert.equal(again.deleted, 0);
  assert.equal(again.failed, 0);
  assert.equal(h.deletes.length, 1, "a repeated sweep does not re-delete");

  // 11 ── And the clearance still closes the bed only on a named confirmation.
  h.operations.complete(clearance[0].id, { actor: "miha" });
  assert.equal(h.store.repositories.bedCycles.getById(bed.id)?.state, "CLEAR");
});

test("the chain refuses to complete when the ending is ambiguous, and leaves every hold in place", async () => {
  // The mirror image: an ending nobody witnessed as terminal must not close the
  // task, must not deduct, and must not free the printer.
  h.runner.sourceBox = { x: 20, y: 20, z: 20 };
  const uploaded = await h.artifacts.ingest({ source: Readable.from(cubeStl()), fileName: "cube.stl" });
  await h.artifacts.whenIdle();
  h.artifacts.confirmModelScale(uploaded.artifact.id, { units: "millimeter", actor: "miha" });
  const set = approvedSet();
  const variant = await h.slices.createSlice({
    artifactId: uploaded.artifact.id,
    profileSetId: set.id,
    targetPrinterClass: "k2"
  });
  await h.slices.whenIdle();
  const detail = h.queue.promoteSliceVariant(variant.id);
  const assignment = h.queue.assignTask(detail.task.id, "k2", { reason: "свободен" });
  const prepared = await h.devices.prepare(assignment.id);
  const remotePath = prepared.deviceArtifact.remotePath;
  const started = await h.dispatch.startAssignment(assignment.id, { mode: "manual", actor: "miha" });

  const printing = status({ status: "printing", currentFile: remotePath, progressPct: 99.5 });
  h.lifecycle.observe("k2", undefined, printing);
  // The printer stops at 99.5 % and says nothing about why. High progress is not
  // a terminal state, and treating it as one is how an unfinished part gets
  // recorded as a success.
  h.lifecycle.observe("k2", printing, status({ status: "idle", progressPct: 99.5 }));

  const run = h.store.repositories.printRuns.getById(started.runId)!;
  assert.equal(run.state, "UNKNOWN", "an ambiguous ending is a question, not a success");
  // The operator has to be told how far it got — "почти закончилась" is the case
  // most likely to be waved through, and the one where a wrong guess costs a reprint.
  const journalled = h.store.repositories.audit
    .list(200)
    .find((e) => e.entityId === run.id && JSON.stringify(e.detail ?? {}).includes("99.5"));
  assert.ok(journalled, "the progress at the ending is recorded with the transition");
  assert.notEqual(h.store.repositories.tasks.getById(detail.task.id)?.state, "COMPLETED");

  // Nothing is released while the question is open.
  assert.equal(h.operations.openClearanceOperations("k2").length, 0, "no clearance for a print that may still be on");
  const reclaimed = await h.devices.reclaim({ printerId: "k2" });
  assert.equal(reclaimed.deleted, 0, "the file stays until the run is resolved");
  assert.deepEqual(h.deletes, []);

  // The operator resolves it, and only then does the chain continue.
  h.lifecycle.resolveRun(started.runId, "SUCCEEDED", { status: status({ status: "idle" }), actor: "miha" });
  await h.settle();
  assert.equal(h.store.repositories.printRuns.getById(started.runId)?.state, "SUCCEEDED");
  assert.equal(h.store.repositories.tasks.getById(detail.task.id)?.state, "COMPLETED");
  assert.equal(h.operations.openClearanceOperations("k2").length, 1);
  // And everything the open question was holding back now proceeds — the same
  // housekeeping that a witnessed ending would have triggered, no earlier.
  assert.deepEqual(h.deletes, [{ printerId: "k2", remotePath }]);
  assert.deepEqual(h.onDevice.get("k2"), []);
});
