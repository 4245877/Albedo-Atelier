import assert from "node:assert/strict";
import { test } from "node:test";

import { isKnownUnit, mmPerUnit, resolveUnits, UNIT_TO_MM } from "./units";

test("every 3MF core unit converts to the right number of millimetres", () => {
  assert.deepEqual(UNIT_TO_MM, {
    micron: 0.001,
    millimeter: 1,
    centimeter: 10,
    meter: 1000,
    inch: 25.4,
    foot: 304.8
  });
});

test("spec tokens, abbreviations and -re/-er spellings all resolve", () => {
  const cases: [string, string, number][] = [
    ["millimeter", "millimeter", 1],
    ["millimetre", "millimeter", 1],
    ["MM", "millimeter", 1],
    ["centimeter", "centimeter", 10],
    ["cm", "centimeter", 10],
    ["micron", "micron", 0.001],
    ["micrometre", "micron", 0.001],
    ["µm", "micron", 0.001],
    ["meter", "meter", 1000],
    ["metre", "meter", 1000],
    ["inch", "inch", 25.4],
    ["Inches", "inch", 25.4],
    ["foot", "foot", 304.8],
    ["feet", "foot", 304.8],
    ["  Foot  ", "foot", 304.8]
  ];
  for (const [token, expected, factor] of cases) {
    const r = resolveUnits(token);
    assert.equal(r.units, expected, token);
    assert.equal(r.mmPerUnit, factor, token);
    assert.equal(r.unrecognized, false, token);
    assert.equal(r.declared, token.trim(), token);
  }
});

test("an unmappable unit is unknown, keeps its token, and has no factor", () => {
  const r = resolveUnits("parsec");
  assert.equal(r.units, "unknown");
  assert.equal(r.mmPerUnit, null);
  assert.equal(r.declared, "parsec");
  assert.equal(r.unrecognized, true);
});

test("a missing unit declares nothing and is not an unrecognized unit", () => {
  for (const value of [undefined, null, "", "   ", 42, {}]) {
    const r = resolveUnits(value);
    assert.equal(r.units, "unknown");
    assert.equal(r.mmPerUnit, null);
    assert.equal(r.declared, null);
    assert.equal(r.unrecognized, false);
  }
});

test("`unknown` has no conversion factor — the whole point of the type", () => {
  assert.equal(mmPerUnit("unknown"), null);
  assert.equal(mmPerUnit("inch"), 25.4);
  assert.equal(isKnownUnit("unknown"), false);
  assert.equal(isKnownUnit("inch"), true);
  assert.equal(isKnownUnit("parsec"), false);
});
