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
import type { PrinterLiveStatus } from "../../infra/printers/status";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import { ArtifactService } from "../artifacts/artifactService";
import { evaluateDispatchGate } from "../dispatch/dispatchGate";
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
  assert.equal(detail.task.metadata.file, "cube.gcode"); // an on-device path to start
  assert.equal(detail.task.metadata.sourceArtifactId, artifactId); // provenance preserved
  assert.equal(detail.task.metadata.sliceVariantId, ready.id);
  assert.equal(detail.task.pinnedPrinterId, "creality-k2"); // pinned to the sliced-for printer
  assert.equal(detail.queueEntry?.state, "WAITING");

  // The dispatch gate now reads the OUTPUT's clean analysis — no NO_FILE, and the
  // verdict/format/blocker checks pass (they blocked on the raw STL before).
  const outArtifact = store.repositories.artifacts.getById(ready.outputArtifactId as string) ?? null;
  const outAnalysis = store.repositories.artifactAnalyses.latestForArtifact(ready.outputArtifactId as string);
  const printer = normalizePrinterConfig({
    id: "creality-k2",
    name: "Creality K2",
    host: "127.0.0.1",
    protocol: "moonraker",
    material: "PETG"
  });
  assert.ok(printer);
  const blockers = evaluateDispatchGate({
    mode: "manual",
    task: detail.task,
    entry: detail.queueEntry,
    artifact: outArtifact,
    analysis: outAnalysis,
    printer,
    status: idleStatus(),
    remoteStartSupported: true,
    nightWindowMinutes: 600,
    nightSafetyBufferRatio: 1,
    currentAnalyzerVersion: ANALYZER_VERSION
  });
  const codes = blockers.map((b) => b.code);
  for (const gone of ["NO_FILE", "ANALYSIS_VERDICT", "ANALYSIS_BLOCKERS", "FORMAT_UNKNOWN"]) {
    assert.ok(!codes.includes(gone), `expected ${gone} cleared, got ${JSON.stringify(codes)}`);
  }
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
