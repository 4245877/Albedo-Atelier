import assert from "node:assert/strict";
import { test } from "node:test";

import { makeModelScaleConfirmation, readModelScale, resolveSliceScale, MODEL_SCALE_KEY } from "./modelScale";
import type { Artifact } from "./types";

/*
 * HIGH-04: the dashboard's unit picker sent `mm`/`cm`/`m`; the server accepted
 * only `millimeter`/`centimeter`/`meter`, so an STL could only ever be confirmed
 * in inches. Every spelling an operator (or an old client) sends resolves
 * through ONE table and is stored canonical.
 */

const artifact = (over: Partial<Artifact> = {}): Artifact => ({
  id: "art_1",
  kind: "model",
  name: "cube.stl",
  source: "blob",
  sizeBytes: 684,
  sha256: "a".repeat(64),
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  version: 1,
  legacyRef: null,
  metadata: {},
  ...over
});

const confirm = (units: unknown) =>
  makeModelScaleConfirmation({
    units,
    artifact: artifact(),
    confirmedBy: "miha",
    confirmedAt: "2026-10-01T00:00:00.000Z"
  });

test("the picker's short names and the canonical names are both accepted, stored canonical", () => {
  for (const [given, canonical] of [
    ["mm", "millimeter"],
    ["cm", "centimeter"],
    ["m", "meter"],
    ["inch", "inch"],
    ["millimeter", "millimeter"],
    ["Centimetre", "centimeter"]
  ] as const) {
    assert.equal(confirm(given)?.units, canonical, `«${given}»`);
  }
});

test("anything that is not a unit is refused rather than guessed", () => {
  assert.equal(confirm("furlong"), null);
  assert.equal(confirm(""), null);
  assert.equal(confirm(undefined), null);
});

test("a confirmed unit turns into the factor the slicer is given", () => {
  const confirmation = confirm("cm")!;
  const scale = readModelScale(artifact({ metadata: { [MODEL_SCALE_KEY]: { ...confirmation } } }));
  assert.equal(scale?.mmPerUnit, 10);
  assert.deepEqual(resolveSliceScale(false, scale), { factor: 10, reason: "confirmed_by_operator" });
});
