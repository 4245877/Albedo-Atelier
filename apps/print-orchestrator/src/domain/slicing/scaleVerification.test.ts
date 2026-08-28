import assert from "node:assert/strict";
import { test } from "node:test";

import { readModelScale, resolveSliceScale } from "../print/modelScale";
import type { Artifact } from "../print/types";
import { verifySlicedScale } from "./scaleVerification";

/*
 * One scale, two layers.
 *
 * The scheduler sized an STL as `sizeRaw × mmPerUnit` — honouring the operator's
 * "these numbers are inches" — while the slicer got the file untouched. A 2-inch
 * cube was checked as 50.8 mm and printed as 2 mm, and nothing compared them.
 */

const SHA = "a".repeat(64);

function artifact(scale: Record<string, unknown> | null): Artifact {
  return {
    id: "art",
    kind: "model",
    name: "cube.stl",
    source: "blobs/cube.stl",
    sizeBytes: 1024,
    sha256: SHA,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    version: 1,
    legacyRef: null,
    metadata: scale ? { modelScale: scale } : {}
  } as Artifact;
}

const confirmed = (units: string, scaleFactor = 1, sha: string | null = SHA) => ({
  units,
  scaleFactor,
  sha256: sha,
  sizeBytes: 1024,
  confirmedBy: "miha",
  confirmedAt: "2026-08-28T10:00:00.000Z"
});

test("an operator's inch confirmation reaches the slicer, not just the size check", () => {
  const scale = resolveSliceScale(false, readModelScale(artifact(confirmed("inch"))));
  assert.equal(scale.factor, 25.4);
  assert.equal(scale.reason, "confirmed_by_operator");
});

test("a file that declares its own unit is never scaled twice", () => {
  // A 3MF with a convertible `unit`: the analyzer produced millimetres AND the
  // slicer reads the same declaration. Applying a factor would double it.
  const scale = resolveSliceScale(true, readModelScale(artifact(confirmed("inch"))));
  assert.equal(scale.factor, 1);
  assert.equal(scale.reason, "declared_by_file");
});

test("nothing confirmed is an honest unknown — both layers hold the same raw numbers", () => {
  const scale = resolveSliceScale(false, readModelScale(artifact(null)));
  assert.equal(scale.factor, 1, "not a guess above 1 — the size simply stays unproven");
  assert.equal(scale.reason, "unconfirmed");
});

test("a unit nobody can convert is not a confirmation at all", () => {
  // "in"/"cm" are not the vocabulary — only the full names are convertible, and
  // an unrecognised one must leave the size unproven rather than silently mean 1.
  for (const bogus of ["in", "cm", "inches", "", "unknown"]) {
    const scale = resolveSliceScale(false, readModelScale(artifact(confirmed(bogus))));
    assert.equal(scale.factor, 1, bogus);
    assert.equal(scale.reason, "unconfirmed", bogus);
  }
});

test("a confirmation for different bytes does not travel to the slicer", () => {
  // Re-upload under the same artifact and the confirmation is stale: the checks
  // fall back to raw numbers, so the slicer must too.
  const stale = resolveSliceScale(false, readModelScale(artifact(confirmed("inch", 1, "b".repeat(64)))));
  assert.equal(stale.factor, 1);
  assert.equal(stale.reason, "stale_confirmation");
});

test("units and an extra factor compose the way the size check composes them", () => {
  for (const [units, factor, expected] of [
    ["millimeter", 1, 1],
    ["centimeter", 1, 10],
    ["inch", 1, 25.4],
    ["meter", 1, 1000],
    ["micron", 1, 0.001],
    ["foot", 1, 304.8],
    ["millimeter", 2.5, 2.5],
    ["inch", 2, 50.8]
  ] as [string, number, number][]) {
    const scale = resolveSliceScale(false, readModelScale(artifact(confirmed(units, factor))));
    assert.equal(scale.factor, expected, `${units} × ${factor}`);
  }
});

// ── The effect check ────────────────────────────────────────────────────────

test("a slice that came out at the checked size passes", () => {
  const expected = { x: 50.8, y: 50.8, z: 50.8 };
  assert.equal(verifySlicedScale(expected, { x: 51.2, y: 51.0, z: 50.8 }).ok, true);
});

test("a slice that ignored the scale is caught, and the message says by how much", () => {
  // Exactly the failure: expected 2 inches (50.8 mm), got the raw 2 mm.
  const result = verifySlicedScale({ x: 50.8, y: 50.8, z: 50.8 }, { x: 2, y: 2, z: 2 });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /50\.8 мм/);
  assert.match(result.reason ?? "", /2\.0 мм/);
  assert.match(result.reason ?? "", /масштаб модели не был применён/);
});

test("every unit-error magnitude is caught, in both directions", () => {
  const expected = { x: 100, y: 80, z: 60 };
  for (const factor of [25.4, 10, 1000, 1 / 25.4, 0.1, 2, 0.5]) {
    const produced = { x: expected.x * factor, y: expected.y * factor, z: expected.z * factor };
    assert.equal(verifySlicedScale(expected, produced).ok, false, `factor ${factor}`);
  }
});

test("slicer-shaped noise is not a mismatch: line width, brim, rounding", () => {
  const expected = { x: 100, y: 80, z: 60 };
  // A slicer's box is the extrusion outline — half a line width proud on each
  // side, plus rounding. Flagging that would block every correct slice.
  for (const delta of [0, 0.42, -0.42, 1, -1, 2.9]) {
    const produced = { x: expected.x + delta, y: expected.y + delta, z: expected.z + delta };
    assert.equal(verifySlicedScale(expected, produced).ok, true, `delta ${delta}`);
  }
});

test("a small model is judged by the absolute floor, not by a percentage of nothing", () => {
  // 15 % of a 5 mm part is 0.75 mm — narrower than a brim. The floor keeps a
  // legitimately small print from being blocked.
  assert.equal(verifySlicedScale({ x: 5, y: 5, z: 5 }, { x: 7, y: 6, z: 5 }).ok, true);
  // …but a unit error on the same part is still caught.
  assert.equal(verifySlicedScale({ x: 5, y: 5, z: 5 }, { x: 127, y: 127, z: 127 }).ok, false);
});

test("an unknown box on either side is not a verdict", () => {
  const real = { x: 50, y: 50, z: 50 };
  for (const missing of [null, { x: 0, y: 50, z: 50 }, { x: Number.NaN, y: 1, z: 1 }]) {
    assert.equal(verifySlicedScale(missing, real).ok, true, "no expectation, no accusation");
    assert.equal(verifySlicedScale(real, missing).ok, true, "no measurement, no accusation");
  }
});
