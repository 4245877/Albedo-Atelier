import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";

import {
  boxVertices,
  make3mfModel,
  make3mfModelXml,
  make3mfPackage,
  makeGeneric3mf,
  makeModelSettingsConfig,
  makeSliced3mf,
  makeZip,
  tempDir,
  writeFixture
} from "../testkit/fixtures";
import type { NormalizedGeometry } from "./geometry";
import { analyze3mf } from "./threemf";
import type { AnalyzerLimits } from "./types";

const LIMITS: AnalyzerLimits = {
  zipMaxEntries: 1000,
  zipMaxEntryBytes: 64 * 1024 * 1024,
  zipMaxTotalBytes: 128 * 1024 * 1024,
  zipMaxRatio: 200,
  xmlMaxBytes: 16 * 1024 * 1024
};

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(name: string, data: Buffer, limits: AnalyzerLimits = LIMITS) {
  const { path, size } = writeFixture(dir, name, data);
  const handle = await fsp.open(path, "r");
  try {
    return await analyze3mf(handle, size, limits);
  } finally {
    await handle.close();
  }
}

test("a generic 3MF model → needs_preparation (still needs slicing)", async () => {
  const r = await run("part.3mf", makeGeneric3mf(make3mfModelXml({ unit: "millimeter", size: 30 })));
  assert.equal(r.detectedFormat, "3mf");
  assert.equal(r.verdict, "needs_preparation");
  assert.equal(r.data.threeMfClass, "generic");
  assert.equal(r.data.units, "millimeter");
  assert.equal(r.data.buildItemCount, 1);
  assert.equal(r.data.objectCount, 1);
  const bbox = r.data.bbox as { size: number[] };
  assert.deepEqual(bbox.size, [30, 30, 30]);
});

test("a sliced / G-code 3MF → review with detected material", async () => {
  const r = await run("proj.3mf", makeSliced3mf());
  assert.equal(r.data.threeMfClass, "sliced");
  assert.equal(r.data.hasGcodePayload, true);
  assert.equal(r.material, "PLA");
  assert.equal(r.verdict, "review");
});

test("path traversal inside the 3MF is blocked", async () => {
  const buf = makeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "3D/3dmodel.model", data: make3mfModelXml() },
    { name: "../escape.txt", data: "x" }
  ]);
  const r = await run("evil.3mf", buf);
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "zip_traversal"));
});

test("forbidden XML entities in the model are blocked", async () => {
  const evilModel = '<?xml version="1.0"?><!DOCTYPE m [<!ENTITY x "y">]><model unit="millimeter"></model>';
  const buf = makeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "3D/3dmodel.model", data: evilModel }
  ]);
  const r = await run("xxe.3mf", buf);
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "xml_doctype"));
});

test("an excessive uncompressed size is blocked before parsing", async () => {
  // Tight per-entry cap trips the SafeZip guard on the model entry.
  const r = await run("big.3mf", makeGeneric3mf(), { ...LIMITS, zipMaxEntryBytes: 10 });
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "zip_entry_too_large"));
});

test("a ZIP without a 3MF model → review (unknown/unsupported)", async () => {
  const buf = makeZip([{ name: "readme.txt", data: "not a 3mf" }]);
  const r = await run("plain.3mf", buf);
  assert.equal(r.verdict, "review");
  assert.equal(r.data.threeMfClass, "unknown");
});

test("a malformed model XML is blocked", async () => {
  const buf = makeZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "3D/3dmodel.model", data: "<model><build></model>" }
  ]);
  const r = await run("bad.3mf", buf);
  assert.equal(r.verdict, "blocked");
});

// ── Units ────────────────────────────────────────────────────────────────────

function geometryOf(r: { data: Record<string, unknown> }): NormalizedGeometry {
  return r.data.geometry as NormalizedGeometry;
}

/** A 10-unit cube placed once, in the given declared unit. */
async function cubeIn(unit: string | null, size = 10) {
  const xml = make3mfModel({
    unit,
    objects: [{ id: "1", vertices: boxVertices(size) }],
    items: [{ objectid: "1" }]
  });
  return run("units.3mf", make3mfPackage(xml));
}

/** Every unit the 3MF core spec defines, and what 10 of it is in millimetres. */
const UNIT_CASES: [string, number][] = [
  ["millimeter", 10],
  ["centimeter", 100],
  ["micron", 0.01],
  ["inch", 254],
  ["meter", 10_000],
  ["foot", 3048]
];

