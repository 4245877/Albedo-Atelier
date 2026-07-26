import assert from "node:assert/strict";
import { test } from "node:test";

import { MODEL_SCALE_KEY } from "../../domain/print/modelScale";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type {
  Artifact,
  ArtifactAnalysis,
  Metadata,
  PrintTask,
  QueueEntry
} from "../../domain/print/types";
import type { CompatibilityReason, CompatibilityResult } from "../../domain/scheduling/compatibility";
import { openPrintQueueStore } from "../../infra/db/store";
import { SchedulerContext } from "./context";
import { EvidenceResolver } from "./evidence";
import type { SchedulerConfig, SchedulerPrinterRef } from "./types";

/**
 * How a model's *size* travels from the analyzer to a compatibility verdict.
 *
 * The rule under test is one sentence: a size counts as millimetres only when
 * something proved it is. A 3MF proves it by declaring a convertible unit; an
 * STL cannot prove it at all and needs an operator's confirmation bound to those
 * exact bytes; anything else — an unreadable unit, a multi-plate package with no
 * plate chosen, a corrupt box — stays unproven and can never read `compatible`.
 */

const NOW = new Date("2026-07-26T12:00:00.000Z");
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
    id: "p1",
    name: "P1",
    model: "P1",
    protocol: "moonraker",
    material: "PLA",
    nozzleMm: 0.4,
    buildVolume: { x: 300, y: 300, z: 300 },
    online: true,
    status: "idle",
    remoteStartSupported: true,
    ams: null,
    telemetryAgeMs: 1000,
    materialRemainingSufficient: null,
    printingTimeLeftMs: null,
    ...over
  };
}

/** A model task (STL/3MF source, no slice yet) with the given analysis payload. */
function seedModelTask(
  db: PrintQueueStore,
  options: {
    data: Metadata;
    detectedFormat?: "stl" | "3mf";
    artifactMetadata?: Metadata;
    sha256?: string | null;
    sizeBytes?: number | null;
  }
): { task: PrintTask; artifact: Artifact } {
  const repos = db.repositories;
  const artifact: Artifact = {
    id: "art_model",
    kind: "model",
    name: "part.stl",
    source: "blobs/part.stl",
    sizeBytes: options.sizeBytes === undefined ? 1024 : options.sizeBytes,
    sha256: options.sha256 === undefined ? "abc123" : options.sha256,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: options.artifactMetadata ?? {}
  };
  repos.artifacts.insert(artifact);

  const analysis: ArtifactAnalysis = {
    id: "ana_model",
    artifactId: artifact.id,
    state: "ready",
    detectedFormat: options.detectedFormat ?? "stl",
    verdict: "needs_preparation",
    analyzer: options.detectedFormat ?? "stl",
    analyzerVersion: "1.1.0",
    estimatedDurationS: null,
    estimatedFilamentG: null,
    material: null,
    nozzleDiameterMm: null,
    layerHeightMm: null,
    warnings: [],
    blockers: [],
    data: options.data,
    error: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  repos.artifactAnalyses.insert(analysis);

  const task: PrintTask = {
    id: "t1",
    artifactId: artifact.id,
    sliceVariantId: null,
    sourceArtifactId: artifact.id,
    onDeviceFile: null,
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
  return { task, artifact };
}

/** Resolves the (task, printer) evidence and the compatibility verdict for it. */
function evaluate(
  db: PrintQueueStore,
  task: PrintTask,
  over: Partial<SchedulerPrinterRef> = {}
): {
  dimensions: { x: number; y: number; z: number } | null;
  scaleKnown: boolean;
  result: CompatibilityResult;
  codes: string[];
} {
  const p = printer(over);
  const resolver = new EvidenceResolver(new SchedulerContext(db, () => [p], config()));
  const { taskInput } = resolver.resolveEvidence(task, p);
  const result = resolver.evaluate(task, p);
  const codes = [...result.blockers, ...result.reviews, ...result.warnings].map(
    (r: CompatibilityReason) => r.code
  );
  return {
    dimensions: taskInput.dimensions,
    scaleKnown: taskInput.dimensionsScaleKnown,
    result,
    codes
  };
}

/** The normalized payload a 1.1.0 analyzer writes. */
function geometry(over: Record<string, unknown> = {}): Metadata {
  return {
    geometry: {
      minRaw: [0, 0, 0],
      maxRaw: [10, 10, 10],
      sizeRaw: [10, 10, 10],
      minMm: null,
      maxMm: null,
      sizeMm: null,
      sourceUnits: "unknown",
      declaredUnits: null,
      mmPerUnit: null,
      scaleKnown: false,
      objectCount: 1,
      plateCount: 1,
      plates: [],
      sceneSizeRaw: [10, 10, 10],
      sceneSizeMm: null,
      multiPlate: false,
      pointCount: 3,
      truncated: false,
      ...over
    }
  };
}

// ── 3MF: a proven unit flows through as millimetres ──────────────────────────

test("a unit-resolved 3MF passes its millimetre size through to compatibility", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    detectedFormat: "3mf",
    data: geometry({
      sourceUnits: "centimeter",
      declaredUnits: "cm",
      mmPerUnit: 10,
      scaleKnown: true,
      minMm: [0, 0, 0],
      maxMm: [100, 100, 100],
      sizeMm: [100, 100, 100],
      sceneSizeMm: [100, 100, 100]
    })
  });

  const { dimensions, scaleKnown, codes } = evaluate(db, task);
  assert.deepEqual(dimensions, { x: 100, y: 100, z: 100 });
  assert.equal(scaleKnown, true);
  assert.ok(!codes.includes("model_scale_unknown"));
  assert.ok(!codes.includes("dimensions_unknown"));
});

