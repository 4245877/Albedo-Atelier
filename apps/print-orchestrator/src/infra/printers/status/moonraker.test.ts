import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizePrinterConfig } from "../config";
import {
  parseMoonrakerJobFilament,
  parseMoonrakerNozzleDiameter,
  readMoonrakerLightState
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
