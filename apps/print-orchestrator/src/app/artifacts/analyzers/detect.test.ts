import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";

import {
  makeAsciiStl,
  makeBinaryStl,
  makeGcode,
  makeGeneric3mf,
  tempDir,
  unitCubeTriangles,
  writeFixture
} from "../testkit/fixtures";
import { detectFormat } from "./detect";

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function detect(name: string, data: Buffer | string) {
  const { path, size } = writeFixture(dir, name, data);
  const handle = await fsp.open(path, "r");
  try {
    return await detectFormat(handle, size, name);
  } finally {
    await handle.close();
  }
}

test("detects a binary STL by the exact size identity, not the extension", async () => {
  const d = await detect("cube.bin", makeBinaryStl(unitCubeTriangles()));
  assert.equal(d.format, "stl");
  assert.equal(d.stlVariant, "binary");
});

test("detects an ASCII STL by its solid/facet/vertex markers", async () => {
  const d = await detect("cube.stl", makeAsciiStl(unitCubeTriangles()));
  assert.equal(d.format, "stl");
  assert.equal(d.stlVariant, "ascii");
  assert.equal(d.extMismatch, false);
});

test("detects G-code from a slicer banner + command lines", async () => {
  const d = await detect("part.gcode", makeGcode());
  assert.equal(d.format, "gcode");
  assert.equal(d.extMismatch, false);
});

test("detects 3MF (ZIP) by magic bytes", async () => {
  const d = await detect("part.3mf", makeGeneric3mf());
  assert.equal(d.format, "3mf");
});

test("flags an extension/content mismatch (gcode bytes named .stl)", async () => {
  const d = await detect("trap.stl", makeGcode());
  assert.equal(d.format, "gcode");
  assert.equal(d.declaredExt, "stl");
  assert.equal(d.extMismatch, true);
});

test("unrecognized content is unknown", async () => {
  const d = await detect("mystery.dat", Buffer.from("\x01\x02\x03 not any known format"));
  assert.equal(d.format, "unknown");
});
