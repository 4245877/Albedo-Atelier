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
    dimensionsScaleKnown: true,
    placement: null,
    requiredNozzleMm: 0.4,
    gcodeFlavor: "klipper",
    amsRequired: null,
    toolCount: null,
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
    faults: [],
    mediaPresent: null,
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

// ── Model scale ──────────────────────────────────────────────────────────────

test("a fitting box whose unit is unproven is review, never compatible", () => {
  const r = evaluateCompatibility(task({ dimensionsScaleKnown: false }), printer(), evidence());
  assert.equal(r.verdict, "review");
  assert.ok(r.reviews.some((x) => x.code === "model_scale_unknown"));
});

test("an unproven scale is reported even when the build volume is unknown too", () => {
  // The two unknowns are independent: an unreadable bed size must not swallow
  // the fact that the model's own numbers were never proven to be millimetres.
  const r = evaluateCompatibility(
    task({ dimensionsScaleKnown: false }),
    printer({ buildVolume: null }),
    evidence()
  );
  assert.equal(r.verdict, "review");
  const codes = r.reviews.map((x) => x.code);
  assert.ok(codes.includes("model_scale_unknown"));
  assert.ok(codes.includes("build_volume_unknown"));
});

test("no dimensions at all is `dimensions_unknown`, not a scale complaint", () => {
  const r = evaluateCompatibility(task({ dimensions: null }), printer(), evidence());
  assert.equal(r.verdict, "review");
  const codes = r.reviews.map((x) => x.code);
  assert.ok(codes.includes("dimensions_unknown"));
  assert.ok(!codes.includes("model_scale_unknown"));
});

test("an unproven box that already overflows the bed is blocked outright", () => {
  const r = evaluateCompatibility(
    task({ dimensions: { x: 400, y: 100, z: 100 }, dimensionsScaleKnown: false }),
    printer(),
    evidence()
  );
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "too_large"));
  assert.ok(r.reviews.some((x) => x.code === "model_scale_unknown"));
});

// ── Device faults ────────────────────────────────────────────────────────────
//
// A printer can be `idle` and still unable to start: a job that never begins
// never leaves idle. Until the fault channel was read, that case produced
// «принтер занят / в ошибке / недоступен / неизвестно сопло» — four reasons, all
// downstream of one MicroSD card the machine could not read, and none of them
// naming it.

const microSd = {
  code: "0500-C010",
  source: "print_error",
  title: "Ошибка чтения/записи карты MicroSD",
  action: "Переустановите карту MicroSD или замените её.",
  blocksStart: true
};

test("a start-blocking fault blocks, and names the code the printer is showing", () => {
  const result = evaluateCompatibility(
    task(),
    printer({ status: "idle", faults: [microSd] }),
    evidence()
  );

  const fault = result.blockers.find((b) => b.code === "printer_fault");
  assert.ok(fault, "an idle printer that cannot start must still refuse");
  assert.match(fault.message, /0500-C010/);
  assert.match(fault.message, /MicroSD/i);
});

test("a named fault replaces the vaguer «принтер в ошибке», never doubles it", () => {
  const result = evaluateCompatibility(
    task(),
    printer({ status: "error", faults: [microSd] }),
    evidence()
  );

  assert.equal(
    result.blockers.filter((b) => b.code === "printer_error").length,
    0,
    "the symptom is dropped once the cause is named"
  );
  assert.equal(result.blockers.filter((b) => b.code === "printer_fault").length, 1);
});

test("an error with no decoded cause still refuses, honestly", () => {
  const result = evaluateCompatibility(task(), printer({ status: "error" }), evidence());
  assert.ok(result.blockers.some((b) => b.code === "printer_error"));
});

test("an unrecognised fault is not allowed to block", () => {
  const result = evaluateCompatibility(
    task(),
    printer({
      status: "idle",
      faults: [{ code: "0700-8011", source: "hms", title: null, action: null, blocksStart: false }]
    }),
    evidence()
  );
  assert.equal(result.verdict, "compatible", "a number nobody decoded may not ground a printer");
});

