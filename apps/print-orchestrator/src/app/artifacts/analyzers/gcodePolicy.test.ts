import assert from "node:assert/strict";
import { test } from "node:test";

import { CommandPolicy, POLICY_COMMANDS, type GcodeProvenance } from "./gcodePolicy";

/** The provenance a real OrcaSlicer-for-A1 file carries in its own header. */
const BAMBU: GcodeProvenance = { slicer: "OrcaSlicer", printerModel: "Bambu Lab A1" };
const MARLIN: GcodeProvenance = { slicer: "PrusaSlicer", printerModel: "MK4" };

/** Feeds a G-code body through the policy the way {@link analyzeGcode} does. */
function run(body: string, provenance: GcodeProvenance) {
  const policy = new CommandPolicy();
  let line = 0;
  for (const raw of body.split("\n")) {
    line += 1;
    const code = raw.split(";", 1)[0].trim();
    if (code.length === 0) continue;
    policy.observe(code.split(/\s+/)[0].toUpperCase(), line);
  }
  return { ...policy.evaluate(provenance), hasReviewCommands: policy.hasReviewCommands };
}

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

/**
 * The stock Bambu levelling block, verbatim from
 * `resources/profiles/BBL/machine/Bambu Lab A1 0.4 nozzle.json`'s
 * `machine_start_gcode` — the shape the exception is written for.
 */
const BAMBU_LEVELLING = [
  ";===== bed leveling ==================================",
  "M1002 judge_flag g29_before_print_flag",
  "G90",
  "G1 Z5 F1200",
  "G29.2 S1 ; turn on ABL",
  "M190 S80",
  "M622 J1",
  "    M1002 gcode_claim_action : 1",
  "    G29 A1 X109.562 Y59.325 I32.975 J137.35",
  "    M400",
  "    M500 ; save cali data",
  "M623"
].join("\n");

test("M500 in Bambu's own levelling block is allowed — with a visible warning, not silence", () => {
  const r = run(BAMBU_LEVELLING, BAMBU);
  assert.deepEqual(codes(r.blockers), []);
  assert.deepEqual(codes(r.warnings), ["gcode_vendor_calibration_save"]);
  assert.match(r.warnings[0].message, /M500 ×1/);
  assert.match(r.warnings[0].message, /Bambu Lab A1/);
});

test("the same block on a Marlin printer stays forbidden", () => {
  const r = run(BAMBU_LEVELLING, MARLIN);
  assert.deepEqual(codes(r.blockers), ["gcode_forbidden_command"]);
  assert.match(r.blockers[0].message, /M500/);
});

test("Bambu machine + Bambu dialect but a hand-written file (no slicer banner) is refused", () => {
  const r = run(BAMBU_LEVELLING, { slicer: null, printerModel: "Bambu Lab A1" });
  assert.deepEqual(codes(r.blockers), ["gcode_forbidden_command"]);
});

test("an OrcaSlicer file that names no Bambu target is refused", () => {
  const r = run(BAMBU_LEVELLING, { slicer: "OrcaSlicer", printerModel: "Creality K2" });
  assert.deepEqual(codes(r.blockers), ["gcode_forbidden_command"]);
});

test("Bambu header without the Bambu dialect (no M622/M623) is refused", () => {
  // Everything the header claims, but the body is plain Marlin — exactly what a
  // forged header on a hostile file would look like. Refused as an ordinary
  // persistent-settings write, since nothing establishes the vendor semantics.
  const r = run(["G29", "M400", "M500"].join("\n"), BAMBU);
  assert.deepEqual(codes(r.blockers), ["gcode_forbidden_command"]);
  assert.match(r.blockers[0].message, /запись настроек в постоянную память/);
});

test("M500 outside the conditional block is refused even on a Bambu machine", () => {
  const r = run([BAMBU_LEVELLING, "M500"].join("\n"), BAMBU);
  assert.deepEqual(codes(r.blockers), ["gcode_forbidden_command"]);
  assert.match(r.blockers[0].message, /вне условного блока/);
});

