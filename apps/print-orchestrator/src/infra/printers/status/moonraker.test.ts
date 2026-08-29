import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizePrinterConfig } from "../config";
import {
  parseMoonrakerCurPrintMetadata,
  parseMoonrakerFilamentWeightG,
  parseMoonrakerJobFilament,
  parseMoonrakerNozzleDiameter,
  readMoonrakerLightState,
  readMoonrakerJobMetadata
} from "./moonraker";

/*
 * Nozzle diameter from Klipper's parsed config, as returned by Moonraker's
 * `configfile` object. This is what makes the Creality K2 (driven over Moonraker)
 * report a live nozzle diameter. Pure — no HTTP.
 */

test("reads the numeric nozzle diameter from configfile.settings.extruder", () => {
  const status = { configfile: { settings: { extruder: { nozzle_diameter: 0.4 } } } };
  assert.equal(parseMoonrakerNozzleDiameter(status), 0.4);
});

test("falls back to the raw string config when settings is absent", () => {
  const status = { configfile: { config: { extruder: { nozzle_diameter: "0.6" } } } };
  assert.equal(parseMoonrakerNozzleDiameter(status), 0.6);
});

test("prefers the type-converted settings value over the raw config string", () => {
  const status = {
    configfile: {
      settings: { extruder: { nozzle_diameter: 0.8 } },
      config: { extruder: { nozzle_diameter: "0.4" } },
    },
  };
  assert.equal(parseMoonrakerNozzleDiameter(status), 0.8);
});

test("returns null when the configfile object is missing (never invents a value)", () => {
  assert.equal(parseMoonrakerNozzleDiameter({}), null);
  assert.equal(parseMoonrakerNozzleDiameter({ configfile: {} }), null);
  assert.equal(parseMoonrakerNozzleDiameter({ configfile: { settings: {} } }), null);
});

test("treats a bogus zero/negative diameter as unknown, not a real value", () => {
  assert.equal(
    parseMoonrakerNozzleDiameter({ configfile: { settings: { extruder: { nozzle_diameter: 0 } } } }),
    null
  );
  assert.equal(
    parseMoonrakerNozzleDiameter({
      configfile: { settings: { extruder: { nozzle_diameter: "-1" } } },
    }),
    null
  );
});

test("tolerates malformed shapes without throwing", () => {
  assert.equal(parseMoonrakerNozzleDiameter({ configfile: null } as never), null);
  assert.equal(
    parseMoonrakerNozzleDiameter({ configfile: { settings: { extruder: "nope" } } }),
    null
  );
});

/*
 * Active filament from the current job's sliced metadata — the honest live
 * filament signal for the K2 (its CFS `box`/`filament_rack` carry no usable
 * material and no active-slot field, so they are intentionally not a source).
 */

test("reads material and colour from sliced job metadata", () => {
  const filament = parseMoonrakerJobFilament({
    filament_type: "PLA",
    filament_colors: ["#1A2B3C"],
  });
  assert.deepEqual(filament, { material: "PLA", color: "#1A2B3C", tray: null, remainPct: null });
});

test("takes the primary material from a multi-material list", () => {
  assert.equal(parseMoonrakerJobFilament({ filament_type: "PETG;PLA" })?.material, "PETG");
  assert.equal(parseMoonrakerJobFilament({ filament_type: "PETG,PLA" })?.material, "PETG");
  assert.equal(parseMoonrakerJobFilament({ filament_type: ["ABS", "PLA"] })?.material, "ABS");
});

test("falls back to filament_name when filament_type is absent", () => {
  assert.equal(parseMoonrakerJobFilament({ filament_name: "Generic TPU" })?.material, "Generic TPU");
});

test("normalises a bare hex colour and ignores an invalid one", () => {
  assert.equal(parseMoonrakerJobFilament({ filament_type: "PLA", filament_colors: ["1a2b3c"] })?.color, "#1A2B3C");
  assert.equal(parseMoonrakerJobFilament({ filament_type: "PLA", filament_colors: ["nope"] })?.color, null);
});

test("returns null when metadata carries no usable filament (never invents)", () => {
  assert.equal(parseMoonrakerJobFilament({}), null);
  assert.equal(parseMoonrakerJobFilament({ filament_type: "-1", filament_colors: [] }), null);
  assert.equal(parseMoonrakerJobFilament({ filament_type: "unknown" }), null);
});

/*
 * Live chamber-light state from the Moonraker `output_pin` status object. An
 * active-low pin (`light.invert`) is lit when the pin reads low, so the raw pin
 * value is flipped — the reported boolean always means "physically lit", matching
 * what the on/off commands drive.
 */

function k2Light(lightConfig: unknown) {
  const printer = normalizePrinterConfig({
    id: "k2",
    name: "Creality K2",
    host: "127.0.0.1",
    protocol: "moonraker",
    port: 4408,
    light: lightConfig
  });
  assert.ok(printer);
  return printer!;
}

