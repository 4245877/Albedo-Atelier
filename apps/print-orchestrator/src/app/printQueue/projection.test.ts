import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ArtifactAnalysis,
  Assignment,
  PrintTask,
  QueueEntry
} from "../../domain/print/types";
import { EMPTY_ASSIGNMENT_BINDING } from "../../domain/print/types";
import { formatEta, toLegacyQueueJob, type QueueProjectionRow } from "./projection";

/*
 * The queue card's data. The reported symptom was a fully analysed job — PETG,
 * 0.4 mm, 1 h 29 m, 31 g, all of it sitting in the artifact analysis — rendering
 * as "bambu-a1-combo · — · —", because the projection read only the task's own
 * operator-stated fields, which the slicing pipeline never fills in.
 */

const ISO = "2026-08-14T12:00:00.000Z";

function task(over: Partial<PrintTask> = {}): PrintTask {
  return {
    id: "task_1",
    artifactId: "art_1",
    sliceVariantId: null,
    sourceArtifactId: "art_src",
    onDeviceFile: null,
    title: "3U-default.3mf",
    material: null,
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
    metadata: {},
    ...over
  } as PrintTask;
}

function entry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: "qe_1",
    taskId: "task_1",
    position: 10,
    state: "WAITING",
    enqueuedAt: ISO,
    updatedAt: ISO,
    version: 1,
    ...over
  } as QueueEntry;
}

function analysis(over: Partial<ArtifactAnalysis> = {}): ArtifactAnalysis {
  return {
    id: "ana_1",
    artifactId: "art_1",
    state: "ready",
    detectedFormat: "gcode",
    verdict: "schedulable",
    analyzer: "gcode",
    analyzerVersion: "1.2.0",
    estimatedDurationS: 5329,
    estimatedFilamentG: 31.1,
    material: "PETG",
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    data: {},
    error: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {},
    ...over
  } as ArtifactAnalysis;
}

function assignment(over: Partial<Assignment["binding"]> = {}): Assignment {
  return {
    id: "asg_1",
    taskId: "task_1",
    printerId: "bambu-a1-combo",
    planId: null,
    bedCycleId: null,
    state: "PROPOSED",
    source: "manual",
    reason: null,
    createdBy: "operator",
    invalidatedAt: null,
    invalidatedReason: null,
    binding: { ...EMPTY_ASSIGNMENT_BINDING, ...over },
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  } as Assignment;
}

function row(over: Partial<QueueProjectionRow> = {}): QueueProjectionRow {
  return { entry: entry(), task: task(), artifact: null, ...over };
}

// ── Duration formatting ─────────────────────────────────────────────────────

test("formatEta renders hours and minutes, and never invents a duration", () => {
  assert.equal(formatEta(5329), "≈ 1 ч 29 мин");
  assert.equal(formatEta(3600), "≈ 1 ч");
  assert.equal(formatEta(600), "≈ 10 мин");
  assert.equal(formatEta(null), null);
  assert.equal(formatEta(0), null, "zero is not a duration, it is an absent one");
  assert.equal(formatEta(Number.NaN), null);
});

// ── The reported symptom ────────────────────────────────────────────────────

test("an analysed job shows its measured material, nozzle, duration and weight", () => {
  const job = toLegacyQueueJob(row({ analysis: analysis() }));

  assert.equal(job.material, "PETG", "not «—»: the analysis knew this");
  assert.equal(job.eta, "≈ 1 ч 29 мин");
  assert.equal(job.nozzleMm, 0.4);
  assert.equal(job.etaSeconds, 5329);
  assert.equal(Math.round(job.filamentG!), 31);
});

test("a job with genuinely nothing measured still says «—» rather than guessing", () => {
  const job = toLegacyQueueJob(row());
  assert.equal(job.material, "—");
  assert.equal(job.eta, "—");
  assert.equal(job.nozzleMm, undefined, "absent ≠ zero");
  assert.equal(job.etaSeconds, undefined);
  assert.equal(job.filamentG, undefined);
});

// ── Precedence ──────────────────────────────────────────────────────────────

test("the assignment binding wins over the analysis — it is what the slice was built for", () => {
  const job = toLegacyQueueJob(
    row({
      analysis: analysis({ material: "PETG", nozzleDiameterMm: 0.4, estimatedDurationS: 5329 }),
      assignment: assignment({ material: "PLA", nozzleMm: 0.6, etaS: 1800 })
    })
  );
  assert.equal(job.material, "PLA");
  assert.equal(job.nozzleMm, 0.6);
  assert.equal(job.etaSeconds, 1800);
  assert.equal(job.assignmentId, "asg_1");
});

test("an operator-stated material beats the analysis but not the binding", () => {
  const stated = toLegacyQueueJob(
    row({ task: task({ material: "PETG-CF" }), analysis: analysis({ material: "PETG" }) })
  );
  assert.equal(stated.material, "PETG-CF");
});

test("an explicit metadata eta still wins over the computed one", () => {
  const job = toLegacyQueueJob(
    row({ task: task({ metadata: { eta: "завтра утром" } }), analysis: analysis() })
  );
  assert.equal(job.eta, "завтра утром");
  assert.equal(job.etaSeconds, 5329, "…while the machine-readable value stays available");
});

// ── Printer identity ────────────────────────────────────────────────────────

test("a pinned printer is reported over a looser target hint", () => {
  const job = toLegacyQueueJob(
    row({ task: task({ targetPrinter: "any-bambu", pinnedPrinterId: "bambu-a1-combo" }) })
  );
  assert.equal(job.printer, "bambu-a1-combo");
});

// ── Status is untouched by the enrichment ───────────────────────────────────

test("enrichment does not make an inconsistent row look ready", () => {
  const job = toLegacyQueueJob(
    row({ entry: entry({ state: "HELD" }), analysis: analysis() })
  );
  assert.equal(job.status, "review", "a held entry stays in review however complete its data");
});