test("a 3MF too large for the bed is blocked on its converted size", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    detectedFormat: "3mf",
    // 20 inch = 508 mm — fits nothing on a 300 mm bed.
    data: geometry({
      sourceUnits: "inch",
      declaredUnits: "inch",
      mmPerUnit: 25.4,
      scaleKnown: true,
      sizeRaw: [20, 20, 20],
      minMm: [0, 0, 0],
      maxMm: [508, 508, 508],
      sizeMm: [508, 508, 508]
    })
  });

  const { result, codes } = evaluate(db, task);
  assert.equal(result.verdict, "blocked");
  assert.ok(codes.includes("too_large"));
});

// ── STL: unknown scale is never `compatible` ─────────────────────────────────

test("an STL's numbers are carried but never counted as millimetres", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, { data: geometry() });

  const { dimensions, scaleKnown, result, codes } = evaluate(db, task);
  // The box is visible to the planner…
  assert.deepEqual(dimensions, { x: 10, y: 10, z: 10 });
  // …but explicitly unproven, so the verdict can never be `compatible`.
  assert.equal(scaleKnown, false);
  assert.notEqual(result.verdict, "compatible");
  assert.ok(codes.includes("model_scale_unknown"));
});

test("an unproven scale is still flagged when the build volume is unknown too", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, { data: geometry() });

  // Neither unknown may mask the other: the old chained check dropped
  // `model_scale_unknown` whenever the bed size happened to be unknown.
  const { codes } = evaluate(db, task, { buildVolume: null });
  assert.ok(codes.includes("model_scale_unknown"));
  assert.ok(codes.includes("build_volume_unknown"));
});

test("an operator scale confirmation turns the STL numbers into millimetres", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    data: geometry(),
    artifactMetadata: {
      [MODEL_SCALE_KEY]: {
        units: "centimeter",
        scaleFactor: 1,
        sha256: "abc123",
        sizeBytes: 1024,
        confirmedBy: "operator",
        confirmedAt: ISO
      }
    }
  });

  const { dimensions, scaleKnown, codes } = evaluate(db, task);
  assert.deepEqual(dimensions, { x: 100, y: 100, z: 100 });
  assert.equal(scaleKnown, true);
  assert.ok(!codes.includes("model_scale_unknown"));
});

test("an extra scale factor multiplies on top of the confirmed unit", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    data: geometry(),
    artifactMetadata: {
      [MODEL_SCALE_KEY]: {
        units: "millimeter",
        scaleFactor: 2.5,
        sha256: "abc123",
        sizeBytes: 1024,
        confirmedBy: "operator",
        confirmedAt: ISO
      }
    }
  });

  const { dimensions, scaleKnown } = evaluate(db, task);
  assert.deepEqual(dimensions, { x: 25, y: 25, z: 25 });
  assert.equal(scaleKnown, true);
});

test("a confirmation made for different bytes is ignored (fail-closed)", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    data: geometry(),
    sha256: "NEW-CONTENT",
    artifactMetadata: {
      [MODEL_SCALE_KEY]: {
        units: "centimeter",
        scaleFactor: 1,
        sha256: "abc123", // the hash of the file that was confirmed, not this one
        sizeBytes: 1024,
        confirmedBy: "operator",
        confirmedAt: ISO
      }
    }
  });

  const { dimensions, scaleKnown, codes } = evaluate(db, task);
  assert.deepEqual(dimensions, { x: 10, y: 10, z: 10 }); // un-scaled
  assert.equal(scaleKnown, false);
  assert.ok(codes.includes("model_scale_unknown"));
});