test("a normal pin reports on when the pin reads high and off when low", () => {
  const printer = k2Light({ pin: "LED" });
  assert.equal(readMoonrakerLightState(printer, { "output_pin LED": { value: 1 } }), true);
  assert.equal(readMoonrakerLightState(printer, { "output_pin LED": { value: 0 } }), false);
});

test("an active-low pin (invert) reports on when the pin reads low", () => {
  const printer = k2Light({ pin: "LED", invert: true });
  assert.equal(readMoonrakerLightState(printer, { "output_pin LED": { value: 0 } }), true);
  assert.equal(readMoonrakerLightState(printer, { "output_pin LED": { value: 1 } }), false);
});

test("invert also flips textual pin states", () => {
  const printer = k2Light({ pin: "LED", invert: true });
  assert.equal(readMoonrakerLightState(printer, { "output_pin LED": { value: "off" } }), true);
  assert.equal(readMoonrakerLightState(printer, { "output_pin LED": { value: "on" } }), false);
});

test("an unreadable pin stays null regardless of invert (never invents a state)", () => {
  assert.equal(readMoonrakerLightState(k2Light({ pin: "LED" }), {}), null);
  assert.equal(
    readMoonrakerLightState(k2Light({ pin: "LED", invert: true }), {
      "output_pin LED": { value: "???" }
    }),
    null
  );
});

/*
 * The sliced metadata Creality's Klipper fork embeds in `virtual_sdcard`.
 *
 * Captured verbatim from the farm's K2 mid-print. The fixture matters because
 * the STANDARD Moonraker route on this device answers `{"slicer": "Unknown"}`
 * with no filament fields for every file it holds — so reading only that route
 * left `activeFilament` permanently null, which meant the loaded-reel sync never
 * fired and deductions kept draining whatever position an operator had bound by
 * hand weeks earlier.
 */
const K2_VIRTUAL_SDCARD = {
  file_path: "/mnt/UDISK/printer_data/gcodes/AQARA_M2_PETG_1h15m.gcode",
  progress: 0.5848963241532185,
  is_active: true,
  cur_print_data: {
    filament_used: 2185.253090001999,
    filename: "AQARA_M2_PETG_1h15m.gcode",
    metadata: {
      slicer: "OrcaSlicer",
      slicer_version: "2.4.2",
      layer_count: 298,
      estimated_time: 4497,
      nozzle_diameter: 0.4,
      filament_name: 'PETG @K2 FAST1";"PETG @K2 FAST1',
      filament_type: "PETG;PETG;PETG;PETG",
      filament_total: 13122.56,
      filament_weight_total: 39.45
    }
  }
};

test("reads the embedded sliced metadata a vendor Klipper publishes in virtual_sdcard", () => {
  const metadata = parseMoonrakerCurPrintMetadata(K2_VIRTUAL_SDCARD);
  assert.ok(metadata, "cur_print_data.metadata is where the real values live on this device");
  assert.equal(metadata.slicer, "OrcaSlicer");
});

test("a stock Klipper without cur_print_data yields null (the HTTP route stays the fallback)", () => {
  assert.equal(parseMoonrakerCurPrintMetadata({ progress: 0.5, is_active: true }), null);
  assert.equal(parseMoonrakerCurPrintMetadata({ cur_print_data: { filename: "a.gcode" } }), null);
  assert.equal(parseMoonrakerCurPrintMetadata({ cur_print_data: "nonsense" }), null);
});

test("the embedded metadata yields the K2's material, ETA and slicer weight", () => {
  const metadata = parseMoonrakerCurPrintMetadata(K2_VIRTUAL_SDCARD) as Record<string, unknown>;
  const job = readMoonrakerJobMetadata(metadata);

  // A multi-extruder list collapses to the primary material — the reel binding
  // names one material, and guessing which slot feeds would be invention.
  assert.deepEqual(job.filament, { material: "PETG", color: null, tray: null, remainPct: null });
  assert.equal(job.estimatedTimeSec, 4497);
  assert.equal(job.slicerFilamentG, 39.45);
});

test("the slicer weight is an estimate: absent/zero/negative reads as unknown, never as zero grams", () => {
  assert.equal(parseMoonrakerFilamentWeightG({ filament_weight_total: 39.45 }), 39.45);
  assert.equal(parseMoonrakerFilamentWeightG({}), null);
  assert.equal(parseMoonrakerFilamentWeightG({ filament_weight_total: 0 }), null);
  assert.equal(parseMoonrakerFilamentWeightG({ filament_weight_total: -5 }), null);
  assert.equal(parseMoonrakerFilamentWeightG({ filament_weight_total: "nope" }), null);
});

test("the empty answer Moonraker's own route gives on this device carries nothing", () => {
  // Verbatim shape of GET /server/files/metadata on the farm's K2.
  const job = readMoonrakerJobMetadata({
    size: 3744797,
    slicer: "Unknown",
    gcode_start_byte: 17840,
    filename: "AQARA_M2_PETG_1h15m.gcode"
  });

  assert.deepEqual(job, { filament: null, estimatedTimeSec: null, slicerFilamentG: null });
});