for (const [unit, expectedMm] of UNIT_CASES) {
  test(`3MF in ${unit} is converted to millimetres`, async () => {
    const r = await cubeIn(unit);
    const g = geometryOf(r);
    assert.equal(g.sourceUnits, unit);
    assert.equal(g.scaleKnown, true);
    assert.deepEqual(g.sizeMm, [expectedMm, expectedMm, expectedMm]);
    // The file's own numbers are preserved alongside the converted ones.
    assert.deepEqual(g.sizeRaw, [10, 10, 10]);
    assert.deepEqual(g.maxMm, [expectedMm, expectedMm, expectedMm]);
  });
}

test("an absent unit attribute takes the spec default (millimetre)", async () => {
  const g = geometryOf(await cubeIn(null));
  assert.equal(g.sourceUnits, "millimeter");
  assert.equal(g.declaredUnits, null);
  assert.equal(g.scaleKnown, true);
  assert.deepEqual(g.sizeMm, [10, 10, 10]);
});

test("a unit we cannot convert stays unknown — never assumed millimetres", async () => {
  const r = await cubeIn("parsec");
  const g = geometryOf(r);
  assert.equal(g.sourceUnits, "unknown");
  assert.equal(g.declaredUnits, "parsec");
  assert.equal(g.mmPerUnit, null);
  assert.equal(g.scaleKnown, false);
  assert.equal(g.sizeMm, null);
  assert.deepEqual(g.sizeRaw, [10, 10, 10]);
  assert.ok(r.warnings.some((w) => w.code === "threemf_units_unrecognized"));
});

// ── Transforms ───────────────────────────────────────────────────────────────

test("a build-item transform scales and translates the bounding box", async () => {
  // Scale ×2 on X, ×3 on Y, ×1 on Z, then translate by (100, 0, 5).
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }],
    items: [{ objectid: "1", transform: "2 0 0 0 3 0 0 0 1 100 0 5" }]
  });
  const g = geometryOf(await run("tf.3mf", make3mfPackage(xml)));
  assert.deepEqual(g.sizeMm, [20, 30, 10]);
  assert.deepEqual(g.minMm, [100, 0, 5]);
  assert.deepEqual(g.maxMm, [120, 30, 15]);
});

test("a nested component transform composes with its parent's", async () => {
  // Object 2 is a 10-cube; object 1 places it at +50 on X; the build item then
  // scales the whole assembly ×2 → the cube ends up at 100..120.
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [
      { id: "1", components: [{ objectid: "2", transform: "1 0 0 0 1 0 0 0 1 50 0 0" }] },
      { id: "2", vertices: boxVertices(10) }
    ],
    items: [{ objectid: "1", transform: "2 0 0 0 2 0 0 0 2 0 0 0" }]
  });
  const g = geometryOf(await run("nested.3mf", make3mfPackage(xml)));
  assert.deepEqual(g.minMm, [100, 0, 0]);
  assert.deepEqual(g.sizeMm, [20, 20, 20]);
});

test("a unit conversion applies on top of the transforms", async () => {
  const xml = make3mfModel({
    unit: "inch",
    objects: [{ id: "1", vertices: boxVertices(1) }],
    items: [{ objectid: "1", transform: "2 0 0 0 2 0 0 0 2 0 0 0" }]
  });
  const g = geometryOf(await run("inch-tf.3mf", make3mfPackage(xml)));
  assert.deepEqual(g.sizeRaw, [2, 2, 2]);
  assert.deepEqual(g.sizeMm, [50.8, 50.8, 50.8]);
});

test("an unparseable transform is reported, not silently ignored", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }],
    items: [{ objectid: "1", transform: "1 0 0 nonsense" }]
  });
  const r = await run("badtf.3mf", make3mfPackage(xml));
  assert.ok(r.warnings.some((w) => w.code === "threemf_bad_transform"));
  // Placed without the transform → the untransformed box, and the operator is told.
  assert.deepEqual(geometryOf(r).sizeMm, [10, 10, 10]);
});

test("a singular transform collapses the object and is blocked as degenerate", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }],
    items: [{ objectid: "1", transform: "1 0 0 0 1 0 0 0 0 0 0 0" }] // z scale = 0
  });
  const r = await run("singular.3mf", make3mfPackage(xml));
  assert.equal(r.verdict, "blocked");
  assert.ok(r.warnings.some((w) => w.code === "threemf_degenerate_transform"));
  assert.ok(r.blockers.some((b) => b.code === "threemf_degenerate"));
});

// ── Multiple objects and plates ──────────────────────────────────────────────