test("an unreadable print medium blocks with its own reason", () => {
  const result = evaluateCompatibility(
    task(),
    printer({ status: "idle", mediaPresent: false }),
    evidence()
  );
  assert.ok(result.blockers.some((b) => b.code === "printer_media_missing"));
});

// ── An unresolved previous start ─────────────────────────────────────────────

test("a printer held by an unconfirmed start says so instead of «занят»", () => {
  const result = evaluateCompatibility(
    task(),
    printer({ status: "idle" }),
    evidence({ bedCycle: "RESERVED", heldByUnstartedRun: true })
  );

  assert.ok(
    result.blockers.some((b) => b.code === "launch_unconfirmed"),
    "the cause, with the way out"
  );
  assert.ok(
    !result.warnings.some((w) => w.code === "printer_busy"),
    "the bed it reserved is a consequence, and repeating it hides the cause"
  );
});

test("a genuinely occupied printer is still reported as busy", () => {
  const result = evaluateCompatibility(
    task(),
    printer({ status: "printing" }),
    evidence({ bedCycle: "RUNNING" })
  );
  assert.ok(result.warnings.some((w) => w.code === "printer_busy"));
  assert.ok(!result.blockers.some((b) => b.code === "launch_unconfirmed"));
});

// ── Multi-material: the analyzer counted tools all along, nobody read it ──────
//
// `toolCount` was computed by the G-code analyzer (Bambu's pseudo-tools already
// filtered out) and consumed by nothing, because `amsRequired` was hard-coded
// `null` in the evidence provider. A three-colour model therefore passed every
// check on a machine whose start payload maps every tool to the first loaded
// tray — it would have printed, in one filament, with nothing anomalous to see.

test("a multi-tool job is refused while no filament→slot mapping exists", () => {
  const r = evaluateCompatibility(
    task({ amsRequired: true, toolCount: 3 }),
    printer({ ams: true }),
    evidence({ amsSlotMapping: null })
  );
  const blocker = r.blockers.find((b) => b.code === "ams_mapping_ambiguous");
  assert.ok(blocker, "an unresolved mapping must refuse the automatic start");
  assert.match(blocker.message, /3 инструментов/);
  assert.equal(r.verdict, "blocked");
});

test("a resolved mapping lets a multi-tool job through", () => {
  const r = evaluateCompatibility(
    task({ amsRequired: true, toolCount: 2 }),
    printer({ ams: true }),
    evidence({ amsSlotMapping: "resolved" })
  );
  assert.equal(r.blockers.find((b) => b.code === "ams_mapping_ambiguous"), undefined);
});

test("a single-tool job is untouched by the AMS rules", () => {
  for (const tools of [1, null]) {
    const r = evaluateCompatibility(
      task({ amsRequired: tools === 1 ? false : null, toolCount: tools }),
      printer({ ams: null }),
      evidence({})
    );
    assert.deepEqual(
      r.blockers.filter((b) => b.code.startsWith("ams_")),
      [],
      `toolCount ${String(tools)} must not raise an AMS refusal`
    );
    assert.deepEqual(r.reviews.filter((b) => b.code.startsWith("ams_")), []);
  }
});

test("a multi-tool job on a printer with no AMS is refused for BOTH reasons", () => {
  const r = evaluateCompatibility(
    task({ amsRequired: true, toolCount: 4 }),
    printer({ ams: false }),
    evidence({})
  );
  const codes = r.blockers.map((b) => b.code);
  assert.ok(codes.includes("ams_unsupported"), "the machine cannot feed several filaments");
  assert.ok(codes.includes("ams_mapping_ambiguous"), "and nothing decided which goes where");
});

// ── Maintenance: the branch that could never fire ────────────────────────────

test("a blocking intervention on the printer reaches the planner as a maintenance blocker", () => {
  const r = evaluateCompatibility(
    task({}),
    printer({}),
    evidence({ maintenanceBlockers: ["замена сопла (IN_PROGRESS)"] })
  );
  const blocker = r.blockers.find((b) => b.code === "maintenance");
  assert.ok(blocker, "the planner must stop placing jobs on a machine under service");
  assert.match(blocker.message, /замена сопла/);
  assert.equal(r.verdict, "blocked");
});

