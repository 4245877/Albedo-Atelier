import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";

import {
  boxVertices,
  make3mfModel,
  make3mfPackage,
  makeModelSettingsConfig,
  tempDir,
  writeFixture,
  type Vertex
} from "../testkit/fixtures";
import { analyze3mf } from "./threemf";
import type { AnalyzerLimits, AnalyzerResult } from "./types";

/*
 * PrusaSlicer's multi-bed projects, and the line this analyzer refuses to cross.
 *
 * Prusa records no plates at all: a second bed is just objects moved along X by
 * the bed pitch. So the file is *suspected* and reported, and left whole —
 * inventing plate boundaries from coordinates would hand the slicer half a
 * model and call it a print. These tests pin both halves: that the suspicion is
 * raised where it should be, and that it changes nothing else.
 */

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

async function run(name: string, data: Buffer): Promise<AnalyzerResult> {
  const { path, size } = writeFixture(dir, name, data);
  const handle = await fsp.open(path, "r");
  try {
    return await analyze3mf(handle, size, LIMITS);
  } finally {
    await handle.close();
  }
}

/** A scene of equal cubes at the given X origins — one "bed" per cluster. */
function scene(origins: number[][], options: { application?: string; extra?: { name: string; data: string }[] } = {}) {
  const xml = make3mfModel({
    unit: "millimeter",
    application: options.application ?? "PrusaSlicer-2.8.0",
    objects: origins.map((o, i) => ({
      id: String(i + 1),
      vertices: boxVertices(80, 80, 40, o as Vertex)
    })),
    items: origins.map((_, i) => ({ objectid: String(i + 1) }))
  });
  return make3mfPackage(xml, [
    { name: "Metadata/Slic3r_PE.config", data: "; layer_height = 0.2\n" },
    ...(options.extra ?? [])
  ]);
}

test("objects spread across two bed-sized regions are flagged for review", async () => {
  const r = await run("two-beds.3mf", scene([[0, 0, 0], [80, 0, 0], [700, 0, 0], [790, 0, 0]]));
  const finding = r.warnings.find((w) => w.code === "prusa_multi_bed_suspected");
  assert.ok(finding, "the operator is told the file looks like several beds");
  assert.match(finding.message, /2 группами/);
  assert.match(finding.hint ?? "", /разделить его автоматически нельзя/);
});

test("the suspicion never splits the file — one plate, one merged box", async () => {
  const r = await run("two-beds.3mf", scene([[0, 0, 0], [700, 0, 0]]));
  const g = r.data.geometry as { plateCount: number; multiPlate: boolean; sizeMm: number[] | null };
  assert.equal(g.plateCount, 1, "no plate is invented from coordinates");
  assert.equal(g.multiPlate, false);
  assert.deepEqual(g.sizeMm, [780, 80, 40], "the box is still the whole scene's, unchanged");
  assert.equal(r.verdict, "needs_preparation", "a suspicion is not a refusal");
});

test("one wide part is not two beds", async () => {
  // A 700 mm beam printed in one piece spans just as far as two beds do. The
  // difference is the empty corridor between groups, and there is none here.
  const xml = make3mfModel({
    unit: "millimeter",
    application: "PrusaSlicer-2.8.0",
    objects: [{ id: "1", vertices: boxVertices(700, 60, 40) }],
    items: [{ objectid: "1" }]
  });
  const r = await run("beam.3mf", make3mfPackage(xml));
  assert.ok(!r.warnings.some((w) => w.code === "prusa_multi_bed_suspected"));
});

test("an ordinary crowded bed is not suspected", async () => {
  const r = await run("crowd.3mf", scene([[0, 0, 0], [90, 0, 0], [180, 0, 0]]));
  assert.ok(!r.warnings.some((w) => w.code === "prusa_multi_bed_suspected"));
});

test("a project that DECLARES its plates is never guessed at", async () => {
  // Orca/Bambu say what their plates are; coordinates are not evidence there,
  // and a second, weaker signal disagreeing with the file would only confuse.
  const r = await run(
    "orca.3mf",
    (() => {
      const xml = make3mfModel({
        unit: "millimeter",
        application: "OrcaSlicer-2.3.0",
        objects: [
          { id: "1", vertices: boxVertices(80, 80, 40) },
          { id: "2", vertices: boxVertices(80, 80, 40, [700, 0, 0]) }
        ],
        items: [{ objectid: "1" }, { objectid: "2" }]
      });
      return make3mfPackage(xml, [
        {
          name: "Metadata/model_settings.config",
          data: makeModelSettingsConfig([
            { index: 1, objectIds: ["1"] },
            { index: 2, objectIds: ["2"] }
          ])
        }
      ]);
    })()
  );
  assert.ok(!r.warnings.some((w) => w.code === "prusa_multi_bed_suspected"));
  assert.equal((r.data.geometry as { plateCount: number }).plateCount, 2);
});

test("without a proven unit the span is just a number, and nothing is claimed", async () => {
  const xml = make3mfModel({
    unit: "furlong",
    application: "PrusaSlicer-2.8.0",
    objects: [
      { id: "1", vertices: boxVertices(80, 80, 40) },
      { id: "2", vertices: boxVertices(80, 80, 40, [700, 0, 0]) }
    ],
    items: [{ objectid: "1" }, { objectid: "2" }]
  });
  const r = await run("unitless.3mf", make3mfPackage(xml));
  assert.ok(!r.warnings.some((w) => w.code === "prusa_multi_bed_suspected"));
});
