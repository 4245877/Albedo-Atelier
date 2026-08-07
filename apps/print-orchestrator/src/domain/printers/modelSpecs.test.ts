import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveBambuModelCode, listModelSpecs, lookupModelSpec } from "./modelSpecs";

/*
 * The catalogue's job is to fill the one gap the Bambu protocol leaves — the
 * build volume — without ever guessing. These tests exist mainly to pin the
 * *refusals*: an unknown printer must come back unknown, because a nearest-match
 * bed size would silently become a scheduling constraint.
 */

test("a known Bambu serial prefix identifies the model", () => {
  assert.equal(deriveBambuModelCode("0309CA470100001"), "bambu-a1-mini");
  assert.equal(deriveBambuModelCode("039BA490200123"), "bambu-a1");
  assert.equal(deriveBambuModelCode("00M09C441700456"), "bambu-x1c");
});

test("serial matching ignores case and surrounding whitespace", () => {
  assert.equal(deriveBambuModelCode("  039ba490200123  "), "bambu-a1");
});

test("an unrecognised serial yields null, never the nearest-looking model", () => {
  assert.equal(deriveBambuModelCode("ZZZ123456"), null);
  assert.equal(deriveBambuModelCode("03"), null, "too short to carry a prefix");
  assert.equal(deriveBambuModelCode(""), null);
  assert.equal(deriveBambuModelCode(null), null);
  assert.equal(deriveBambuModelCode(undefined), null);
});

test("an unknown catalogue code resolves to null", () => {
  assert.equal(lookupModelSpec("bambu-x9-imaginary"), null);
  assert.equal(lookupModelSpec(""), null);
  assert.equal(lookupModelSpec(null), null);
});

test("the A1 family is the AMS Lite one; the P1/X1 family is not", () => {
  assert.equal(lookupModelSpec("bambu-a1")?.amsKind, "AMS Lite");
  assert.equal(lookupModelSpec("bambu-a1-mini")?.amsKind, "AMS Lite");
  assert.equal(lookupModelSpec("bambu-p1s")?.amsKind, "AMS");
  assert.equal(lookupModelSpec("bambu-x1c")?.amsKind, "AMS");
});

test("the A1 mini's smaller bed is not confused with the full-size A1", () => {
  assert.deepEqual(lookupModelSpec("bambu-a1")?.buildVolume, { x: 256, y: 256, z: 256 });
  assert.deepEqual(lookupModelSpec("bambu-a1-mini")?.buildVolume, { x: 180, y: 180, z: 180 });
});

test("every catalogue entry is internally consistent", () => {
  for (const spec of listModelSpecs()) {
    assert.equal(spec.code, spec.code.toLowerCase(), `${spec.code}: code must be lowercase`);
    assert.equal(lookupModelSpec(spec.code), spec, `${spec.code}: must be findable by its code`);
    assert.ok(spec.name.trim(), `${spec.code}: needs an operator-facing name`);
    if (spec.buildVolume) {
      const { x, y, z } = spec.buildVolume;
      assert.ok(x > 0 && y > 0 && z > 0, `${spec.code}: build volume must be positive`);
    }
  }
});

test("catalogue codes are unique", () => {
  const codes = listModelSpecs().map((spec) => spec.code);
  assert.equal(new Set(codes).size, codes.length);
});

test("every Bambu serial prefix maps onto a real catalogue entry", () => {
  // A prefix pointing at a code that no longer exists would silently stop
  // identifying that printer, so the two tables are checked against each other.
  for (const serial of ["00M0", "00W0", "01S0", "01P0", "0300", "0390"]) {
    const code = deriveBambuModelCode(serial);
    assert.ok(code, `${serial}: expected a catalogue code`);
    assert.ok(lookupModelSpec(code), `${serial}: «${code}» is not in the catalogue`);
  }
});
