import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";

import { makeAsciiStl, makeBinaryStl, tempDir, unitCubeTriangles, writeFixture } from "../testkit/fixtures";
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
