import assert from "node:assert/strict";
import { test } from "node:test";

import { parseKlipperBuildVolume, parseKlipperFeatures } from "./moonraker";

/*
 * Klipper publishes the config it is actually running, which makes the build
 * volume a genuine device reading rather than a catalogue figure. These tests
 * pin that reading — and the line the K2's CFS must not cross.
 */

const K2_SETTINGS = {
  printer: { kinematics: "corexy", max_velocity: 500 },
  extruder: { nozzle_diameter: 0.4, filament_diameter: 1.75 },
  stepper_x: { position_min: 0, position_max: 350 },
  stepper_y: { position_min: 0, position_max: 350 },
  stepper_z: { position_min: 0, position_max: 345 },
  heater_bed: { max_temp: 120 }
};

test("the build volume is read from the axis limits Klipper enforces", () => {
  assert.deepEqual(parseKlipperBuildVolume(K2_SETTINGS), { x: 350, y: 350, z: 345 });
});

test("a negative axis origin reduces the usable travel", () => {
  const settings = {
    ...K2_SETTINGS,
    stepper_x: { position_min: -5, position_max: 350 }
  };
  assert.deepEqual(parseKlipperBuildVolume(settings), { x: 355, y: 350, z: 345 });
});

test("a missing position_min is treated as an origin at zero", () => {
  const settings = { ...K2_SETTINGS, stepper_y: { position_max: 220 } };
  assert.deepEqual(parseKlipperBuildVolume(settings), { x: 350, y: 220, z: 345 });
});

test("a half-known volume is not a volume", () => {
  // Two axes cannot be checked against a model's footprint, so the answer is
  // "unknown" rather than a partial object a consumer might treat as complete.
  assert.equal(parseKlipperBuildVolume({ stepper_x: { position_max: 350 } }), null);
  assert.equal(parseKlipperBuildVolume({}), null);
});

test("a degenerate axis span is refused rather than reported as zero", () => {
  const settings = { ...K2_SETTINGS, stepper_z: { position_min: 100, position_max: 100 } };
  assert.equal(parseKlipperBuildVolume(settings), null);
});

// ── Features ─────────────────────────────────────────────────────────────────

test("configured hardware is read from the settings and the object list", () => {
  const features = parseKlipperFeatures(
    { ...K2_SETTINGS, extruder1: { nozzle_diameter: 0.4 } },
    [
      "configfile",
      "extruder",
      "extruder1",
      "heater_bed",
      "heater_generic chamber",
      "temperature_sensor chamber_temp",
      "filament_switch_sensor toolhead_sensor"
    ]
  );

  assert.equal(features.extruderCount, 2);
  assert.equal(features.kinematics, "corexy");
  assert.equal(features.heatedChamber, true);
  assert.equal(features.chamberSensor, true);
  assert.equal(features.filamentSensor, true);
  assert.equal(features.cfs, false);
});

test("a plain single-extruder machine reports no chamber and no sensor", () => {
  const features = parseKlipperFeatures(K2_SETTINGS, ["configfile", "extruder", "heater_bed"]);

  assert.equal(features.extruderCount, 1);
  assert.equal(features.heatedChamber, false);
  assert.equal(features.chamberSensor, false);
  assert.equal(features.filamentSensor, false);
});

test("the K2's CFS is detected as PRESENT and nothing more", () => {
  // The real K2-7F14 reports every CFS slot as `-1` with no field naming the
  // feeding one, so slot contents are deliberately never read from it — this
  // parser only ever answers "there is a box".
  const features = parseKlipperFeatures(K2_SETTINGS, ["configfile", "extruder", "box"]);
  assert.equal(features.cfs, true);
});

test("kinematics is null when the config does not state it", () => {
  const features = parseKlipperFeatures({ extruder: {} }, ["extruder"]);
  assert.equal(features.kinematics, null);
});

test("object names are matched case-insensitively", () => {
  const features = parseKlipperFeatures(K2_SETTINGS, ["Filament_Switch_Sensor Runout", "BOX"]);
  assert.equal(features.filamentSensor, true);
  assert.equal(features.cfs, true);
});
