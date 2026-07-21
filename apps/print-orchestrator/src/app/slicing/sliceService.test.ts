import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { ProfileRevision, ProfileType } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ArtifactService } from "../artifacts/artifactService";
import { ProfileService, type SlicerPrinterRef } from "./profileService";
import { SliceService } from "./sliceService";
import { FAKE_ORCA_GCODE, FakeOrcaRunner } from "./testkit/fakeOrcaRunner";

const LIMITS = {
  zipMaxEntries: 1000,
  zipMaxEntryBytes: 64 * 1024 * 1024,
  zipMaxTotalBytes: 128 * 1024 * 1024,
  zipMaxRatio: 200,
  xmlMaxBytes: 16 * 1024 * 1024
};

const PRINTERS: SlicerPrinterRef[] = [
  // "k2-farm": two interchangeable, identical K2s (0.4) — a homogeneous class.
  { id: "creality-k2", name: "Creality K2", model: "Creality K2", material: "PETG", protocol: "moonraker", nozzleMm: 0.4, printerClass: "k2-farm" },
  { id: "creality-k2-b", name: "Creality K2 #2", model: "Creality K2", material: "PETG", protocol: "moonraker", nozzleMm: 0.4, printerClass: "k2-farm" },
  // "k2-mixed": same model but different nozzles — a HETEROGENEOUS class.
  { id: "k2-mixed-ok", name: "Creality K2 (0.4)", model: "Creality K2", material: "PETG", protocol: "moonraker", nozzleMm: 0.4, printerClass: "k2-mixed" },
  { id: "k2-big-nozzle", name: "Creality K2 (0.6)", model: "Creality K2", material: "PETG", protocol: "moonraker", nozzleMm: 0.6, printerClass: "k2-mixed" },
  { id: "ender3-v3-ke", name: "Creality Ender 3 V3 KE", model: "Creality Ender 3 V3 KE", material: "PLA / PETG / TPU", protocol: "creality" }
];

let TMP: string;
let store: PrintQueueStore;
let storage: ArtifactStorage;
let artifacts: ArtifactService;
let runner: FakeOrcaRunner;
let slice: SliceService;
let profiles: ProfileService;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "slice-svc-"));
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
    concurrency: 1,
    listPrinters: () => PRINTERS
  });
  profiles = new ProfileService(store, runner, () => PRINTERS);
});

