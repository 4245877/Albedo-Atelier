import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrintQueueStore } from "../../domain/print/repositories";
import type {
  ArtifactAnalysis,
  Artifact,
  PrintTask,
  QueueEntry
} from "../../domain/print/types";
import type { ProfileRevision, ProfileSet, SliceVariant } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import {
  SchedulerService,
  type SchedulerConfig,
  type SchedulerPrinterRef
} from "./schedulerService";

const NOW = new Date("2026-07-17T12:00:00.000Z");
const ISO = NOW.toISOString();

function store(): PrintQueueStore {
  return openPrintQueueStore(":memory:");
}

function config(over: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    now: () => NOW,
    runtimeAvailable: true,
    nightSafetyBufferRatio: 0.2,
    nightWindow: "21:30 – 07:30",
    unknownEtaAssumptionS: 4 * 3600,
    ...over
  };
}

function makeService(
  db: PrintQueueStore,
  printers: SchedulerPrinterRef[],
  cfg: SchedulerConfig = config()
): SchedulerService {
  return new SchedulerService(db, () => printers, cfg);
}

function printer(id: string, over: Partial<SchedulerPrinterRef> = {}): SchedulerPrinterRef {
  return {
    id,
    name: id.toUpperCase(),
    model: id.toUpperCase(),
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

// ── Seed helpers ────────────────────────────────────────────────────────────

function insertGcodeTask(
  db: PrintQueueStore,
  id: string,
  over: {
    material?: string | null;
    durationS?: number | null;
    nozzle?: number | null;
    size?: [number, number, number] | null;
    unattended?: boolean;
    createdAt?: string;
    priority?: number;
  } = {}
): PrintTask {
  const repos = db.repositories;
  const artifact: Artifact = {
    id: `art_${id}`,
    kind: "gcode",
    name: `${id}.gcode`,
    source: `${id}.gcode`,
    sizeBytes: null,
    sha256: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.artifacts.insert(artifact);

  const analysis: ArtifactAnalysis = {
    id: `ana_${id}`,
    artifactId: artifact.id,
    state: "ready",
    detectedFormat: "gcode",
    verdict: "schedulable",
    analyzer: "gcode",
    analyzerVersion: "1",
    estimatedDurationS: over.durationS === undefined ? 3600 : over.durationS,
    estimatedFilamentG: 20,
    material: over.material === undefined ? "PLA" : over.material,
    nozzleDiameterMm: over.nozzle === undefined ? 0.4 : over.nozzle,
    layerHeightMm: 0.2,
    warnings: [],
    blockers: [],
    data: { size: over.size === undefined ? [100, 100, 100] : over.size },
    error: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  repos.artifactAnalyses.insert(analysis);

  const task: PrintTask = {
    id,
    artifactId: artifact.id,
    title: id,
    material: over.material === undefined ? "PLA" : over.material,
    targetPrinter: null,
    priority: over.priority ?? 0,
    state: "QUEUED",
    reason: null,
    night: false,
    notBefore: null,
    deadline: null,
    dayNightPreference: "any",
    pinnedPrinterId: null,
    unattendedAllowed: over.unattended === true,
    createdAt: over.createdAt ?? ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.tasks.insert(task);

  const entry: QueueEntry = {
    id: `qe_${id}`,
    taskId: id,
    position: 10,
    state: "WAITING",
    enqueuedAt: ISO,
    updatedAt: ISO,
    version: 1
  };
  repos.queue.insert(entry);
  return task;
}

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

/** Seeds a model task with a ready printer-specific slice variant + a profile set. */
function insertSlicedTask(
  db: PrintQueueStore,
  id: string,
  targetPrinterId: string,
  over: {
    approved?: boolean;
    validation?: ProfileSet["validation"];
    unattended?: boolean;
    etaS?: number;
    /** When set, bind the set/variant to a CLASS (targetPrinterId null) instead of a printer id. */
    classScoped?: string;
  } = {}
): PrintTask {
  const boundPrinterId = over.classScoped ? null : targetPrinterId;
  const boundClass = over.classScoped ?? null;
  const repos = db.repositories;
  const source: Artifact = {
    id: `art_${id}`,
    kind: "model",
    name: `${id}.stl`,
    source: `${id}.stl`,
    sizeBytes: null,
    sha256: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  const output: Artifact = { ...source, id: `art_out_${id}`, kind: "gcode", name: `${id}.gcode` };
  repos.artifacts.insert(source);
  repos.artifacts.insert(output);

  const machine = revision(`m_${id}`, "machine", {
    nozzle_diameter: "0.4",
    printable_area: "0x0,300x0,300x300,0x300",
    printable_height: "300",
    gcode_flavor: "klipper"
  });
  const process = revision(`p_${id}`, "process", { layer_height: "0.2" });
  const filament = revision(`f_${id}`, "filament", { filament_type: "PLA" });
  repos.profileRevisions.insert(machine);
  repos.profileRevisions.insert(process);
  repos.profileRevisions.insert(filament);

  const set: ProfileSet = {
    id: `pset_${id}`,
    name: `set_${id}`,
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId: boundPrinterId,
    printerClass: boundClass,
    validation: over.validation ?? "valid",
    approved: over.approved ?? true,
    approvedBy: over.approved === false ? null : "operator",
    approvedAt: over.approved === false ? null : ISO,
    warnings: [],
    blockers: [],
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  repos.profileSets.insert(set);

  const task: PrintTask = {
    id,
    artifactId: source.id,
    title: id,
    material: "PLA",
    targetPrinter: null,
    priority: 0,
    state: "QUEUED",
    reason: null,
    night: false,
    notBefore: null,
    deadline: null,
    dayNightPreference: over.unattended ? "night" : "any",
    pinnedPrinterId: null,
    unattendedAllowed: over.unattended === true,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  };
  repos.tasks.insert(task);
  repos.queue.insert({
    id: `qe_${id}`,
    taskId: id,
    position: 10,
    state: "WAITING",
    enqueuedAt: ISO,
    updatedAt: ISO,
    version: 1
  });

  const variant: SliceVariant = {
    id: `slc_${id}`,
    taskId: id,
    sourceArtifactId: source.id,
    profileSetId: set.id,
    targetPrinterId: boundPrinterId,
    targetPrinterClass: boundClass,
    state: "ready",
    cacheKey: `ck_${id}`,
    orcaVersion: "2.0",
    workerVersion: "1",
    outputArtifactId: output.id,
    outputAnalysisId: null,
    orcaEtaS: over.etaS ?? 3600,
    filamentG: 20,
    filamentMm: 1000,
    dimensions: { size: [100, 100, 100] },
    warnings: [],
    blockers: [],
    error: null,
    startedAt: ISO,
    endedAt: ISO,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    metadata: {}
  };
  repos.sliceVariants.insert(variant);
  return task;
}

/** Seeds an approved machine profile set bound to a printer id (no slice) — the bed source. */
function insertApprovedMachineSet(
  db: PrintQueueStore,
  printerId: string,
  bed: { w: number; d: number; h: number } = { w: 300, d: 300, h: 300 }
): void {
  const repos = db.repositories;
  const machine = revision(`am_${printerId}`, "machine", {
    nozzle_diameter: "0.4",
    // OrcaSlicer stores printable_area as an array of "XxY" polygon points.
    printable_area: [`0x0`, `${bed.w}x0`, `${bed.w}x${bed.d}`, `0x${bed.d}`],
    printable_height: String(bed.h),
    gcode_flavor: "klipper"
  });
  const process = revision(`ap_${printerId}`, "process", { layer_height: "0.2" });
  const filament = revision(`af_${printerId}`, "filament", { filament_type: "PLA" });
  repos.profileRevisions.insert(machine);
  repos.profileRevisions.insert(process);
  repos.profileRevisions.insert(filament);
  repos.profileSets.insert({
    id: `apset_${printerId}`,
    name: `approved_${printerId}`,
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId,
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
  });
}

// ── Compatibility matrix ─────────────────────────────────────────────────────

test("compatibility matrix: a matching gcode task is compatible; a nozzle mismatch is blocked", () => {
  const db = store();
  insertGcodeTask(db, "t1");
  const svc = makeService(db, [printer("p1"), printer("p2", { nozzleMm: 0.6 })]);
  const matrix = svc.compatibilityMatrix();
  const row = matrix.rows.find((r) => r.taskId === "t1")!;
  assert.equal(row.results.find((r) => r.printerId === "p1")!.verdict, "compatible");
  const p2 = row.results.find((r) => r.printerId === "p2")!;
  assert.equal(p2.verdict, "blocked");
  assert.ok(p2.blockers.some((b) => b.code === "nozzle_mismatch"));
});

test("compatibility matrix: a material clash is blocked; stale telemetry is review", () => {
  const db = store();
  insertGcodeTask(db, "t1", { material: "PETG" });
  const svc = makeService(db, [
    printer("p1", { material: "PLA" }),
    printer("p2", { material: "PETG", telemetryAgeMs: 10 * 60_000 })
  ]);
  const row = svc.compatibilityMatrix().rows[0];
  assert.equal(row.results.find((r) => r.printerId === "p1")!.verdict, "blocked");
  const p2 = row.results.find((r) => r.printerId === "p2")!;
  assert.equal(p2.verdict, "review");
  assert.ok(p2.reviews.some((r) => r.code === "telemetry_stale"));
});

test("compatibility: a model with no ready slice is blocked (slice_missing)", () => {
  const db = store();
  // A model task with no slice variant at all.
  const repos = db.repositories;
  repos.artifacts.insert({
    id: "art_m",
    kind: "model",
    name: "m.stl",
    source: "m.stl",
    sizeBytes: null,
    sha256: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {}
  });
  repos.tasks.insert({
    id: "m1",
    artifactId: "art_m",
    title: "m1",
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
  });
  repos.queue.insert({ id: "qe_m1", taskId: "m1", position: 10, state: "WAITING", enqueuedAt: ISO, updatedAt: ISO, version: 1 });
  const svc = makeService(db, [printer("p1")]);
  const r = svc.compatibilityMatrix().rows[0].results[0];
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "slice_missing"));
});

test("compatibility: a quarantined profile set behind a ready slice is blocked", () => {
  const db = store();
  insertSlicedTask(db, "q1", "p1", { validation: "blocked", approved: false });
  const svc = makeService(db, [printer("p1")]);
  const r = svc.compatibilityMatrix().rows[0].results[0];
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "profileset_quarantined"));
});

test("compatibility: a class-scoped slice matches only a same-class printer, never any printer", () => {
  const db = store();
  // A model task whose only ready slice is class-scoped ("k2"), not bound to a printer id.
  insertSlicedTask(db, "c1", "unused", { classScoped: "k2" });
  const svc = makeService(db, [
    printer("same", { printerClass: "k2" }),
    printer("other", { printerClass: "a1" }),
    printer("classless") // no printerClass at all
  ]);
  const row = svc.compatibilityMatrix().rows.find((r) => r.taskId === "c1")!;

  // Same class → the slice is found → compatible.
  assert.equal(row.results.find((r) => r.printerId === "same")!.verdict, "compatible");
  // Different class → the slice is NOT its slice → blocked on slice_missing.
  const other = row.results.find((r) => r.printerId === "other")!;
  assert.equal(other.verdict, "blocked");
  assert.ok(other.blockers.some((b) => b.code === "slice_missing"));
  // A class-less printer never matches a null-target variant (fail-closed).
  const classless = row.results.find((r) => r.printerId === "classless")!;
  assert.equal(classless.verdict, "blocked");
  assert.ok(classless.blockers.some((b) => b.code === "slice_missing"));
});

test("compatibility: an unknown ETA yields eta.seconds null (never fabricated)", () => {
  const db = store();
  insertGcodeTask(db, "t1", { durationS: null });
  const svc = makeService(db, [printer("p1")]);
  const r = svc.compatibilityMatrix().rows[0].results[0];
  assert.equal(r.eta.seconds, null);
  assert.equal(r.eta.source, "unknown");
});

// ── Plans ─────────────────────────────────────────────────────────────────────

test("buildDraftPlan places a task and stores a full explanation", () => {
  const db = store();
  insertGcodeTask(db, "t1");
  const svc = makeService(db, [printer("p1"), printer("p2")]);
  const detail = svc.buildDraftPlan({ name: "batch" });
  assert.equal(detail.plan.state, "DRAFT");
  assert.equal(detail.plan.revision, 1);
  assert.equal(detail.assignments.length, 1);
  const a = detail.assignments[0];
  assert.equal(a.assignment.state, "PROPOSED");
  assert.ok(a.explanation);
  assert.ok(typeof a.explanation?.reason === "string");
  assert.equal(a.explanation?.etaSource, "gcode_analysis");
});

test("confirmPlan moves DRAFT → ACTIVE once and refuses a second confirm", () => {
  const db = store();
  insertGcodeTask(db, "t1");
  const svc = makeService(db, [printer("p1")]);
  const draft = svc.buildDraftPlan();
  const confirmed = svc.confirmPlan(draft.plan.id);
  assert.equal(confirmed.plan.state, "ACTIVE");
  assert.ok(confirmed.plan.confirmedAt);
  assert.throws(() => svc.confirmPlan(draft.plan.id), /только черновик/);
});

test("recomputePlan creates a new DRAFT revision, supersedes the old draft, and keeps stability", () => {
  const db = store();
  insertGcodeTask(db, "t1");
  const svc = makeService(db, [printer("p1"), printer("p2")]);
  const first = svc.buildDraftPlan();
  const firstPrinter = first.assignments[0].assignment.printerId;
  const second = svc.recomputePlan(first.plan.id);

  assert.equal(second.plan.revision, 2);
  assert.equal(second.plan.basePlanId, first.plan.id);
  assert.equal(second.plan.state, "DRAFT");
  // The superseded draft is cancelled.
  assert.equal(db.repositories.plans.getById(first.plan.id)?.state, "CANCELLED");
  // Stability keeps the task on the same printer.
  assert.equal(second.assignments[0].assignment.printerId, firstPrinter);
  assert.ok(second.assignments[0].explanation?.scoreBreakdown.some((c) => c.label === "стабильность плана"));
});

test("a confirmed plan is not modified by a recompute (a new draft is created instead)", () => {
  const db = store();
  insertGcodeTask(db, "t1");
  const svc = makeService(db, [printer("p1")]);
  const draft = svc.buildDraftPlan();
  const confirmed = svc.confirmPlan(draft.plan.id);
  const recomputed = svc.recomputePlan(confirmed.plan.id);
  // The confirmed plan is untouched; recompute produced a separate new draft.
  assert.equal(db.repositories.plans.getById(confirmed.plan.id)?.state, "ACTIVE");
  assert.equal(recomputed.plan.state, "DRAFT");
  assert.notEqual(recomputed.plan.id, confirmed.plan.id);
});

test("buildDraftPlan honours a pin and records it in the explanation", () => {
  const db = store();
  const task = insertGcodeTask(db, "t1");
  db.repositories.tasks.update({ ...task, pinnedPrinterId: "p2" });
  const svc = makeService(db, [printer("p1"), printer("p2")]);
  const detail = svc.buildDraftPlan();
  assert.equal(detail.assignments[0].assignment.printerId, "p2");
});

// ── Night candidates ─────────────────────────────────────────────────────────

test("night candidates: eligible tasks compete for one slot per printer, buffered + preliminary", () => {
  const db = store();
  insertSlicedTask(db, "n1", "p1", { unattended: true, etaS: 3600 });
  insertSlicedTask(db, "n2", "p1", { unattended: true, etaS: 7200 });
  const svc = makeService(db, [printer("p1", { materialRemainingSufficient: true })]);
  const report = svc.nightCandidates();
  assert.equal(report.candidates.length, 1, "one slot per printer");
  const chosen = report.candidates[0];
  assert.equal(chosen.printerId, "p1");
  assert.ok(chosen.preliminary);
  assert.equal(chosen.bufferedEtaSeconds, Math.round((chosen.taskId === "n2" ? 7200 : 3600) * 1.2));
  assert.ok(report.rejected.some((r) => r.reasons.some((x) => /одна печать на принтер/.test(x))));
});

test("night candidates: unknown remaining material fails the gate (never assumed sufficient)", () => {
  const db = store();
  insertSlicedTask(db, "n1", "p1", { unattended: true });
  const svc = makeService(db, [printer("p1", { materialRemainingSufficient: null })]);
  const report = svc.nightCandidates();
  assert.equal(report.candidates.length, 0);
  assert.ok(
    report.rejected[0].reasons.some((r) => /остаток материала/.test(r)),
    "material sufficiency unknown is surfaced"
  );
});

test("night candidates: a task without unattended permission is never eligible", () => {
  const db = store();
  insertSlicedTask(db, "n1", "p1", { unattended: false });
  const svc = makeService(db, [printer("p1", { materialRemainingSufficient: true })]);
  const report = svc.nightCandidates();
  assert.equal(report.candidates.length, 0);
});

// ── #1 build volume from the approved machine profile ──────────────────────────

test("a G-code task fits when the bed comes from the printer's approved machine profile", () => {
  const db = store();
  insertGcodeTask(db, "g1"); // 100³ model, PLA, 0.4 nozzle, no slice
  insertApprovedMachineSet(db, "p1", { w: 300, d: 300, h: 300 });
  // The printer carries no explicit config build volume → the profile is the source.
  const svc = makeService(db, [printer("p1", { buildVolume: null })]);
  const r = svc.compatibilityMatrix().rows[0].results[0];
  assert.equal(r.verdict, "compatible");
  assert.ok(!r.reviews.some((x) => x.code === "build_volume_unknown"), "bed is known from the profile");
});

test("a config build volume that disagrees with the profile is a review, not silent", () => {
  const db = store();
  insertGcodeTask(db, "g1");
  insertApprovedMachineSet(db, "p1", { w: 300, d: 300, h: 300 });
  // Config says a smaller (but still fitting) bed than the profile → conflict review.
  const svc = makeService(db, [printer("p1", { buildVolume: { x: 250, y: 250, z: 250 } })]);
  const r = svc.compatibilityMatrix().rows[0].results[0];
  assert.equal(r.verdict, "review");
  assert.ok(r.reviews.some((x) => x.code === "build_volume_conflict"));
});

// ── #2/#3 night gate: ready G-code + operator material override ─────────────────

test("night: a ready G-code task with a material override is eligible (no slice/profile needed)", () => {
  const db = store();
  insertGcodeTask(db, "n1", { unattended: true }); // gcode, clean analysis, ETA 3600, no slice
  const svc = makeService(db, [printer("p1")]);
  // Unknown remaining material → rejected.
  assert.equal(svc.nightCandidates().candidates.length, 0);
  // The operator asserts enough filament → the candidate clears the gate.
  svc.setMaterialOverride("p1", { coverageHours: 10 });
  const report = svc.nightCandidates();
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].taskId, "n1");
});

test("setMaterialOverride refuses a printer the farm does not know", () => {
  const db = store();
  const svc = makeService(db, [printer("p1")]);
  assert.throws(() => svc.setMaterialOverride("ghost-9000", { coverageHours: 5 }), /конфигурации фермы/);
});

// ── #4 confirm supersede + revalidate ──────────────────────────────────────────

test("confirmPlan supersedes the previous ACTIVE plan — never two live plans at once", () => {
  const db = store();
  insertGcodeTask(db, "t1");
  const svc = makeService(db, [printer("p1")]);
  const first = svc.confirmPlan(svc.buildDraftPlan().plan.id);
  const second = svc.confirmPlan(svc.buildDraftPlan().plan.id);
  assert.equal(second.plan.state, "ACTIVE");
  assert.equal(db.repositories.plans.getById(first.plan.id)?.state, "CANCELLED");
  assert.equal(db.repositories.plans.list().filter((p) => p.state === "ACTIVE").length, 1);
});

test("confirmPlan refuses a draft whose task is no longer schedulable (409)", () => {
  const db = store();
  insertGcodeTask(db, "t1");
  const svc = makeService(db, [printer("p1")]);
  const draft = svc.buildDraftPlan();
  assert.equal(draft.assignments.length, 1);
  // The task leaves the schedulable set after the draft was built.
  const task = db.repositories.tasks.getById("t1")!;
  db.repositories.tasks.update({ ...task, state: "CANCELLED" });
  assert.throws(() => svc.confirmPlan(draft.plan.id), /устарел/);
});

// ── #5 free-time from telemetry + confirmed assignments ─────────────────────────

test("a printer currently printing pushes the task start past its remaining time", () => {
  const db = store();
  insertGcodeTask(db, "t1", { durationS: 3600 });
  const svc = makeService(db, [printer("p1", { status: "printing", printingTimeLeftMs: 2 * 3600 * 1000 })]);
  const ex = svc.buildDraftPlan().assignments[0].explanation!;
  assert.ok(ex.startMs >= NOW.getTime() + 2 * 3600 * 1000 - 1000, "starts after the current print finishes");
});

test("a printing printer with unknown remaining time warns that free-time is estimated", () => {
  const db = store();
  insertGcodeTask(db, "t1", { durationS: 3600 });
  const svc = makeService(db, [printer("p1", { status: "printing", printingTimeLeftMs: null })]);
  const ex = svc.buildDraftPlan().assignments[0].explanation!;
  assert.ok(ex.warnings.some((w) => /оценено приблизительно/.test(w)));
});

test("night gate: a printer physically printing with no bed cycle is not a clear bed", () => {
  const db = store();
  insertGcodeTask(db, "n1", { unattended: true });
  const svc = makeService(db, [printer("p1", { status: "printing", printingTimeLeftMs: null })]);
  svc.setMaterialOverride("p1", { coverageHours: 10 });
  const report = svc.nightCandidates();
  assert.equal(report.candidates.length, 0);
  assert.ok(report.rejected.some((r) => r.reasons.some((x) => /стол не свободен/.test(x))));
});

// ── active/UNKNOWN run holds the printer even when telemetry reads idle ──────────

test("a printer held by an UNKNOWN canonical run is never a night candidate (fail-closed on UNKNOWN)", () => {
  const db = store();
  insertGcodeTask(db, "n1", { unattended: true });
  // Telemetry reads idle+fresh, but a canonical UNKNOWN run holds the printer — the
  // run must win: an UNKNOWN outcome holds the printer and is never treated as free.
  const svc = makeService(db, [printer("p1", { status: "idle", activeRunState: "UNKNOWN" })]);
  svc.setMaterialOverride("p1", { coverageHours: 10 });
  const report = svc.nightCandidates();
  assert.equal(report.candidates.length, 0);
  assert.ok(report.rejected.some((r) => r.reasons.some((x) => /стол не свободен/.test(x))));
});

test("a printer held by a PENDING run is not planned as free-now (start pushed out + estimated)", () => {
  const db = store();
  insertGcodeTask(db, "t1", { durationS: 3600 });
  // Telemetry idle, but a canonical PENDING run (a dispatch reservation) holds it.
  const svc = makeService(db, [printer("p1", { status: "idle", activeRunState: "PENDING" })]);
  const ex = svc.buildDraftPlan().assignments[0].explanation!;
  assert.ok(ex.startMs > NOW.getTime() + 60_000, "start is pushed past now, not free-now");
  assert.ok(ex.warnings.some((w) => /оценено приблизительно/.test(w)));
});

// ── night gate ETA goes through the same resolver as the compatibility matrix ────

test("night gate: a non-positive slice/gcode ETA is unknown, never a known/negative night ETA", () => {
  const db = store();
  // Bad analysis data: a non-positive duration must resolve to unknown (like the
  // compatibility matrix), not sneak through as a known ETA with a negative buffer.
  insertGcodeTask(db, "n1", { unattended: true, durationS: -1 });
  const svc = makeService(db, [printer("p1", { materialRemainingSufficient: true })]);
  const report = svc.nightCandidates();
  assert.equal(report.candidates.length, 0);
  assert.ok(report.rejected.some((r) => r.reasons.some((x) => /ETA неизвестна/.test(x))));
});

// ── #13 / #14 planning hygiene ──────────────────────────────────────────────────

test("an ASSIGNED task is excluded from planning and the compatibility matrix", () => {
  const db = store();
  const task = insertGcodeTask(db, "t1");
  db.repositories.tasks.update({ ...task, state: "ASSIGNED" });
  const svc = makeService(db, [printer("p1")]);
  assert.equal(svc.buildDraftPlan().assignments.length, 0);
  assert.equal(svc.compatibilityMatrix().rows.length, 0);
});

test("building a fresh draft supersedes an earlier outstanding draft (no orphans)", () => {
  const db = store();
  insertGcodeTask(db, "t1");
  const svc = makeService(db, [printer("p1")]);
  const first = svc.buildDraftPlan();
  const second = svc.buildDraftPlan();
  assert.equal(db.repositories.plans.getById(first.plan.id)?.state, "CANCELLED");
  assert.equal(second.plan.state, "DRAFT");
  assert.equal(db.repositories.plans.list().filter((p) => p.state === "DRAFT").length, 1);
});
