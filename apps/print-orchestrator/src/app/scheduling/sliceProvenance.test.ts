import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrintQueueStore } from "../../domain/print/repositories";
import type { Artifact, ArtifactAnalysis, PrintTask } from "../../domain/print/types";
import { makeModelScaleConfirmation, MODEL_SCALE_KEY } from "../../domain/print/modelScale";
import type { ProfileRevision, ProfileSet, SliceVariant } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import { ANALYZER_VERSION } from "../artifacts/analyzers";
import { establishClearBed } from "../dispatch/testkit/bed";
import { SchedulerService, type SchedulerConfig, type SchedulerPrinterRef } from "./schedulerService";

/*
 * HIGH-08 — the slice that is judged is the slice that will be SENT.
 * HIGH-07 — a slice's millimetres are only as proven as the source's unit.
 */

const NOW = new Date("2026-10-14T12:00:00.000Z");
const ISO = NOW.toISOString();
const STL_SHA = "5".repeat(64);

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

const K2: SchedulerPrinterRef = {
  id: "k2",
  name: "K2",
  model: "Creality K2",
  protocol: "moonraker",
  material: "PLA",
  nozzleMm: 0.4,
  buildVolume: { x: 300, y: 300, z: 300 },
  online: true,
  status: "idle",
  remoteStartSupported: true,
  ams: null,
  faults: [],
  mediaPresent: null,
  telemetryAgeMs: 1000,
  materialRemainingSufficient: null,
  printingTimeLeftMs: null
};

