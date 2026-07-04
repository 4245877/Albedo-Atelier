import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBambuStatus, mergeBambuStatus } from "./bambu";
import type { PrinterConfig } from "../config";
import type { PrinterLiveStatus } from "./types";

/*
 * Bambu live-status mapping: nozzle diameter/type parsing, active-filament
 * resolution, and the delta-merge that keeps the last known value when a partial
 * MQTT report omits a field. Pure — no MQTT client, no timers.
 */

function printer(): PrinterConfig {
  return {
    id: "a1",
    name: "A1",
    model: "Bambu A1",
    type: "FDM",
    protocol: "bambu",
    host: "10.0.0.5",
    material: "PLA",
    swatch: "",
    snapshotUrl: "",
    streamUrl: "",
    enabled: true,
    apiKey: "",
    serial: "SERIAL",
    accessCode: "CODE",
    light: {
      enabled: true,
      pin: "",
      onGcode: "",
      offGcode: "",
      statusObject: "",
      statusField: "value",
      bambuNode: "chamber_light"
    }
  };
}

test("buildBambuStatus reads nozzle_diameter and nozzle_type", () => {
  const status = buildBambuStatus(printer(), {
    print: { gcode_state: "RUNNING", nozzle_diameter: "0.4", nozzle_type: "hardened_steel" }
  });
  assert.ok(status);
  assert.equal(status!.nozzleDiameterMm, 0.4);
  assert.equal(status!.nozzleType, "hardened_steel");
});

test("buildBambuStatus tolerates a missing nozzle setting (null, not a crash)", () => {
  const status = buildBambuStatus(printer(), { print: { gcode_state: "RUNNING" } });
  assert.ok(status);
  assert.equal(status!.nozzleDiameterMm, null);
  assert.equal(status!.nozzleType, null);
  assert.equal(status!.activeFilament, null);
});

test("buildBambuStatus resolves the active AMS filament", () => {
  const status = buildBambuStatus(printer(), {
    print: {
      gcode_state: "RUNNING",
      nozzle_diameter: 0.4,
      ams: {
        tray_now: "0",
        ams: [{ id: "0", tray: [{ id: "0", tray_type: "PETG", tray_color: "00FF00FF", remain: 60, tray_weight: "1000" }] }]
      }
    }
  });
  assert.deepEqual(status!.activeFilament, { material: "PETG", color: "#00FF00", tray: 0, remainPct: 60 });
});

test("mergeBambuStatus keeps the last nozzle/filament when a delta omits them", () => {
  const previous = buildBambuStatus(printer(), {
    print: { gcode_state: "RUNNING", nozzle_diameter: 0.4, nozzle_type: "hardened_steel" }
  })!;
  // A later delta only carries a temperature — nozzle/filament fields are absent.
  const delta = buildBambuStatus(printer(), { print: { nozzle_temper: 210 } })!;
  assert.equal(delta.nozzleDiameterMm, null, "the raw delta itself has no nozzle setting");

  const merged = mergeBambuStatus(previous, delta);
  assert.equal(merged.nozzleDiameterMm, 0.4, "merge preserves the last known nozzle diameter");
  assert.equal(merged.nozzleType, "hardened_steel");
  assert.equal(merged.nozzleTemp, 210, "the fresh temperature still comes through");
});

test("mergeBambuStatus does not carry stale live data across an offline blip", () => {
  const online = buildBambuStatus(printer(), {
    print: { gcode_state: "RUNNING", nozzle_diameter: 0.4 }
  })!;
  const offline: PrinterLiveStatus = { ...online, online: false, nozzleDiameterMm: null };
  assert.equal(mergeBambuStatus(online, offline).nozzleDiameterMm, null);
});
