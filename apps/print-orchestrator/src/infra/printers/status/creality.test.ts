import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCrealityMaterial, parseCrealityUsedFilamentMm } from "./creality";

/*
 * The Creality WebSocket heartbeat (the Ender 3 V3 KE).
 *
 * The adapter used to hardcode `filamentUsedMm: null` with the comment "Creality
 * WS status carries no filament grams/length". The consequence was total: the
 * Ender's filament was never deducted and never even measurable, so every one of
 * its completed prints became an invisible debt while the warehouse balance
 * drifted. This pins the mapping down.
 *
 * The farm's Ender is offline, so the candidate field list is deliberately
 * conservative — the point of these tests is that a value IS read when the
 * firmware sends one, and that nothing is invented when it does not.
 */

test("reads the extrusion odometer the heartbeat reports", () => {
  assert.equal(parseCrealityUsedFilamentMm({ usedMaterialLength: 12345.6 }), 12345.6);
  assert.equal(parseCrealityUsedFilamentMm({ usedMaterialLength: "8000" }), 8000);
});

test("a genuine zero is a measurement, not a missing value", () => {
  // The distinction decides whether a finished print is a silent no-op or an
  // operator-facing debt, so 0 must survive as 0 and never collapse to null.
  assert.equal(parseCrealityUsedFilamentMm({ usedMaterialLength: 0 }), 0);
});

test("an absent, non-numeric or negative odometer stays null (never invented)", () => {
  assert.equal(parseCrealityUsedFilamentMm({}), null);
  assert.equal(parseCrealityUsedFilamentMm({ usedMaterialLength: "--" }), null);
  assert.equal(parseCrealityUsedFilamentMm({ usedMaterialLength: -1 }), null);
  assert.equal(parseCrealityUsedFilamentMm({ printProgress: 42 }), null);
});

test("falls through the known field spellings for the odometer", () => {
  assert.equal(parseCrealityUsedFilamentMm({ consumedFilament: 777 }), 777);
  assert.equal(
    parseCrealityUsedFilamentMm({ usedMaterialLength: "--", usedMaterialLength0: 640 }),
    640
  );
});

test("reads a named material when the firmware sends one", () => {
  assert.equal(parseCrealityMaterial({ materialType: "PLA" }), "PLA");
  assert.equal(parseCrealityMaterial({ consumableName: "PETG" }), "PETG");
});

test("the protocol's own no-value markers never become a material name", () => {
  // Binding a warehouse reel to the string "-1" would deduct from a position
  // nobody meant; the CFS uses exactly this convention for an empty slot.
  assert.equal(parseCrealityMaterial({ materialType: "-1" }), null);
  assert.equal(parseCrealityMaterial({ materialType: "unknown" }), null);
  assert.equal(parseCrealityMaterial({ materialType: "None" }), null);
  assert.equal(parseCrealityMaterial({ materialType: "  " }), null);
  assert.equal(parseCrealityMaterial({}), null);
});