test("a conditional block that never probed the bed cannot save anything", () => {
  const r = run(["M622 J1", "  M400", "  M500", "M623"].join("\n"), BAMBU);
  assert.deepEqual(codes(r.blockers), ["gcode_forbidden_command"]);
  assert.match(r.blockers[0].message, /не было замера стола/);
});

test("a settings mutation anywhere earlier re-arms M500 as a blocker", () => {
  // The actual attack the denylist exists to stop: change the steps-per-mm, then
  // make it permanent. The vendor exception must not launder it.
  const r = run(["M92 E1000", BAMBU_LEVELLING].join("\n"), BAMBU);
  assert.deepEqual(codes(r.blockers), ["gcode_forbidden_command"]);
  assert.match(r.blockers[0].message, /изменялись настройки/);
});

test("every settings-mutating command arms the gate", () => {
  for (const word of POLICY_COMMANDS.settingsMutating) {
    const r = run([`${word} S1`, BAMBU_LEVELLING].join("\n"), BAMBU);
    assert.deepEqual(codes(r.blockers), ["gcode_forbidden_command"], `${word} should arm M500`);
  }
});

test("the slicer's own per-print motion limits do not arm the gate", () => {
  // M201–M205/M220/M221 appear in the body of every sliced file (15 756 times in
  // the A1 fixture this policy was written against). Treating them as a mutation
  // would forbid M500 in every real print — noise, not safety.
  const r = run(
    ["M201 X20000 Y20000", "M204 S6000", "M220 S100", "M221 S100", BAMBU_LEVELLING].join("\n"),
    BAMBU
  );
  assert.deepEqual(codes(r.blockers), []);
  assert.deepEqual(codes(r.warnings), ["gcode_vendor_calibration_save"]);
});

test("repeated levelling blocks collapse into one warning, not one per occurrence", () => {
  const r = run(Array.from({ length: 12 }, () => BAMBU_LEVELLING).join("\n"), BAMBU);
  assert.deepEqual(codes(r.warnings), ["gcode_vendor_calibration_save"]);
  assert.match(r.warnings[0].message, /M500 ×12/);
});

test("the vendor exception is scoped to M500 — no other EEPROM command benefits", () => {
  for (const word of ["M501", "M502", "M509", "M997", "M999", "SAVE_CONFIG", "RUN_SHELL_COMMAND"]) {
    const r = run(["M622 J1", "  G29", `  ${word}`, "M623"].join("\n"), BAMBU);
    assert.deepEqual(codes(r.blockers), ["gcode_forbidden_command"], `${word} must stay forbidden`);
  }
});

test("a forbidden command is reported once, with the line it was found on", () => {
  const r = run(["G1 X1", "M502", "G1 X2", "M502"].join("\n"), MARLIN);
  assert.equal(r.blockers.length, 1);
  assert.match(r.blockers[0].message, /строка 2/);
});

test("review commands are reported and flagged for the verdict", () => {
  const r = run(["M600", "M42 P1 S255"].join("\n"), MARLIN);
  assert.deepEqual(codes(r.blockers), []);
  assert.equal(r.hasReviewCommands, true);
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.every((w) => w.code === "gcode_risky_command"));
});

test("a stray M623 cannot drive the nesting depth negative", () => {
  // Malformed input must not open a hole: after unbalanced M623s a top-level M500
  // is still outside a conditional.
  const r = run(["M623", "M623", "M623", "G29", "M500"].join("\n"), BAMBU);
  assert.deepEqual(codes(r.blockers), ["gcode_forbidden_command"]);
  assert.match(r.blockers[0].message, /вне условного блока/);
});

test("nested conditionals keep the exception working (Bambu nests M622 inside M622)", () => {
  const r = run(
    ["M622 J1", "  G29 A1 X1 Y1 I1 J1", "  M622 J0", "    M400", "  M623", "  M500", "M623"].join("\n"),
    BAMBU
  );
  assert.deepEqual(codes(r.blockers), []);
  assert.deepEqual(codes(r.warnings), ["gcode_vendor_calibration_save"]);
});

test("the forbidden and review vocabularies do not overlap", () => {
  for (const word of POLICY_COMMANDS.forbidden.keys()) {
    assert.equal(POLICY_COMMANDS.review.has(word), false, `${word} is in both lists`);
  }
});
