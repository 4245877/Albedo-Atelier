import assert from "node:assert/strict";
import { test } from "node:test";

import { applyCliCompatShims, needsRelativeEReset, usesRelativeE } from "./cliCompat";

/*
 * The relative-E / `G92 E0` shim. This is not a cosmetic guard: without it the
 * OrcaSlicer 2.3.0 CLI refuses to slice *any* Bambu profile — verified against the
 * stock `Bambu Lab A1 0.4 nozzle` chain, which dies with `return_code -51` and
 * "Relative extruder addressing requires resetting the extruder position at each
 * layer". Upstream skips that check for BBL printers, but the CLI sets the BBL flag
 * only after it has already run validation.
 */

/** The stock Bambu A1 shape: relative E on (the built-in default), no G92 E0. */
const A1_MACHINE = {
  printer_model: "Bambu Lab A1",
  gcode_flavor: "marlin",
  use_relative_e_distances: "1",
  layer_change_gcode: "; layer num/total_layer_count: {layer_num+1}/[total_layer_count]\nM73 L{layer_num+1}",
  before_layer_change_gcode: ""
};

test("a stock Bambu A1 config needs the reset (this is the real failing case)", () => {
  assert.equal(needsRelativeEReset(A1_MACHINE), true);
});

test("the shim adds G92 E0 to before_layer_change_gcode", () => {
  const { machine, applied } = applyCliCompatShims(A1_MACHINE);
  assert.match(String(machine.before_layer_change_gcode), /G92 E0/);
  assert.deepEqual(applied.map((s) => s.id), ["relative_e_g92_reset"]);
});

test("the shim does not mutate the caller's object", () => {
  const input = { ...A1_MACHINE };
  applyCliCompatShims(input);
  assert.equal(input.before_layer_change_gcode, "", "the stored profile must stay untouched");
});

test("an existing layer-change preamble is preserved, not replaced", () => {
  const { machine } = applyCliCompatShims({ ...A1_MACHINE, before_layer_change_gcode: "M117 layer" });
  assert.equal(machine.before_layer_change_gcode, "G92 E0\nM117 layer");
});

test("a profile that already resets E is left alone", () => {
  for (const key of ["layer_change_gcode", "before_layer_change_gcode"] as const) {
    const machine = { ...A1_MACHINE, [key]: "G92 E0\n; something" };
    assert.equal(needsRelativeEReset(machine), false, key);
    assert.deepEqual(applyCliCompatShims(machine).applied, []);
  }
});

test("absolute-E printers are left alone", () => {
  assert.equal(needsRelativeEReset({ ...A1_MACHINE, use_relative_e_distances: "0" }), false);
});

test("non-Marlin flavours are left alone — upstream gates only Marlin", () => {
  assert.equal(needsRelativeEReset({ ...A1_MACHINE, gcode_flavor: "klipper" }), false);
  // …but marlin2 is gated exactly like marlin.
  assert.equal(needsRelativeEReset({ ...A1_MACHINE, gcode_flavor: "marlin2" }), true);
});

test("Orca's string booleans and real booleans are both understood", () => {
  assert.equal(needsRelativeEReset({ ...A1_MACHINE, use_relative_e_distances: true }), true);
  assert.equal(needsRelativeEReset({ ...A1_MACHINE, use_relative_e_distances: "true" }), true);
  assert.equal(needsRelativeEReset({ ...A1_MACHINE, use_relative_e_distances: ["1"] }), true);
  assert.equal(needsRelativeEReset({ ...A1_MACHINE, use_relative_e_distances: "0" }), false);
});

test("an ABSENT relative-E key still needs the reset — Orca defaults it to 1", () => {
  // The stock `Bambu Lab A1 0.4 nozzle` chain omits the key entirely and inherits
  // the built-in default of 1. Reading absence as "absolute E" skipped the shim and
  // the stock chain kept dying with -51, so this case is pinned explicitly.
  const stock = { ...A1_MACHINE };
  delete (stock as Partial<typeof A1_MACHINE>).use_relative_e_distances;
  assert.equal(usesRelativeE(stock), true);
  assert.equal(needsRelativeEReset(stock), true);
  assert.match(String(applyCliCompatShims(stock).machine.before_layer_change_gcode), /G92 E0/);
});

test("G92 E0 is matched tolerantly (spacing and decimal zero)", () => {
  for (const gcode of ["G92  E0", "g92 e0", "G92 E0.0", "G92 E0 ; reset"]) {
    assert.equal(needsRelativeEReset({ ...A1_MACHINE, layer_change_gcode: gcode }), false, gcode);
  }
  // A near-miss must NOT count as a reset.
  assert.equal(needsRelativeEReset({ ...A1_MACHINE, layer_change_gcode: "G92 E1" }), true);
});
