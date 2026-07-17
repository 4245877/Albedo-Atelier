import assert from "node:assert/strict";
import { test } from "node:test";

import { applySafetyBuffer, resolveEta } from "./eta";

test("resolveEta prefers a verified slice ETA over a G-code ETA", () => {
  const eta = resolveEta({ sliceEtaS: 3600, gcodeEtaS: 7200 });
  assert.equal(eta.seconds, 3600);
  assert.equal(eta.source, "slice_variant");
  assert.equal(eta.preliminary, true);
});

test("resolveEta falls back to the G-code ETA when there is no slice ETA", () => {
  const eta = resolveEta({ sliceEtaS: null, gcodeEtaS: 5400 });
  assert.equal(eta.seconds, 5400);
  assert.equal(eta.source, "gcode_analysis");
});

test("resolveEta returns unknown (null) — never a fabricated number — with no data", () => {
  const eta = resolveEta({ sliceEtaS: null, gcodeEtaS: null });
  assert.equal(eta.seconds, null);
  assert.equal(eta.source, "unknown");
  assert.equal(eta.preliminary, true);
});

test("resolveEta ignores non-positive inputs", () => {
  assert.equal(resolveEta({ sliceEtaS: 0, gcodeEtaS: -5 }).source, "unknown");
});

test("applySafetyBuffer adds the ratio and a non-positive ratio is a no-op", () => {
  assert.equal(applySafetyBuffer(1000, 0.2), 1200);
  assert.equal(applySafetyBuffer(1000, 0), 1000);
  assert.equal(applySafetyBuffer(1000, -1), 1000);
});

test("applySafetyBuffer treats a non-finite ratio as no buffer (never returns NaN)", () => {
  // Math.max(0, NaN) is NaN, not 0, so a NaN ratio must be screened out explicitly.
  assert.equal(applySafetyBuffer(1000, NaN), 1000);
  assert.equal(applySafetyBuffer(1000, Infinity), 1000);
});
