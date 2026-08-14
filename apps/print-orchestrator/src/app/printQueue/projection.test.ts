import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ArtifactAnalysis,
  Assignment,
  PrintRun,
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

function run(over: Partial<PrintRun> = {}): PrintRun {
  return {
    id: "run_1",
    taskId: "task_1",
    assignmentId: "asg_1",
    dispatchAttemptId: "dsp_1",
    printerId: "bambu-a1-combo",
    bedCycleId: "bed_1",
    state: "UNKNOWN",
    file: "3U-default-28ab3676.gcode.3mf",
    artifactId: "art_1",
    artifactSha256: "28ab3676",
    idempotencyKey: null,
    startedAt: null,
    endedAt: null,
    progress: null,
    filamentUsedG: null,
    durationS: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {},
    ...over
  } as PrintRun;
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

// ── An unconfirmed start is its own status ──────────────────────────────────
//
// The live incident: a launch was dispatched, the A1 never confirmed it, and the
// run parked in UNKNOWN with startedAt=null. The task read DISPATCHING, which
// projected to `review` — and a review row is passive, so the ONE task needing
// an operator decision was the one task with no button on it. The resolution UI
// lives in the launch modal, whose only entry point was the "next job" card,
// which renders solely for `status === "ready"`. The operator went looking for
// any start button, found the execution panel's, and got a 409.

test("a dispatched-but-unconfirmed run projects as `unconfirmed`, not `review`", () => {
  const job = toLegacyQueueJob(
    row({ task: task({ state: "DISPATCHING" }), run: run(), analysis: analysis() })
  );
  assert.equal(job.status, "unconfirmed");
  assert.equal(job.unresolvedRunId, "run_1", "the id the resolution call needs");
  assert.match(
    job.reason ?? "",
    /посмотрите на принтер/,
    "tells the operator what to do, not what the row looks like internally"
  );
});

test("a PENDING run that never started is the same situation as an UNKNOWN one", () => {
  const job = toLegacyQueueJob(
    row({ task: task({ state: "DISPATCHING" }), run: run({ state: "PENDING" }) })
  );
  assert.equal(job.status, "unconfirmed");
  assert.equal(job.unresolvedRunId, "run_1");
});

test("a run that was observed printing is NOT an unconfirmed start", () => {
  // startedAt is the load-bearing half: this print began, so whatever it is
  // doing now, no operator verdict is owed and no resolution is offered.
  const job = toLegacyQueueJob(
    row({
      task: task({ state: "PRINTING" }),
      run: run({ state: "RUNNING", startedAt: ISO })
    })
  );
  assert.notEqual(job.status, "unconfirmed");
  assert.equal(job.unresolvedRunId, undefined);
});

test("an UNKNOWN run that had started is left to the normal completion path", () => {
  const job = toLegacyQueueJob(
    row({ task: task({ state: "DISPATCHING" }), run: run({ startedAt: ISO }) })
  );
  assert.notEqual(job.status, "unconfirmed", "it printed; this is a completion question");
  assert.equal(job.unresolvedRunId, undefined);
});

test("once resolved, the row carries no unresolved run and stops being unconfirmed", () => {
  // What `unwindUnstarted` leaves behind: run CANCELLED (so no longer active,
  // hence absent from the row), task back to QUEUED, entry still WAITING.
  const job = toLegacyQueueJob(row({ task: task({ state: "QUEUED" }), run: null }));
  assert.equal(job.status, "ready", "startable again through the normal path");
  assert.equal(job.unresolvedRunId, undefined);
});
