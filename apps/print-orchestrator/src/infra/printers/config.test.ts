import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizePrinterConfig } from "./config";

/*
 * Light config normalization, focused on the active-low (`invert`) pin support:
 * an inverted pin must light the fixture at VALUE=0, so the auto-generated on/off
 * G-code swaps its VALUE while the day↔night policy above it stays untouched.
 */

function light(input: unknown) {
  const printer = normalizePrinterConfig({
    id: "k2",
    name: "Creality K2",
    host: "127.0.0.1",
    protocol: "moonraker",
    port: 4408,
    light: input
  });
  assert.ok(printer, "expected a valid printer config");
  return printer!.light;
}

test("a normal pin drives VALUE=1 to turn the light on and VALUE=0 to turn it off", () => {
  const config = light({ pin: "LED" });
  assert.equal(config.invert, false);
  assert.equal(config.onGcode, "SET_PIN PIN=LED VALUE=1");
  assert.equal(config.offGcode, "SET_PIN PIN=LED VALUE=0");
});

test("an active-low pin (invert) swaps the VALUEs so ON drives the pin low", () => {
  const config = light({ pin: "LED", invert: true });
  assert.equal(config.invert, true);
  assert.equal(config.onGcode, "SET_PIN PIN=LED VALUE=0");
  assert.equal(config.offGcode, "SET_PIN PIN=LED VALUE=1");
  // The queried status object is unaffected by inversion.
  assert.equal(config.statusObject, "output_pin LED");
});

test("invert defaults to false and only a literal true enables it", () => {
  assert.equal(light({ pin: "LED" }).invert, false);
  assert.equal(light({ pin: "LED", invert: false }).invert, false);
  assert.equal(light({ pin: "LED", invert: "true" }).invert, false);
  assert.equal(light({ pin: "LED", invert: 1 }).invert, false);
  assert.equal(light({ pin: "LED", invert: true }).invert, true);
});

test("explicit on/off G-code wins over invert (the operator already encoded intent)", () => {
  const config = light({
    pin: "LED",
    invert: true,
    onGcode: "LIGHT_ON",
    offGcode: "LIGHT_OFF"
  });
  assert.equal(config.onGcode, "LIGHT_ON");
  assert.equal(config.offGcode, "LIGHT_OFF");
  // The flag is still recorded so the status read can stay truthful.
  assert.equal(config.invert, true);
});
