import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Artifact, ArtifactAnalysis, Metadata, PrintTask, QueueEntry } from "../../domain/print/types";
import { openPrintQueueStore } from "../../infra/db/store";
import { SchedulerContext } from "./context";
import { EvidenceResolver } from "./evidence";
import type { SchedulerConfig, SchedulerPrinterRef } from "./types";

/**
 * The two facts the evidence provider used to hard-code away.
 *
 * `amsRequired: null` and `maintenanceBlockers: []` were literals, so two whole
 * branches of the compatibility rules were unreachable no matter what the farm
 * looked like. This file drives the real resolver against the real store and
 * asserts the facts now travel: the analyzer's tool count becomes an AMS
 * requirement, and an open blocking intervention becomes a maintenance blocker.
 */

const NOW = new Date("2026-08-28T12:00:00.000Z");
const ISO = NOW.toISOString();

function config(): SchedulerConfig {
  return {
    now: () => NOW,
    runtimeAvailable: true,
    nightSafetyBufferRatio: 0.2,
    nightWindow: "21:30 – 07:30",
    farmTimeZone: "UTC",
    unknownEtaAssumptionS: 4 * 3600
  };
}

function printer(over: Partial<SchedulerPrinterRef> = {}): SchedulerPrinterRef {
  return {
    id: "a1",
    name: "A1",
    model: "A1",
    protocol: "bambu",
    material: "PLA",
    nozzleMm: 0.4,
    buildVolume: { x: 256, y: 256, z: 256 },
    online: true,
    status: "idle",
    remoteStartSupported: true,
    ams: true,
    faults: [],
    mediaPresent: true,
    telemetryAgeMs: 1000,
    materialRemainingSufficient: null,
    printingTimeLeftMs: null,
    ...over
  };
}

