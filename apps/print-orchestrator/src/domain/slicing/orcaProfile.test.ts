import assert from "node:assert/strict";
import { test } from "node:test";

import {
  declaredType,
  intendedNozzleFromName,
  listOf,
  numOf,
  readFilament,
  readMachine,
  readPrintableArea,
  readProcess,
  strOf,
  unwrap
} from "./orcaProfile";

// ── Scalar coercion of Orca's string / single-element-array cells ────────────

test("unwrap pulls the scalar out of Orca's single-element arrays", () => {
  assert.equal(unwrap(["0.4"]), "0.4");
  assert.equal(unwrap([]), null);
  assert.equal(unwrap("x"), "x");
  assert.equal(unwrap(5), 5);
});

test("numOf coerces string/array cells and rejects non-finite / non-numeric", () => {
  assert.equal(numOf(["0.4"]), 0.4);
  assert.equal(numOf("0.28"), 0.28);
  assert.equal(numOf(0.2), 0.2);
  assert.equal(numOf(["abc"]), null);
  assert.equal(numOf([]), null);
  assert.equal(numOf(""), null);
  assert.equal(numOf(NaN), null);
  assert.equal(numOf(Infinity), null);
  assert.equal(numOf(null), null);
});

test("strOf returns a trimmed non-empty string, stringifies numbers, else null", () => {
  assert.equal(strOf(["PLA"]), "PLA");
  assert.equal(strOf("  marlin  "), "marlin");
  assert.equal(strOf("   "), null);
  assert.equal(strOf(5), "5");
  assert.equal(strOf([]), null);
  assert.equal(strOf(null), null);
});

test("listOf yields a clean string list (drops empties); a scalar becomes a 1-element list", () => {
  assert.deepEqual(listOf(["a", " b ", ""]), ["a", "b"]);
  assert.deepEqual(listOf("x"), ["x"]);
  assert.deepEqual(listOf([]), []);
  assert.deepEqual(listOf(null), []);
});

// ── printable_area extent ─────────────────────────────────────────────────────

test("readPrintableArea returns the [maxX, maxY] extent of the polygon", () => {
  assert.deepEqual(readPrintableArea(["0x0", "256x0", "256x256", "0x256"]), [256, 256]);
  assert.deepEqual(readPrintableArea(["0x0", "260x0", "260x260", "0x260"]), [260, 260]);
});

test("readPrintableArea is null-safe on garbage / empty input", () => {
  assert.deepEqual(readPrintableArea([]), [null, null]);
  assert.deepEqual(readPrintableArea("nope"), [null, null]);
  assert.deepEqual(readPrintableArea(["bad", "1"]), [null, null]);
});

// ── Field readers ─────────────────────────────────────────────────────────────

test("readMachine unwraps nozzle/variant/bed from Orca's mixed shapes", () => {
  const m = readMachine({
    nozzle_diameter: ["0.4"],
    printer_variant: "0.4",
    printer_model: "Bambu Lab A1",
    gcode_flavor: "marlin",
    max_layer_height: ["0.28"],
    min_layer_height: ["0.08"],
    printable_area: ["0x0", "256x0", "256x256", "0x256"],
    printable_height: "256"
  });
  assert.equal(m.nozzleDiameterMm, 0.4);
  assert.equal(m.printerModel, "Bambu Lab A1");
  assert.equal(m.bedWidthMm, 256);
  assert.equal(m.bedDepthMm, 256);
  assert.equal(m.bedHeightMm, 256);
});

test("readProcess and readFilament tolerate absent keys (null, not throw)", () => {
  const p = readProcess({});
  assert.equal(p.layerHeightMm, null);
  assert.equal(p.initialLayerHeightMm, null);
  assert.deepEqual(p.compatiblePrinters, []);

  const f = readFilament({ filament_type: ["PETG"], nozzle_temperature: ["245"] });
  assert.equal(f.filamentType, "PETG");
  assert.equal(f.nozzleTempC, 245);
  assert.equal(f.nozzleTempInitialC, null);
});

test("readFilament picks the first present bed-temp key across Orca's plate variants", () => {
  assert.equal(readFilament({ cool_plate_temp: ["60"] }).bedTempC, 60);
  assert.equal(readFilament({ hot_plate_temp: ["80"], cool_plate_temp: ["60"] }).bedTempC, 80);
});

test("declaredType maps Orca's folder aliases onto the domain profile types", () => {
  assert.equal(declaredType({ type: "printer" }), "machine");
  assert.equal(declaredType({ type: "machine" }), "machine");
  assert.equal(declaredType({ type: "print" }), "process");
  assert.equal(declaredType({ type: "filament" }), "filament");
  assert.equal(declaredType({ type: "mystery" }), null);
  assert.equal(declaredType({}), null);
});

// ── Name-based nozzle inference (warning-only signal) ─────────────────────────

test("intendedNozzleFromName reads an explicit '… X nozzle' but ignores ambiguous sizes", () => {
  assert.equal(intendedNozzleFromName("Creality K2 0.2 nozzle"), 0.2);
  assert.equal(intendedNozzleFromName("System 0.4mm nozzle"), 0.4);
  assert.equal(intendedNozzleFromName("0.6mm profile"), 0.6);
  assert.equal(intendedNozzleFromName("0.8mm profile"), 0.8);
  // Ambiguous sizes (equally likely a layer height) are deliberately not inferred.
  assert.equal(intendedNozzleFromName("0.2mm SuperDetail"), null);
  assert.equal(intendedNozzleFromName("0.4mm Standard"), null);
  assert.equal(intendedNozzleFromName(null), null);
  assert.equal(intendedNozzleFromName(""), null);
});