afterEach(() => {
  slice.close();
  artifacts.close();
  store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function insertRevision(
  type: ProfileType,
  name: string,
  resolved: Record<string, unknown>,
  status: ProfileRevision["status"] = "active"
): ProfileRevision {
  const raw = JSON.stringify({ name, type, ...resolved });
  const resolvedJson = JSON.stringify({ name, type, ...resolved });
  const rev: ProfileRevision = {
    id: newId(ID_PREFIX.profileRevision),
    logicalId: `${type}:${name}`,
    type,
    name,
    inherits: null,
    status,
    rawJson: raw,
    rawSha256: sha(raw + Math.random()),
    resolvedJson: status === "active" ? resolvedJson : null,
    resolvedSha256: status === "active" ? sha(resolvedJson) : null,
    orcaVersion: "2.3.0",
    source: null,
    warnings: [],
    blockers: status === "active" ? [] : [{ code: "missing_parent", message: "x" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    metadata: {}
  };
  store.repositories.profileRevisions.insert(rev);
  return rev;
}

/** Seeds a valid, mutually-compatible active machine/process/filament trio. */
function seedActiveTrio() {
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
    nozzle_temperature_initial_layer: ["245"],
    hot_plate_temp: ["80"]
  });
  return { machine, process, filament };
}

/** Uploads an STL and returns its (needs_preparation) artifact id. */
async function uploadModel(seed = 5): Promise<string> {
  const res = await artifacts.ingest({ source: Readable.from(binaryStl(seed)), fileName: "cube.stl" });
  await artifacts.whenIdle();
  const analysis = store.repositories.artifactAnalyses.latestForArtifact(res.artifact.id);
  assert.equal(analysis?.verdict, "needs_preparation");
  return res.artifact.id;
}

async function approvedSet(): Promise<string> {
  const { machine, process, filament } = seedActiveTrio();
  const set = profiles.createSet({
    name: "K2 · PETG",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId: "creality-k2"
  });
  assert.notEqual(set.validation, "blocked", JSON.stringify(set.blockers));
  const approved = profiles.approveSet(set.id);
  assert.equal(approved.approved, true);
  return set.id;
}

/** An approved *class-scoped* set (targets an interchangeable printer class). */
function approvedClassSet(printerClass = "k2-farm"): string {
  const { machine, process, filament } = seedActiveTrio();
  const set = profiles.createSet({
    name: `class ${printerClass}`,
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerClass
  });
  assert.notEqual(set.validation, "blocked", JSON.stringify(set.blockers));
  const approved = profiles.approveSet(set.id);
  assert.equal(approved.approved, true);
  return set.id;
}

function leftoverWorkDirs(): string[] {
  return fs.readdirSync(path.join(TMP, "work")).filter((n) => n.startsWith("slice-"));
}

/** Polls `cond` until true (or times out) — for observing async worker transitions. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: условие не выполнилось за отведённое время");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("fake slicing succeeds: ready variant, output artifact analysed, estimates copied, temp cleaned", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();

  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  assert.equal(variant.state, "pending");
  await slice.whenIdle();

  const done = slice.getVariant(variant.id);
  assert.equal(done.state, "ready");
  assert.ok(done.outputArtifactId);
  assert.ok(done.outputAnalysisId);
  // OrcaSlicer's own ETA/usage/geometry, taken from re-analysing the output.
  assert.equal(done.orcaEtaS, 5025);
  assert.equal(done.filamentG, 10.3);
  assert.equal(done.filamentMm, 3456.7);
  assert.ok(done.dimensions);

  // The output is a real, content-addressed G-code artifact analysed as gcode.
  const out = store.repositories.artifacts.getById(done.outputArtifactId as string);
  assert.equal(out?.kind, "gcode");
  const outAnalysis = store.repositories.artifactAnalyses.latestForArtifact(out!.id);
  assert.equal(outAnalysis?.detectedFormat, "gcode");
  assert.equal(runner.sliceCount, 1);

  // Temp dir cleaned up.
  assert.deepEqual(leftoverWorkDirs(), []);
});

test("rerun clears the previous output and estimates before re-slicing (a failing re-run shows no stale output)", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();

  // First slice succeeds → ready with output + OrcaSlicer estimates.
  const first = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  const ready = slice.getVariant(first.id);
  assert.equal(ready.state, "ready");
  assert.ok(ready.outputArtifactId);
  assert.ok(ready.orcaEtaS);

  // Re-run, but OrcaSlicer now fails: the variant must end `failed` with NO output
  // and NO estimates left over from the previous attempt.
  runner.behavior = "fail";
  const reset = slice.rerun(ready.id);
  assert.equal(reset.state, "pending");
  // Already cleared at the pending transition — not carried from the old attempt.
  assert.equal(reset.outputArtifactId, null);
  assert.equal(reset.outputAnalysisId, null);
  assert.equal(reset.orcaEtaS, null);
  assert.equal(reset.filamentG, null);
  assert.equal(reset.filamentMm, null);
  assert.equal(reset.dimensions, null);

  await slice.whenIdle();
  const failed = slice.getVariant(ready.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.outputArtifactId, null);
  assert.equal(failed.orcaEtaS, null);
  assert.equal(failed.filamentG, null);
});

test("a slice whose OUTPUT analysis is blocked never becomes ready", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();
  // OrcaSlicer emits a file carrying a forbidden config-mutating command (e.g. an
  // M502 baked into a profile's start G-code): the analyzer blocks it (verdict
  // blocked, state ready), so the variant must be blocked — not ready.
  runner.gcode = FAKE_ORCA_GCODE.replace("G28", "G28\nM502");
  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();

  const done = slice.getVariant(variant.id);
  assert.equal(done.state, "blocked");
  assert.ok(done.blockers.some((b) => b.code === "gcode_forbidden_command"));
  // The output stays linked so the operator can inspect exactly why.
  assert.ok(done.outputArtifactId);
  const outAnalysis = store.repositories.artifactAnalyses.getById(done.outputAnalysisId as string);
  assert.equal(outAnalysis?.verdict, "blocked");

  // And it is never reusable as a cache hit: a re-slice re-runs, never serves it ready.
  const again = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  assert.equal(slice.getVariant(again.id).state, "blocked");
});

test("a slice whose OUTPUT only reaches `review` is blocked, not ready (schedulable-only gate)", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();
  // Drop the printer_model banner → the analyzer cannot confirm a target → `review`,
  // which is not schedulable, so the variant must not go ready.
  runner.gcode = FAKE_ORCA_GCODE.replace("; printer_model = Bambu Lab A1\n", "");
  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();

  const done = slice.getVariant(variant.id);
  assert.equal(done.state, "blocked");
  assert.ok(done.blockers.some((b) => b.code === "output_not_schedulable"));
  assert.ok(done.outputArtifactId);
});

test("the source analysis is NOT overwritten by the slice", async () => {
  const artifactId = await uploadModel();
  const before = store.repositories.artifactAnalyses.latestForArtifact(artifactId);
  const setId = await approvedSet();
  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  const after = store.repositories.artifactAnalyses.latestForArtifact(artifactId);
  assert.equal(after?.id, before?.id);
  assert.equal(after?.verdict, "needs_preparation");
});

test("a second identical slice is a cache hit — no second Orca run", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();
  const first = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  assert.equal(runner.sliceCount, 1);

  const second = await slice.createSlice({ artifactId, profileSetId: setId });
  assert.equal(second.state, "ready");
  assert.equal(second.outputArtifactId, slice.getVariant(first.id).outputArtifactId);
  assert.ok(second.warnings.some((w) => w.code === "cache_hit"));
  await slice.whenIdle();
  assert.equal(runner.sliceCount, 1); // still only one real slice
});

test("timeout marks the variant failed (no output artifact)", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();
  runner.behavior = "timeout";
  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  const done = slice.getVariant(variant.id);
  assert.equal(done.state, "failed");
  assert.match(done.error ?? "", /лимит|отмен/i);
  assert.equal(done.outputArtifactId, null);
  assert.deepEqual(leftoverWorkDirs(), []);
});

test("no runtime marks the variant blocked with an honest reason (never a fake slice)", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();
  runner.behavior = "unavailable";
  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  const done = slice.getVariant(variant.id);
  assert.equal(done.state, "blocked");
  assert.ok(done.blockers.some((b) => b.code === "runtime_unavailable"));
  assert.equal(done.outputArtifactId, null);
});

test("recover() re-queues a variant left running by a crash and completes it", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();
  // Simulate a crash: a variant stuck in "running".
  const created = await slice.createSlice({ artifactId, profileSetId: setId, force: true });
  await slice.whenIdle();
  // Force it back to running as if the process died mid-slice.
  const v = slice.getVariant(created.id);
  store.repositories.sliceVariants.update({ ...v, state: "running", outputArtifactId: null, outputAnalysisId: null });

  const recovered = slice.recover();
  assert.ok(recovered >= 1);
  await slice.whenIdle();
  assert.equal(slice.getVariant(created.id).state, "ready");
});

test("createSlice refuses an artifact that is not a needs_preparation model", async () => {
  const setId = await approvedSet();
  // Upload a G-code (verdict schedulable, not needs_preparation).
  const gcode = Buffer.from("; generated by PrusaSlicer 2.7.1\n; printer_model = MK4\nG1 X0 Y0\n");
  const res = await artifacts.ingest({ source: Readable.from(gcode), fileName: "part.gcode" });
  await artifacts.whenIdle();
  await assert.rejects(slice.createSlice({ artifactId: res.artifact.id, profileSetId: setId }), /needs_preparation/);
});

test("createSlice refuses an un-approved set", async () => {
  const artifactId = await uploadModel();
  const { machine, process, filament } = seedActiveTrio();
  const set = profiles.createSet({
    name: "unapproved",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId: "creality-k2"
  });
  await assert.rejects(slice.createSlice({ artifactId, profileSetId: set.id }), /не утвержд/i);
});

test("approving a set with a blocker (quarantined member) is refused", () => {
  const machine = insertRevision("machine", "Broken K2", {}, "quarantined");
  const { process, filament } = seedActiveTrio();
  const set = profiles.createSet({
    name: "broken",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId: "creality-k2"
  });
  assert.equal(set.validation, "blocked");
  assert.throws(() => profiles.approveSet(set.id), /блокер/i);
  // Still not approved.
  assert.equal(profiles.getSet(set.id).approved, false);
});

test("slicing never touches the legacy queue (no QueueEntry created)", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();
  await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  assert.deepEqual(store.repositories.queue.listOpen(), []);
});

test("createSet requires exactly one target and rejects an unknown printer id", () => {
  const { machine, process, filament } = seedActiveTrio();
  const base = {
    name: "x",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id
  };
  // Neither target.
  assert.throws(() => profiles.createSet({ ...base }), /ровно одну цель/i);
  // Both targets.
  assert.throws(
    () => profiles.createSet({ ...base, printerId: "creality-k2", printerClass: "k2" }),
    /ровно одну цель/i
  );
  // A concrete printer that is not in the farm config.
  assert.throws(() => profiles.createSet({ ...base, printerId: "ghost-printer" }), /не найден/i);
});

test("createSlice refuses retargeting a printer-bound set to a different printer", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet(); // bound to creality-k2
  await assert.rejects(
    slice.createSlice({ artifactId, profileSetId: setId, targetPrinterId: "ender3-v3-ke" }),
    /привязан к принтеру/i
  );
  // The set's own printer is accepted and becomes the variant's target.
  const ok = await slice.createSlice({ artifactId, profileSetId: setId, targetPrinterId: "creality-k2" });
  assert.equal(ok.targetPrinterId, "creality-k2");
});

test("a probe that THROWS marks the variant terminal (never stuck running)", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();
  // An infrastructure failure inside probe() (rejection, not a clean available:false)
  // used to escape the try/catch and leave the variant `running` forever.
  runner.probeError = new Error("probe boom (рантайм недоступен)");
  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  const done = slice.getVariant(variant.id);
  assert.equal(done.state, "failed");
  assert.notEqual(done.state, "running");
  assert.match(done.error ?? "", /probe boom/);
  assert.equal(done.outputArtifactId, null);
  assert.deepEqual(leftoverWorkDirs(), []);
});

test("an unavailable tmpRoot marks the variant terminal (never stuck running)", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();
  // Remove the work root after construction: mkdtemp inside it now fails (ENOENT).
  // That error occurs after the transition to `running` and must still terminate it.
  fs.rmSync(path.join(TMP, "work"), { recursive: true, force: true });
  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  const done = slice.getVariant(variant.id);
  assert.equal(done.state, "failed");
  assert.notEqual(done.state, "running");
  assert.equal(done.outputArtifactId, null);
});

test("a double-submit dedups to the same in-flight variant (no second Orca run)", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();

  // Hold the first slice mid-flight (running) so the second submit races it.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runner.onSlice = () => gate;

  const first = await slice.createSlice({ artifactId, profileSetId: setId });
  await waitFor(() => slice.getVariant(first.id).state === "running");

  // Same artifact + set + target while the first is still running → the identical
  // request must return the very same variant, not create a second one.
  const second = await slice.createSlice({ artifactId, profileSetId: setId });
  assert.equal(second.id, first.id);
  assert.equal(slice.listVariants().length, 1);

  release();
  await slice.whenIdle();
  assert.equal(slice.getVariant(first.id).state, "ready");
  assert.equal(runner.sliceCount, 1); // OrcaSlicer ran exactly once
});

test("a refused approval PERSISTS the refreshed blockers (not rolled back)", () => {
  // Create a valid set, then a member falls out of `active` (as a re-import would do).
  // Re-approving must refuse AND leave the fresh blockers visible — the previous
  // implementation threw inside the transaction and rolled the update back, so the
  // operator kept getting a reason-less refusal after re-import.
  const { machine, process, filament } = seedActiveTrio();
  const set = profiles.createSet({
    name: "K2 · PETG",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId: "creality-k2"
  });
  assert.notEqual(set.validation, "blocked");

  store.repositories.profileRevisions.update({
    ...machine,
    status: "quarantined",
    resolvedJson: null,
    resolvedSha256: null,
    blockers: [{ code: "missing_parent", message: "родитель недоступен" }]
  });

  assert.throws(() => profiles.approveSet(set.id), /блокер/i);

  const after = profiles.getSet(set.id);
  assert.equal(after.approved, false);
  assert.equal(after.validation, "blocked");
  assert.ok(after.blockers.some((b) => b.code === "member_not_active"));
});

test("printer coverage flags the Ender 3 V3 KE as having no machine profile", () => {
  seedActiveTrio(); // adds a Creality K2 machine profile only
  const coverage = profiles.printerCoverage();
  const ke = coverage.find((c) => c.printerId === "ender3-v3-ke");
  assert.ok(ke);
  assert.equal(ke.hasAnyProfile, false);
  assert.equal(ke.hasActiveProfile, false);
  const k2 = coverage.find((c) => c.printerId === "creality-k2");
  assert.equal(k2?.hasActiveProfile, true);
  // Coverage now carries the interchangeability class the "Новый набор" form needs.
  assert.equal(k2?.printerClass, "k2-farm");
  assert.equal(ke.printerClass, null);
});

// ── #1 Re-validation of an approved set after a re-import ─────────────────────

test("a re-import that quarantines a member revokes a previously-approved set (never a stale approved/valid)", () => {
  const { machine, process, filament } = seedActiveTrio();
  const set = profiles.createSet({
    name: "K2 · PETG",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId: "creality-k2"
  });
  assert.equal(profiles.approveSet(set.id).approved, true);

  // A re-import that broke the machine profile's inheritance (a vendor parent went
  // missing) flips the SAME revision id active → quarantined — exactly what the
  // importer's upsert does in place.
  store.repositories.profileRevisions.update({
    ...machine,
    status: "quarantined",
    resolvedJson: null,
    resolvedSha256: null,
    blockers: [{ code: "missing_parent", message: "родитель недоступен" }]
  });

  // A plain read must already reflect reality — recomputed, not the stale row.
  const shown = profiles.getSet(set.id);
  assert.equal(shown.approved, false);
  assert.equal(shown.validation, "blocked");
  assert.ok(shown.blockers.some((b) => b.code === "member_not_active"));
  assert.ok(shown.blockers.some((b) => b.code === "set_needs_revalidation"));

  // revalidateSets (run after every import) PERSISTS the revocation authoritatively.
  const changed = profiles.revalidateSets("operator");
  assert.ok(changed >= 1);
  const raw = store.repositories.profileSets.getById(set.id);
  assert.equal(raw?.approved, false);
  assert.equal(raw?.validation, "blocked");
});

test("re-import that leaves an approved set valid does NOT revoke it or churn (idempotent)", () => {
  const { machine, process, filament } = seedActiveTrio();
  const set = profiles.createSet({
    name: "stable",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerId: "creality-k2"
  });
  const approved = profiles.approveSet(set.id);
  const versionAfterApprove = store.repositories.profileSets.getById(set.id)?.version;

  assert.equal(profiles.revalidateSets("operator"), 0); // nothing changed
  const after = profiles.getSet(set.id);
  assert.equal(after.approved, true);
  assert.equal(after.approvedBy, approved.approvedBy);
  // Untouched: no version bump when the verdict is unchanged.
  assert.equal(store.repositories.profileSets.getById(set.id)?.version, versionAfterApprove);
});

// ── #2 Class-scoped set validation ───────────────────────────────────────────

test("class-scoped set: an existing compatible class validates; a nonexistent class is blocked and unapprovable", () => {
  const { machine, process, filament } = seedActiveTrio();
  const base = {
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id
  };
  const ok = profiles.createSet({ ...base, name: "existing", printerClass: "k2-farm" });
  assert.notEqual(ok.validation, "blocked", JSON.stringify(ok.blockers));
  assert.equal(profiles.approveSet(ok.id).approved, true);

  const ghost = profiles.createSet({ ...base, name: "ghost", printerClass: "no-such-class" });
  assert.equal(ghost.validation, "blocked");
  assert.ok(ghost.blockers.some((b) => b.code === "printer_class_unknown"));
  assert.throws(() => profiles.approveSet(ghost.id), /блокер/i);
});

test("class-scoped set: a heterogeneous class (only some printers fit) warns but is approvable", () => {
  const { machine, process, filament } = seedActiveTrio();
  const set = profiles.createSet({
    name: "mixed",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerClass: "k2-mixed"
  });
  assert.notEqual(set.validation, "blocked", JSON.stringify(set.blockers));
  assert.ok(set.warnings.some((w) => w.code === "printer_class_partial"));
  assert.equal(profiles.approveSet(set.id).approved, true);
});

test("class matching is case/space-insensitive", () => {
  const { machine, process, filament } = seedActiveTrio();
  const set = profiles.createSet({
    name: "cased",
    machineRevisionId: machine.id,
    processRevisionId: process.id,
    filamentRevisionId: filament.id,
    printerClass: "  K2-Farm  "
  });
  assert.notEqual(set.validation, "blocked", JSON.stringify(set.blockers));
});

// ── #5 A concrete target for a class-scoped set is validated before slicing ───

test("class-scoped slice: a concrete target must exist, be in the class, and be compatible", async () => {
  const artifactId = await uploadModel();
  const setId = approvedClassSet("k2-farm");

  // Nonexistent printer.
  await assert.rejects(
    slice.createSlice({ artifactId, profileSetId: setId, targetPrinterId: "ghost" }),
    /не найден/i
  );
  // A printer of a DIFFERENT class.
  await assert.rejects(
    slice.createSlice({ artifactId, profileSetId: setId, targetPrinterId: "ender3-v3-ke" }),
    /класс/i
  );
  assert.equal(runner.sliceCount, 0); // nothing sliced for the rejected targets

  // A compatible printer of the class → proceeds, carrying that target + the class.
  const ok = await slice.createSlice({ artifactId, profileSetId: setId, targetPrinterId: "creality-k2" });
  assert.equal(ok.targetPrinterId, "creality-k2");
  assert.equal(ok.targetPrinterClass, "k2-farm");
  await slice.whenIdle();
  assert.equal(slice.getVariant(ok.id).state, "ready");
});

test("class-scoped slice: an in-class but INCOMPATIBLE concrete target never slices or reaches ready", async () => {
  const artifactId = await uploadModel();
  const setId = approvedClassSet("k2-mixed"); // set machine is 0.4; class has a 0.6 too

  await assert.rejects(
    slice.createSlice({ artifactId, profileSetId: setId, targetPrinterId: "k2-big-nozzle" }),
    /несовместим|сопло/i
  );
  assert.equal(runner.sliceCount, 0);
  assert.equal(slice.listVariants().length, 0); // no variant was ever created

  // The compatible 0.4 member of the same class is accepted.
  const ok = await slice.createSlice({ artifactId, profileSetId: setId, targetPrinterId: "k2-mixed-ok" });
  assert.equal(ok.targetPrinterId, "k2-mixed-ok");
});

// ── #7 Unpinned deployments fold the detected version into the cache key ──────

test("unpinned deployment: the detected OrcaSlicer version is part of the cache key (an upgrade invalidates it)", async () => {
  const unpinned = new FakeOrcaRunner({ pinnedVersion: null, detectedVersion: "2.3.0" });
  const svc = new SliceService(store, storage, artifacts, unpinned, {
    tmpRoot: path.join(TMP, "work"),
    timeoutMs: 5000,
    concurrency: 1,
    listPrinters: () => PRINTERS
  });
  const profs = new ProfileService(store, unpinned, () => PRINTERS);
  try {
    const artifactId = await uploadModel();
    const { machine, process, filament } = seedActiveTrio();
    const set = profs.createSet({
      name: "unpinned",
      machineRevisionId: machine.id,
      processRevisionId: process.id,
      filamentRevisionId: filament.id,
      printerId: "creality-k2"
    });
    profs.approveSet(set.id);

    const first = await svc.createSlice({ artifactId, profileSetId: set.id });
    await svc.whenIdle();
    assert.equal(svc.getVariant(first.id).state, "ready");
    assert.equal(unpinned.sliceCount, 1);

    // Same inputs + same detected version → cache hit, no second slice.
    const cached = await svc.createSlice({ artifactId, profileSetId: set.id });
    assert.ok(cached.warnings.some((w) => w.code === "cache_hit"));
    assert.equal(unpinned.sliceCount, 1);

    // Simulate an OrcaSlicer upgrade: the detected version changes → different key →
    // NOT a cache hit → a genuine re-slice.
    unpinned.detectedVersion = "2.4.0";
    const afterUpgrade = await svc.createSlice({ artifactId, profileSetId: set.id });
    await svc.whenIdle();
    assert.ok(!afterUpgrade.warnings.some((w) => w.code === "cache_hit"));
    assert.equal(svc.getVariant(afterUpgrade.id).state, "ready");
    assert.equal(unpinned.sliceCount, 2);
  } finally {
    svc.close();
  }
});

// ── #4 The runtime is probed once per slice (result handed to the runner) ─────

test("the slice hands the runner the probe result it already took (single gate per op)", async () => {
  const artifactId = await uploadModel();
  const setId = await approvedSet();
  const variant = await slice.createSlice({ artifactId, profileSetId: setId });
  await slice.whenIdle();
  assert.equal(slice.getVariant(variant.id).state, "ready");
  // runPipeline probed and passed the fresh status into slice() — the runner never
  // needs to re-probe (the real runner asserts the no-second-`--version` in its own test).
  assert.ok(runner.lastProbed);
  assert.equal(runner.lastProbed?.available, true);
});