test("a malformed confirmation is ignored rather than half-applied", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    data: geometry(),
    artifactMetadata: {
      [MODEL_SCALE_KEY]: { units: "parsec", scaleFactor: 1, sha256: "abc123" }
    }
  });

  const { scaleKnown, codes } = evaluate(db, task);
  assert.equal(scaleKnown, false);
  assert.ok(codes.includes("model_scale_unknown"));
});

// ── Fail-closed shapes ───────────────────────────────────────────────────────

test("a multi-plate package reports no size at all", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    detectedFormat: "3mf",
    data: geometry({
      sourceUnits: "millimeter",
      mmPerUnit: 1,
      scaleKnown: true,
      sizeRaw: null,
      sizeMm: null,
      multiPlate: true,
      plateCount: 3,
      sceneSizeMm: [500, 200, 30]
    })
  });

  const { dimensions, codes } = evaluate(db, task);
  // The union across plates must never stand in for one print's size.
  assert.equal(dimensions, null);
  assert.ok(codes.includes("dimensions_unknown"));
});

test("a degenerate box is treated as no size, not as a zero-height model", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    detectedFormat: "3mf",
    data: geometry({
      sourceUnits: "millimeter",
      mmPerUnit: 1,
      scaleKnown: true,
      sizeMm: [10, 10, 0],
      minMm: [0, 0, 0],
      maxMm: [10, 10, 0]
    })
  });

  const { dimensions, codes } = evaluate(db, task);
  assert.equal(dimensions, null);
  assert.ok(codes.includes("dimensions_unknown"));
});

test("a non-finite box is treated as no size", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    data: geometry({ sizeRaw: [10, null, 10] })
  });

  const { dimensions, codes } = evaluate(db, task);
  assert.equal(dimensions, null);
  assert.ok(codes.includes("dimensions_unknown"));
});

// ── Backwards compatibility with pre-1.1.0 analyses ──────────────────────────

test("a legacy STL analysis (bbox + units:unknown) still reads as unproven numbers", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    data: {
      stlVariant: "binary",
      triangles: 2,
      units: "unknown",
      bbox: { min: [0, 0, 0], max: [10, 10, 10], size: [10, 10, 10] }
    }
  });

  const { dimensions, scaleKnown, codes } = evaluate(db, task);
  assert.deepEqual(dimensions, { x: 10, y: 10, z: 10 });
  assert.equal(scaleKnown, false);
  assert.ok(codes.includes("model_scale_unknown"));
});

test("a legacy 3MF analysis is converted from its declared unit", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    detectedFormat: "3mf",
    data: {
      threeMfClass: "generic",
      units: "inch",
      bbox: { min: [0, 0, 0], max: [2, 2, 2], size: [2, 2, 2] }
    }
  });

  const { dimensions, scaleKnown } = evaluate(db, task);
  assert.deepEqual(dimensions, { x: 50.8, y: 50.8, z: 50.8 });
  assert.equal(scaleKnown, true);
});

test("a legacy analysis with only min/max derives the extent", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    detectedFormat: "3mf",
    data: { units: "millimeter", bbox: { min: [5, 5, 0], max: [25, 15, 10] } }
  });

  const { dimensions, scaleKnown } = evaluate(db, task);
  assert.deepEqual(dimensions, { x: 20, y: 10, z: 10 });
  assert.equal(scaleKnown, true);
});

test("a legacy analysis in an unconvertible unit is unproven, and an operator may confirm it", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, {
    detectedFormat: "3mf",
    data: { units: "parsec", bbox: { size: [10, 10, 10] } },
    artifactMetadata: {
      [MODEL_SCALE_KEY]: {
        units: "millimeter",
        scaleFactor: 1,
        sha256: "abc123",
        sizeBytes: 1024,
        confirmedBy: "operator",
        confirmedAt: ISO
      }
    }
  });

  const { dimensions, scaleKnown } = evaluate(db, task);
  assert.deepEqual(dimensions, { x: 10, y: 10, z: 10 });
  assert.equal(scaleKnown, true);
});

test("an empty legacy analysis payload reads as no size, without throwing", () => {
  const db = openPrintQueueStore(":memory:");
  const { task } = seedModelTask(db, { data: {} });

  const { dimensions, codes } = evaluate(db, task);
  assert.equal(dimensions, null);
  assert.ok(codes.includes("dimensions_unknown"));
});
