import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateCompatibility,
  type CompatibilityEvidence,
  type CompatibilityPrinterInput,
  type CompatibilityTaskInput
} from "./compatibility";

function task(over: Partial<CompatibilityTaskInput> = {}): CompatibilityTaskInput {
  return {
    id: "task1",
    title: "T",
    material: "PLA",
    pinnedPrinterId: null,
    dimensions: { x: 100, y: 100, z: 100 },
    requiredNozzleMm: 0.4,
    gcodeFlavor: "klipper",
    amsRequired: null,
    needsSlicing: false,
    ...over
  };
}

function printer(over: Partial<CompatibilityPrinterInput> = {}): CompatibilityPrinterInput {
  return {
    id: "p1",
    name: "K2",
    model: "K2",
    protocol: "moonraker",
    material: "PLA",
    nozzleMm: 0.4,
    buildVolume: { x: 300, y: 300, z: 300 },
    online: true,
    status: "idle",
    remoteStartSupported: true,
    ams: true,
    ...over
  };
}

function evidence(over: Partial<CompatibilityEvidence> = {}): CompatibilityEvidence {
  return {
    readySliceVariant: true,
    profileSetApproved: true,
    profileSetBlocked: false,
    runtimeAvailable: true,
    bedCycle: "CLEAR",
    telemetryAgeMs: 1000,
    maintenanceBlockers: [],
    sliceEtaS: 3600,
    gcodeEtaS: null,
    ...over
  };
}

test("a fully-specified, matching task×printer is compatible", () => {
  const r = evaluateCompatibility(task(), printer(), evidence());
  assert.equal(r.verdict, "compatible");
  assert.equal(r.blockers.length, 0);
  assert.equal(r.eta.seconds, 3600);
});

test("a model too large for the build volume is blocked", () => {
  const r = evaluateCompatibility(
    task({ dimensions: { x: 400, y: 100, z: 100 } }),
    printer(),
    evidence()
  );
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "too_large"));
});

test("a nozzle mismatch is blocked", () => {
  const r = evaluateCompatibility(task({ requiredNozzleMm: 0.6 }), printer({ nozzleMm: 0.4 }), evidence());
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "nozzle_mismatch"));
});

test("a concrete material clash is blocked", () => {
  const r = evaluateCompatibility(task({ material: "PETG" }), printer({ material: "PLA" }), evidence());
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "material_mismatch"));
});

test("unknown loaded material is review, not compatible", () => {
  const r = evaluateCompatibility(task(), printer({ material: null }), evidence());
  assert.equal(r.verdict, "review");
  assert.ok(r.reviews.some((b) => b.code === "printer_material_unknown"));
});

test("unknown nozzle diameter is review", () => {
  const r = evaluateCompatibility(task(), printer({ nozzleMm: null }), evidence());
  assert.equal(r.verdict, "review");
  assert.ok(r.reviews.some((b) => b.code === "printer_nozzle_unknown"));
});

test("a quarantined profile set is blocked", () => {
  const r = evaluateCompatibility(task(), printer(), evidence({ profileSetBlocked: true }));
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "profileset_quarantined"));
});

test("a model that needs slicing with no ready variant is blocked", () => {
  const r = evaluateCompatibility(
    task({ needsSlicing: true, requiredNozzleMm: 0.4 }),
    printer(),
    evidence({ readySliceVariant: false })
  );
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "slice_missing"));
});

test("un-sliced work is blocked with a clear reason when the OrcaSlicer runtime is unavailable", () => {
  const r = evaluateCompatibility(
    task({ needsSlicing: true }),
    printer(),
    evidence({ readySliceVariant: false, runtimeAvailable: false })
  );
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "slicing_unavailable"));
});

test("stale telemetry downgrades to review", () => {
  const r = evaluateCompatibility(task(), printer(), evidence({ telemetryAgeMs: 5 * 60_000 }));
  assert.equal(r.verdict, "review");
  assert.ok(r.reviews.some((b) => b.code === "telemetry_stale"));
});

test("absent telemetry is review", () => {
  const r = evaluateCompatibility(task(), printer(), evidence({ telemetryAgeMs: null }));
  assert.equal(r.verdict, "review");
  assert.ok(r.reviews.some((b) => b.code === "telemetry_missing"));
});

test("a pin to another printer is blocked", () => {
  const r = evaluateCompatibility(task({ pinnedPrinterId: "other" }), printer({ id: "p1" }), evidence());
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "pinned_elsewhere"));
});

test("a bed awaiting clearance is review; a busy printer is only a warning", () => {
  const awaiting = evaluateCompatibility(task(), printer(), evidence({ bedCycle: "AWAITING_CLEARANCE" }));
  assert.equal(awaiting.verdict, "review");
  const busy = evaluateCompatibility(task(), printer({ status: "printing" }), evidence({ bedCycle: "RUNNING" }));
  assert.equal(busy.verdict, "compatible");
  assert.ok(busy.warnings.some((w) => w.code === "printer_busy"));
});

test("a maintenance blocker blocks", () => {
  const r = evaluateCompatibility(task(), printer(), evidence({ maintenanceBlockers: ["замена ремня"] }));
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "maintenance"));
});

test("an AMS requirement the printer cannot meet is blocked", () => {
  const r = evaluateCompatibility(task({ amsRequired: true }), printer({ ams: false }), evidence());
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "ams_unsupported"));
});
