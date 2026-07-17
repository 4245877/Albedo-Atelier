import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { loadPrintersConfig, normalizePrinterConfig } from "./config";

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

// ── id validation & uniqueness ────────────────────────────────────────────

test("buildVolume is accepted only when x/y/z are all finite and positive", () => {
  const ok = normalizePrinterConfig({
    id: "k2",
    name: "X",
    host: "127.0.0.1",
    buildVolume: { x: 300, y: 300, z: 300 }
  });
  assert.deepEqual(ok?.buildVolume, { x: 300, y: 300, z: 300 });

  // A partial / non-numeric / non-positive box is dropped to null (fall back to the profile).
  for (const bad of [{ x: 300, y: 300 }, { x: "abc", y: 300, z: 300 }, { x: 0, y: 300, z: 300 }, "300x300x300"]) {
    const p = normalizePrinterConfig({ id: "k2", name: "X", host: "127.0.0.1", buildVolume: bad });
    assert.equal(p?.buildVolume ?? null, null, `dropped: ${JSON.stringify(bad)}`);
  }
});

test("an unsafe printer id (path traversal / separators) is rejected", () => {
  for (const id of ["../evil", "a/b", "a b", "..", "a.b", "a:b", ""]) {
    assert.equal(
      normalizePrinterConfig({ id, name: "X", host: "127.0.0.1" }),
      null,
      `id ${JSON.stringify(id)} must be rejected`
    );
  }
  // A safe id passes.
  assert.ok(normalizePrinterConfig({ id: "creality-k2", name: "X", host: "127.0.0.1" }));
});

afterEach(() => {
  delete process.env.PRINTERS_CONFIG_PATH;
  delete process.env.PRINTERS_CONFIG_JSON;
});

test("loadPrintersConfig drops duplicate ids (first wins) and warns", async () => {
  process.env.PRINTERS_CONFIG_PATH = "/nonexistent/printers.json"; // force the env source
  process.env.PRINTERS_CONFIG_JSON = JSON.stringify([
    { id: "k2", name: "First", host: "10.0.0.1", protocol: "moonraker" },
    { id: "k2", name: "Second (dup)", host: "10.0.0.2", protocol: "moonraker" },
    { id: "a1", name: "Bambu", host: "10.0.0.3", protocol: "bambu" }
  ]);

  const { printers, source } = await loadPrintersConfig();
  assert.deepEqual(
    printers.map((p) => p.id),
    ["k2", "a1"],
    "the second k2 is dropped"
  );
  assert.equal(printers[0].name, "First", "the first entry for an id wins");
  assert.match(String(source.warning), /Повторяющиеся id/);
});
