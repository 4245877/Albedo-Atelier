import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";

import {
  make3mfModelXml,
  makeGeneric3mf,
  makeSliced3mf,
  makeZip,
  tempDir,
  writeFixture
} from "../testkit/fixtures";
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