/** A ready G-code task whose analysis carries `data`. */
function seedGcodeTask(db: PrintQueueStore, data: Metadata, state: ArtifactAnalysis["state"] = "ready"): PrintTask {
  const repos = db.repositories;
  const artifact: Artifact = {
    id: "art_g",
    kind: "gcode",
    name: "part.gcode",
    source: "blobs/part.gcode",
    sizeBytes: 2048,
    sha256: "f".repeat(64),
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.artifacts.insert(artifact);
  repos.artifactAnalyses.insert({
    id: "ana_g",
    artifactId: artifact.id,
    state,
    detectedFormat: "gcode",
    verdict: "schedulable",
    analyzer: "gcode",
    analyzerVersion: "1.1.0",
    estimatedDurationS: 3600,
    estimatedFilamentG: 20,
    material: "PLA",
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    data,
    error: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  });
  const task: PrintTask = {
    id: "t1",
    artifactId: artifact.id,
    sliceVariantId: null,
    sourceArtifactId: artifact.id,
    onDeviceFile: "part.gcode.3mf",
    title: "part",
    material: "PLA",
    targetPrinter: null,
    priority: 0,
    state: "QUEUED",
    reason: null,
    night: false,
    notBefore: null,
    deadline: null,
    dayNightPreference: "any",
    pinnedPrinterId: null,
    unattendedAllowed: false,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.tasks.insert(task);
  const entry: QueueEntry = {
    id: "qe_t1",
    taskId: task.id,
    position: 10,
    state: "WAITING",
    enqueuedAt: ISO,
    updatedAt: ISO,
    version: 1
  };
  repos.queue.insert(entry);
  return task;
}

function resolve(db: PrintQueueStore, task: PrintTask, over: Partial<SchedulerPrinterRef> = {}) {
  const p = printer(over);
  const resolver = new EvidenceResolver(new SchedulerContext(db, () => [p], config()));
  const { taskInput, evidence } = resolver.resolveEvidence(task, p);
  const result = resolver.evaluate(task, p);
  return {
    taskInput,
    evidence,
    result,
    codes: [...result.blockers, ...result.reviews, ...result.warnings].map((r) => r.code)
  };
}

test("the analyzer's tool count becomes the AMS requirement — it is no longer discarded", () => {
  const db = openPrintQueueStore(":memory:");
  const task = seedGcodeTask(db, { toolCount: 3, bbox: null });
  const { taskInput, codes } = resolve(db, task);
  assert.equal(taskInput.toolCount, 3);
  assert.equal(taskInput.amsRequired, true);
  assert.ok(
    codes.includes("ams_mapping_ambiguous"),
    "a three-tool job must not be auto-startable while nothing maps filament to slot"
  );
});

test("a single-tool job asks nothing of the AMS", () => {
  const db = openPrintQueueStore(":memory:");
  const task = seedGcodeTask(db, { toolCount: 1, bbox: null });
  const { taskInput, codes } = resolve(db, task);
  assert.equal(taskInput.amsRequired, false);
  assert.deepEqual(codes.filter((c) => c.startsWith("ams_")), []);
});

test("an unfinished analysis says nothing about tools — it does not say «one»", () => {
  const db = openPrintQueueStore(":memory:");
  const task = seedGcodeTask(db, { toolCount: 4, bbox: null }, "running");
  const { taskInput } = resolve(db, task);
  assert.equal(taskInput.toolCount, null, "a running analysis has no answer yet");
  assert.equal(taskInput.amsRequired, null, "and unknown is not «no»");
});

test("an analysis with no tool count at all stays unknown", () => {
  const db = openPrintQueueStore(":memory:");
  const task = seedGcodeTask(db, { bbox: null });
  const { taskInput } = resolve(db, task);
  assert.equal(taskInput.toolCount, null);
  assert.equal(taskInput.amsRequired, null);
});

test("an intervention that was ATTEMPTED AND FAILED puts the printer out of service", () => {
  const db = openPrintQueueStore(":memory:");
  const task = seedGcodeTask(db, { toolCount: 1, bbox: null });
  seedOperation(db, { id: "op1", type: "NOZZLE_CHANGE", state: "FAILED", note: "сопло всё ещё забито" });

  const { evidence, codes, result } = resolve(db, task);
  assert.deepEqual(evidence.maintenanceBlockers, [
    "замена сопла не выполнена: сопло всё ещё забито — повторите операцию и подтвердите её"
  ]);
  assert.ok(codes.includes("maintenance"), "a failed repair is a machine out of service");
  assert.equal(result.verdict, "blocked");
});

test("a routine intervention still ahead is NOT a maintenance blocker — it is a schedule", () => {
  // The planner models a 25-minute nozzle change as twenty-five minutes: it
  // places the job after it. Declaring the printer incompatible instead would
  // throw that away and leave the work unplaced.
  const db = openPrintQueueStore(":memory:");
  const task = seedGcodeTask(db, { toolCount: 1, bbox: null });
  for (const state of ["PENDING", "READY", "IN_PROGRESS"] as const) {
    seedOperation(db, { id: `op_${state}`, type: "NOZZLE_CHANGE", state });
  }
  assert.deepEqual(resolve(db, task).evidence.maintenanceBlockers, []);
});

test("a non-blocking failed operation does not put the printer out of service", () => {
  const db = openPrintQueueStore(":memory:");
  const task = seedGcodeTask(db, { toolCount: 1, bbox: null });
  seedOperation(db, { id: "op4", type: "VISUAL_INSPECTION", state: "FAILED", blocking: false });
  assert.deepEqual(resolve(db, task).evidence.maintenanceBlockers, []);
});

/** One manual operation on printer `a1`. */
function seedOperation(
  db: PrintQueueStore,
  over: {
    id: string;
    type: "NOZZLE_CHANGE" | "PART_REMOVAL" | "VISUAL_INSPECTION";
    state: "PENDING" | "READY" | "IN_PROGRESS" | "FAILED";
    blocking?: boolean;
    note?: string | null;
  }
): void {
  db.repositories.manualOperations.insert({
    id: over.id,
    type: over.type,
    state: over.state,
    printerId: "a1",
    assignmentId: null,
    taskId: null,
    bedCycleId: null,
    estimatedMinutes: 25,
    windowStart: null,
    windowEnd: null,
    blocking: over.blocking ?? true,
    origin: "operator",
    reason: null,
    assignedOperatorId: null,
    confirmedBy: null,
    startedAt: over.state === "IN_PROGRESS" ? ISO : null,
    completedAt: null,
    actualMinutes: null,
    readyAt: ISO,
    note: over.note ?? null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  });
}

// ── Absolute placement reaches the gate from a real analysis ────────────────

/** A ready G-code task whose analysis carries a bbox at the given coordinates. */
function gcodeAt(db: PrintQueueStore, min: number[], max: number[], basis = "object"): PrintTask {
  return seedGcodeTask(db, {
    toolCount: 1,
    bbox: {
      min,
      max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      confidence: "high"
    },
    bboxBasis: basis
  });
}

test("a G-code that places the part off the bed is refused, though it fits by size", () => {
  const db = openPrintQueueStore(":memory:");
  // 100 × 100 on a 256 mm bed — but at X 200…300.
  const task = gcodeAt(db, [200, 20, 0], [300, 120, 50]);
  const { taskInput, codes } = resolve(db, task);

  assert.deepEqual(taskInput.placement, {
    min: { x: 200, y: 20, z: 0 },
    max: { x: 300, y: 120, z: 50 }
  });
  assert.ok(codes.includes("model_off_bed"));
  assert.ok(!codes.includes("too_large"), "the part is not too large — it is in the wrong place");
});

test("a purge-inflated box is not treated as a placement", () => {
  // Bambu draws its nozzle-load line at Y-0.5, deliberately off the front edge.
  // With no object markers the analyzer's box includes it, and blocking on that
  // would refuse every correct Bambu file.
  const db = openPrintQueueStore(":memory:");
  const task = gcodeAt(db, [20, -0.5, 0], [120, 120, 50], "extrusion");
  const { taskInput, codes } = resolve(db, task);
  assert.equal(taskInput.placement, null, "only the slicer's own object markers may place a part");
  assert.ok(!codes.includes("model_off_bed"));
});

test("a well-placed G-code passes the placement rule", () => {
  const db = openPrintQueueStore(":memory:");
  const task = gcodeAt(db, [20, 20, 0], [120, 120, 50]);
  assert.ok(!resolve(db, task).codes.includes("model_off_bed"));
});
