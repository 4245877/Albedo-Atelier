import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizePrinterConfig } from "../infra/printers/config";
import { supportsPrinterLight } from "../infra/printers/status";
import { buildPrinterView } from "./printerView";

/*
 * `lightSupported` in the view is the single source of truth the frontend uses
 * to decide whether the light buttons work — it must reflect the configured
 * command, never merely whether a state can be read.
 */

test("a Moonraker K2 with a pin supports light control", () => {
  const printer = normalizePrinterConfig({
    id: "k2",
    name: "Creality K2",
    host: "127.0.0.1",
    protocol: "moonraker",
    port: 4408,
    light: { pin: "LED" }
  });
  assert.ok(printer);
  assert.equal(supportsPrinterLight(printer!), true);
  assert.equal(buildPrinterView(printer!, undefined, undefined).lightSupported, true);
});

test("a Moonraker printer without any light gcode does not support control", () => {
  const printer = normalizePrinterConfig({
    id: "p",
    name: "Pin-less",
    host: "127.0.0.1",
    protocol: "moonraker",
    light: { enabled: true } // enabled but no pin/onGcode/offGcode
  });
  assert.ok(printer);
  assert.equal(supportsPrinterLight(printer!), false);
  assert.equal(buildPrinterView(printer!, undefined, undefined).lightSupported, false);
});

test("the view no longer exposes a lightAllowed field", () => {
  const printer = normalizePrinterConfig({
    id: "k2",
    name: "Creality K2",
    host: "127.0.0.1",
    protocol: "moonraker",
    light: { pin: "LED" }
  });
  const view = buildPrinterView(printer!, undefined, undefined) as unknown as Record<string, unknown>;
  assert.equal("lightAllowed" in view, false);
});