test("several build items on one plate are merged into one scene box", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }, { id: "2", vertices: boxVertices(10) }],
    items: [
      { objectid: "1" },
      { objectid: "2", transform: "1 0 0 0 1 0 0 0 1 40 0 0" }
    ]
  });
  const r = await run("two.3mf", make3mfPackage(xml));
  const g = geometryOf(r);
  assert.equal(r.data.objectCount, 2);
  assert.equal(r.data.buildItemCount, 2);
  assert.equal(g.objectCount, 2);
  assert.equal(g.plateCount, 1);
  assert.equal(g.multiPlate, false);
  assert.deepEqual(g.sizeMm, [50, 10, 10]);
});

test("a multi-plate project withholds the merged box and scopes each plate", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }, { id: "2", vertices: boxVertices(30) }],
    items: [{ objectid: "1" }, { objectid: "2", transform: "1 0 0 0 1 0 0 0 1 500 0 0" }]
  });
  const r = await run(
    "plates.3mf",
    make3mfPackage(xml, [
      {
        name: "Metadata/model_settings.config",
        data: makeModelSettingsConfig([
          { index: 1, objectIds: ["1"] },
          { index: 2, objectIds: ["2"] }
        ])
      }
    ])
  );
  const g = geometryOf(r);
  assert.equal(g.plateCount, 2);
  assert.equal(g.multiPlate, true);
  // The union of two plates is not the size of any single print.
  assert.equal(g.sizeMm, null);
  assert.equal(g.minMm, null);
  // …but it is still reported, explicitly labelled as spanning the plates.
  assert.deepEqual(g.sceneSizeMm, [530, 30, 30]);
  assert.ok(r.warnings.some((w) => w.code === "threemf_multi_plate"));

  const byIndex = new Map(g.plates.map((p) => [p.index, p]));
  assert.deepEqual(byIndex.get(1)?.sizeMm, [10, 10, 10]);
  assert.deepEqual(byIndex.get(2)?.sizeMm, [30, 30, 30]);
  assert.equal(byIndex.get(2)?.objectCount, 1);
});

test("plates found only as plate_N entries still suppress the merged box", async () => {
  // No model_settings.config → the plates cannot be attributed, so nothing is
  // scoped, but the merged box is still refused rather than passed off as one print.
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }],
    items: [{ objectid: "1" }]
  });
  const r = await run(
    "entries.3mf",
    make3mfPackage(xml, [
      { name: "Metadata/plate_1.png", data: "a" },
      { name: "Metadata/plate_2.png", data: "b" }
    ])
  );
  const g = geometryOf(r);
  assert.equal(g.plateCount, 2);
  assert.equal(g.multiPlate, true);
  assert.equal(g.sizeMm, null);
  assert.deepEqual(g.plates, []);
});

// ── Corrupt geometry ─────────────────────────────────────────────────────────

test("non-finite vertex coordinates are blocked", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: [[0, 0, 0], ["NaN", 0, 0], [10, 10, 10]] }],
    items: [{ objectid: "1" }]
  });
  const r = await run("nan.3mf", make3mfPackage(xml));
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "threemf_non_finite"));
});

test("absurd coordinates are blocked instead of inflating the box", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: [[0, 0, 0], [1e12, 0, 0], [10, 10, 10]] }],
    items: [{ objectid: "1" }]
  });
  const r = await run("huge.3mf", make3mfPackage(xml));
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "threemf_out_of_range"));
  assert.deepEqual(geometryOf(r).sizeMm, [10, 10, 10]);
});

test("a metre-unit model beyond any printable size is blocked, not merely odd", async () => {
  const r = await cubeIn("meter", 500); // 500 m
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "threemf_out_of_range"));
});

test("a build item pointing at a missing object is reported", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }],
    items: [{ objectid: "1" }, { objectid: "404" }]
  });
  const r = await run("missing.3mf", make3mfPackage(xml));
  assert.ok(r.warnings.some((w) => w.code === "threemf_missing_object"));
  assert.equal(geometryOf(r).objectCount, 1);
});

test("a component cycle is cut instead of recursing", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [
      { id: "1", vertices: boxVertices(10), components: [{ objectid: "2" }] },
      { id: "2", components: [{ objectid: "1" }] }
    ],
    items: [{ objectid: "1" }]
  });
  const r = await run("cycle.3mf", make3mfPackage(xml));
  assert.ok(r.warnings.some((w) => w.code === "threemf_component_cycle"));
  assert.deepEqual(geometryOf(r).sizeMm, [10, 10, 10]);
});

test("resources with an empty <build> print nothing and report no size", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }],
    items: []
  });
  const r = await run("nobuild.3mf", make3mfPackage(xml));
  const g = geometryOf(r);
  assert.ok(r.warnings.some((w) => w.code === "threemf_no_build_items"));
  assert.equal(g.sizeMm, null);
  assert.equal(g.sizeRaw, null);
  assert.equal(g.plateCount, 0);
});