function revision(id: string, type: ProfileRevision["type"], resolved: object): ProfileRevision {
  return {
    id,
    logicalId: `${type}:${id}`,
    type,
    name: id,
    inherits: null,
    status: "active",
    rawJson: JSON.stringify(resolved),
    rawSha256: id,
    resolvedJson: JSON.stringify(resolved),
    resolvedSha256: `${id}r`,
    orcaVersion: "2.0",
    source: null,
    warnings: [],
    blockers: [],
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
}

/**
 * An STL source, two ready slices of it for the K2 (A older, B newer, with
 * different ETAs), and a task PROMOTED onto slice A — i.e. A's output is the
 * file the dispatch will send.
 */
function seed(db: PrintQueueStore, options: { pinA?: { factor: number; reason: string } | null } = {}) {
  const repos = db.repositories;
  const source: Artifact = {
    id: "art_src",
    kind: "model",
    name: "cube.stl",
    source: "cube.stl",
    sizeBytes: 684,
    sha256: STL_SHA,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.artifacts.insert(source);
  // An STL: the analyzer could not prove the unit, so the box is raw numbers.
  const sourceAnalysis: ArtifactAnalysis = {
    id: "ana_src",
    artifactId: source.id,
    state: "ready",
    detectedFormat: "stl",
    verdict: "needs_preparation",
    analyzer: "stl",
    analyzerVersion: ANALYZER_VERSION,
    estimatedDurationS: null,
    estimatedFilamentG: null,
    material: null,
    nozzleDiameterMm: null,
    layerHeightMm: null,
    warnings: [],
    blockers: [],
    data: { geometry: { scaleKnown: false, sizeRaw: [20, 20, 20], plateCount: 1, multiPlate: false } },
    error: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: { analyzedSha256: STL_SHA }
  };
  repos.artifactAnalyses.insert(sourceAnalysis);

  for (const r of [
    revision("m", "machine", {
      nozzle_diameter: "0.4",
      printable_area: "0x0,300x0,300x300,0x300",
      printable_height: "300",
      gcode_flavor: "klipper"
    }),
    revision("p", "process", { layer_height: "0.2" }),
    revision("f", "filament", { filament_type: "PLA" })
  ]) {
    repos.profileRevisions.insert(r);
  }
  const set: ProfileSet = {
    id: "pset",
    name: "K2 PLA",
    machineRevisionId: "m",
    processRevisionId: "p",
    filamentRevisionId: "f",
    printerId: "k2",
    printerClass: null,
    validation: "valid",
    approved: true,
    approvedBy: "operator",
    approvedAt: ISO,
    warnings: [],
    blockers: [],
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  repos.profileSets.insert(set);

  const outputs = ["a", "b"].map((x) => {
    const out: Artifact = {
      ...source,
      id: `art_out_${x}`,
      kind: "gcode",
      name: `cube-${x}.gcode`,
      source: `cube-${x}.gcode`,
      sha256: x.repeat(64)
    };
    repos.artifacts.insert(out);
    repos.artifactAnalyses.insert({
      ...sourceAnalysis,
      id: `ana_out_${x}`,
      artifactId: out.id,
      detectedFormat: "gcode",
      verdict: "schedulable",
      analyzer: "gcode",
      estimatedDurationS: x === "a" ? 1000 : 9999,
      material: "PLA",
      nozzleDiameterMm: 0.4,
      data: {
        bbox: { min: [0, 0, 0], max: [20, 20, 20], size: [20, 20, 20] },
        printerModel: "Creality K2",
        flavor: "klipper"
      },
      metadata: { analyzedSha256: out.sha256 }
    });
    return out;
  });

  const task: PrintTask = {
    id: "task_1",
    artifactId: "art_out_a",
    sliceVariantId: "slc_a",
    sourceArtifactId: source.id,
    onDeviceFile: "cube-a.gcode",
    title: "Cube",
    material: "PLA",
    targetPrinter: "k2",
    priority: 0,
    state: "QUEUED",
    reason: null,
    night: false,
    notBefore: null,
    deadline: null,
    dayNightPreference: "any",
    pinnedPrinterId: "k2",
    unattendedAllowed: false,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: { file: "cube-a.gcode" }
  };
  repos.tasks.insert(task);
  repos.queue.insert({ id: "qe_1", taskId: task.id, position: 10, state: "WAITING", enqueuedAt: ISO, updatedAt: ISO, version: 1 });

  for (const [x, i] of [["a", 0], ["b", 1]] as const) {
    const variant: SliceVariant = {
      id: `slc_${x}`,
      taskId: task.id,
      sourceArtifactId: source.id,
      profileSetId: set.id,
      targetPrinterId: "k2",
      targetPrinterClass: null,
      state: "ready",
      cacheKey: `ck_${x}`,
      orcaVersion: "2.0",
      workerVersion: "1",
      outputArtifactId: outputs[i].id,
      outputAnalysisId: `ana_out_${x}`,
      orcaEtaS: x === "a" ? 1000 : 9999,
      filamentG: 5,
      filamentMm: 100,
      dimensions: { size: [20, 20, 20] },
      warnings: [],
      blockers: [],
      error: null,
      startedAt: ISO,
      endedAt: ISO,
      // B is the NEWER slice — the one the old resolver picked.
      createdAt: x === "a" ? "2026-10-14T10:00:00.000Z" : "2026-10-14T11:00:00.000Z",
      updatedAt: ISO,
      version: 1,
      metadata: x === "a" && options.pinA !== null ? { scale: options.pinA ?? { factor: 1, reason: "unconfirmed" } } : {}
    };
    repos.sliceVariants.insert(variant);
  }
  return { source };
}

function confirmUnits(db: PrintQueueStore, units: string): void {
  const repos = db.repositories;
  const source = repos.artifacts.getById("art_src")!;
  const confirmation = makeModelScaleConfirmation({
    units,
    artifact: source,
    confirmedBy: "miha",
    confirmedAt: ISO
  })!;
  repos.artifacts.update({ ...source, metadata: { ...source.metadata, [MODEL_SCALE_KEY]: { ...confirmation } }, updatedAt: ISO });
}

function eligibility(db: PrintQueueStore, mode: "manual" | "night" = "manual") {
  const svc = new SchedulerService(db, () => [K2], config());
  return svc.dispatchEligibility({ taskId: "task_1", printerId: "k2", mode, stage: "preflight" });
}

function fresh(): PrintQueueStore {
  const db = openPrintQueueStore(":memory:");
  establishClearBed(db, "k2", new Date(NOW.getTime() - 60_000));
  return db;
}

test("HIGH-08: the promoted slice is judged, not the newest one", () => {
  const db = fresh();
  seed(db, { pinA: { factor: 1, reason: "declared_by_file" } });
  confirmUnits(db, "millimeter");
  const svc = new SchedulerService(db, () => [K2], config());
  const result = svc.dispatchEligibility({ taskId: "task_1", printerId: "k2", mode: "manual", stage: "preflight" });
  // The ETA is slice A's (1000 s), not the newer slice B's (9999 s).
  assert.equal(result.preflight.eta.seconds, 1000);
});

test("HIGH-07: a slice cut from an unconfirmed STL is NOT proven millimetres", () => {
  const db = fresh();
  seed(db);
  const manual = eligibility(db, "manual");
  assert.ok(
    manual.reasons.some((r) => r.code === "MODEL_SCALE_UNKNOWN"),
    "G-code being millimetres does not prove the STL was"
  );
  const night = eligibility(db, "night");
  assert.ok(night.reasons.some((r) => r.code === "MODEL_SCALE_UNKNOWN" && r.severity === "blocker"));
});

test("confirming the unit the slice was cut at (mm, factor 1) proves the existing slice", () => {
  const db = fresh();
  seed(db);
  confirmUnits(db, "mm");
  const result = eligibility(db);
  assert.ok(!result.reasons.some((r) => r.code === "MODEL_SCALE_UNKNOWN" || r.code === "SLICE_SCALE_MISMATCH"), JSON.stringify(result.reasons));
});

test("confirming a DIFFERENT unit after slicing refuses the slice outright — it is the wrong size", () => {
  const db = fresh();
  seed(db);
  confirmUnits(db, "inch");
  const result = eligibility(db);
  const mismatch = result.reasons.find((r) => r.code === "SLICE_SCALE_MISMATCH");
  assert.ok(mismatch, JSON.stringify(result.reasons));
  assert.equal(mismatch.severity, "blocker");
  assert.match(mismatch.message, /нарежьте заново/);
  assert.equal(result.status, "blocked");
});

test("a legacy slice (no pinned scale) is checked against its own box when the unit is not mm", () => {
  // Cut before scales were pinned; the source is now confirmed in centimetres.
  // Its 20 mm box against a 20-unit model at ×10 = 200 mm → the wrong size.
  const db = fresh();
  seed(db, { pinA: null });
  confirmUnits(db, "cm");
  const result = eligibility(db);
  assert.ok(result.reasons.some((r) => r.code === "SLICE_SCALE_MISMATCH" && r.severity === "blocker"));
});
