import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";

import { makeAsciiStl, makeBinaryStl, tempDir, unitCubeTriangles, writeFixture } from "../testkit/fixtures";
import type { NormalizedGeometry } from "./geometry";
import { analyzeStl } from "./stl";

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function runStl(name: string, data: Buffer | string, variant: "binary" | "ascii") {
  const { path, size } = writeFixture(dir, name, data);
  const handle = await fsp.open(path, "r");
  try {
    return await analyzeStl(handle, path, size, variant);
  } finally {
    await handle.close();
  }
}

/** The normalized geometry payload every model analyzer now emits. */
function geometryOf(r: { data: Record<string, unknown> }): NormalizedGeometry {
  return r.data.geometry as NormalizedGeometry;
}

test("binary STL: variant, triangle count and bounding box", async () => {
  const r = await runStl("cube.stl", makeBinaryStl(unitCubeTriangles(20)), "binary");
  assert.equal(r.detectedFormat, "stl");
  assert.equal(r.verdict, "needs_preparation");
  assert.equal(r.data.stlVariant, "binary");
  assert.equal(r.data.triangles, 2);
  assert.equal(r.data.units, "unknown");
  const bbox = r.data.bbox as { size: number[] };
  assert.deepEqual(bbox.size, [20, 20, 20]);
});

test("ASCII STL is parsed line by line to the same result", async () => {
  const r = await runStl("cube.stl", makeAsciiStl(unitCubeTriangles(15)), "ascii");
  assert.equal(r.data.stlVariant, "ascii");
  assert.equal(r.data.triangles, 2);
  const bbox = r.data.bbox as { size: number[] };
  assert.deepEqual(bbox.size, [15, 15, 15]);
  assert.equal(r.verdict, "needs_preparation");
});

test("STL declares no unit: raw numbers survive, millimetres do NOT", async () => {
  const r = await runStl("cube.stl", makeBinaryStl(unitCubeTriangles(20)), "binary");
  const g = geometryOf(r);
  assert.equal(g.sourceUnits, "unknown");
  assert.equal(g.declaredUnits, null);
  assert.equal(g.mmPerUnit, null);
  assert.equal(g.scaleKnown, false);
  // The file's own numbers are published…
  assert.deepEqual(g.sizeRaw, [20, 20, 20]);
  assert.deepEqual(g.minRaw, [0, 0, 0]);
  assert.deepEqual(g.maxRaw, [20, 20, 20]);
  // …but nothing may read them as a millimetre measurement.
  assert.equal(g.sizeMm, null);
  assert.equal(g.minMm, null);
  assert.equal(g.maxMm, null);
  assert.ok(r.warnings.some((w) => w.code === "stl_units_unknown"));
  assert.equal(g.objectCount, 1);
  assert.equal(g.plateCount, 1);
});

test("ASCII STL reports the same unknown scale as binary", async () => {
  const r = await runStl("cube.stl", makeAsciiStl(unitCubeTriangles(15)), "ascii");
  const g = geometryOf(r);
  assert.equal(g.scaleKnown, false);
  assert.equal(g.sizeMm, null);
  assert.deepEqual(g.sizeRaw, [15, 15, 15]);
});

test("a flat model (zero extent on an axis) is blocked as degenerate", async () => {
  // All three vertices in the z=0 plane → no printable height.
  const r = await runStl(
    "flat.stl",
    makeBinaryStl([{ vertices: [[0, 0, 0], [10, 0, 0], [10, 10, 0]] }]),
    "binary"
  );
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "stl_degenerate"));
});

test("absurd coordinates are blocked, not folded into the box", async () => {
  const r = await runStl(
    "huge.stl",
    makeBinaryStl([{ vertices: [[0, 0, 0], [1e12, 0, 0], [10, 10, 10]] }]),
    "binary"
  );
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "stl_out_of_range"));
  // The rejected point did not enlarge the reported box.
  assert.deepEqual(geometryOf(r).sizeRaw, [10, 10, 10]);
});

test("a garbled ASCII vertex line is non-finite, not a quietly smaller box", async () => {
  const ascii = ["solid x", "  facet normal 0 0 0", "    outer loop", "      vertex 0 0 0", "      vertex 10 10", "      vertex 5 5 5", "    endloop", "  endfacet", "endsolid x", ""].join("\n");
  const r = await runStl("garbled.stl", ascii, "ascii");
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "stl_non_finite"));
});

test("a truncated binary STL is blocked", async () => {
  // Header declares 100 triangles but the body holds only 2.
  const good = makeBinaryStl(unitCubeTriangles());
  good.writeUInt32LE(100, 80);
  const r = await runStl("bad.stl", good, "binary");
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "stl_truncated"));
});

test("an empty model is blocked", async () => {
  const r = await runStl("empty.stl", makeBinaryStl([]), "binary");
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "stl_empty"));
});

test("non-finite coordinates are blocked", async () => {
  const r = await runStl(
    "inf.stl",
    makeBinaryStl([{ vertices: [[0, 0, 0], [Infinity, 0, 0], [1, 1, 1]] }]),
    "binary"
  );
  assert.equal(r.verdict, "blocked");
  assert.ok(r.blockers.some((b) => b.code === "stl_non_finite"));
});

test("a suspiciously tiny model warns about unknown units", async () => {
  const r = await runStl("tiny.stl", makeBinaryStl(unitCubeTriangles(0.1)), "binary");
  assert.equal(r.verdict, "needs_preparation");
  assert.ok(r.warnings.some((w) => w.code === "stl_suspicious_scale"));
});