// ── Absolute placement on the bed ───────────────────────────────────────────
//
// The size check asks whether this printer could make the part; it cannot ask
// whether the part is over the plate. A third-party G-code sliced for a 350 mm
// machine can place a 100 mm part at X 200…300 — a comfortable fit by size, and
// a crash into the frame of a 256 mm A1.

const A1_BED = { x: 256, y: 256, z: 256 };
const box = (min: [number, number, number], max: [number, number, number]) => ({
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] }
});

test("a part that FITS by size but sits off the bed is blocked", () => {
  const r = evaluateCompatibility(
    task({ dimensions: { x: 100, y: 100, z: 50 }, placement: box([200, 20, 0], [300, 120, 50]) }),
    printer({ buildVolume: A1_BED }),
    evidence({})
  );
  const blocker = r.blockers.find((b) => b.code === "model_off_bed");
  assert.ok(blocker, "100 mm fits 256 mm — but not at X 200…300");
  assert.match(blocker.message, /X/);
  assert.equal(r.blockers.find((b) => b.code === "too_large"), undefined, "it is not too large");
  assert.equal(r.verdict, "blocked");
});

test("a part placed on the bed passes", () => {
  const r = evaluateCompatibility(
    task({ dimensions: { x: 100, y: 100, z: 50 }, placement: box([20, 20, 0], [120, 120, 50]) }),
    printer({ buildVolume: A1_BED }),
    evidence({})
  );
  assert.equal(r.blockers.find((b) => b.code === "model_off_bed"), undefined);
});

test("every axis is checked, in both directions", () => {
  const cases: [string, ReturnType<typeof box>][] = [
    ["past the right edge", box([200, 20, 0], [300, 120, 50])],
    ["past the back edge", box([20, 200, 0], [120, 300, 50])],
    ["taller than the machine", box([20, 20, 0], [120, 120, 400])],
    ["left of the origin", box([-60, 20, 0], [40, 120, 50])],
    ["in front of the origin", box([20, -60, 0], [120, 40, 50])],
    ["below the plate", box([20, 20, -30], [120, 120, 20])]
  ];
  for (const [name, placement] of cases) {
    const r = evaluateCompatibility(
      task({ dimensions: { x: 100, y: 100, z: 50 }, placement }),
      printer({ buildVolume: A1_BED }),
      evidence({})
    );
    assert.ok(r.blockers.some((b) => b.code === "model_off_bed"), name);
  }
});

test("a part flush with the edge is not blocked by the extrusion outline", () => {
  // The analysed box is the extrusion outline, half a line width proud of the
  // model. A part deliberately placed against the edge must not be refused.
  const r = evaluateCompatibility(
    task({ dimensions: { x: 256, y: 256, z: 10 }, placement: box([-0.4, -0.4, 0], [256.4, 256.4, 10]) }),
    printer({ buildVolume: A1_BED }),
    evidence({})
  );
  assert.equal(r.blockers.find((b) => b.code === "model_off_bed"), undefined);
});

test("no placement and no build volume are each an honest silence, not a refusal", () => {
  const noPlacement = evaluateCompatibility(
    task({ dimensions: { x: 100, y: 100, z: 50 }, placement: null }),
    printer({ buildVolume: A1_BED }),
    evidence({})
  );
  assert.equal(noPlacement.blockers.find((b) => b.code === "model_off_bed"), undefined);

  const noBed = evaluateCompatibility(
    task({ dimensions: null, placement: box([900, 900, 0], [999, 999, 9]) }),
    printer({ buildVolume: null }),
    evidence({})
  );
  assert.equal(
    noBed.blockers.find((b) => b.code === "model_off_bed"),
    undefined,
    "an unknown bed cannot judge a placement — other rules refuse the unknown"
  );
});
