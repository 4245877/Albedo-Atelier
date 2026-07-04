import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMoonrakerNozzleDiameter } from "./moonraker";

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
