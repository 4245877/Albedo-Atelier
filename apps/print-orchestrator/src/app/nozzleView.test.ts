import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizePrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { buildPrinterView } from "./printerView";

/*
 * The nozzle diameter/type in the view must prefer live device telemetry, fall
 * back to the declared values, and tag the source honestly so the dashboard
 * never presents an operator's default as data read from the printer.
 *
 * The source vocabulary is the shared one from `domain/printers/specs.ts`
 * (`printer` / `manual` / `catalog` / `unknown`) — the same words the hardware
 * card uses, so the two surfaces cannot describe the same value differently.
 */

function k2(extra: Record<string, unknown> = {}) {
  return normalizePrinterConfig({
    id: "creality-k2",
    name: "Creality K2",
    host: "127.0.0.1",
    protocol: "moonraker",
    port: 4408,
    material: "PETG",
    ...extra,
  })!;
}

function liveStatus(overrides: Partial<PrinterLiveStatus>): PrinterLiveStatus {
  return {
    id: "creality-k2",
    online: true,
    status: "printing",
    currentFile: null,
    progressPct: null,
    remainingMinutes: null,
    filamentUsedMm: null,
    amsTrays: null,
    nozzleDiameterMm: null,
    nozzleType: null,
    activeFilament: null,
    nozzleTemp: null,
    nozzleTarget: null,
    bedTemp: null,
    bedTarget: null,
    chamberTemp: null,
    light: null,
    stateText: null,
    stateMessage: null,
    error: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("a live nozzle diameter from the device is tagged as from the printer", () => {
  const view = buildPrinterView(k2(), liveStatus({ nozzleDiameterMm: 0.4 }), undefined);
  assert.equal(view.nozzleDiameter, 0.4);
  assert.equal(view.nozzleDiameterSource, "printer");
});

test("with no live value, the configured diameter is used and tagged as manual", () => {
  const view = buildPrinterView(k2({ nozzleDiameterMm: 0.6 }), liveStatus({}), undefined);
  assert.equal(view.nozzleDiameter, 0.6);
  assert.equal(view.nozzleDiameterSource, "manual");
});

test("a live diameter wins over a configured one", () => {
  const view = buildPrinterView(k2({ nozzleDiameterMm: 0.6 }), liveStatus({ nozzleDiameterMm: 0.4 }), undefined);
  assert.equal(view.nozzleDiameter, 0.4);
  assert.equal(view.nozzleDiameterSource, "printer");
});

test("no live and no configured diameter is unknown, never invented", () => {
  const view = buildPrinterView(k2(), liveStatus({}), undefined);
  assert.equal(view.nozzleDiameter, null);
  assert.equal(view.nozzleDiameterSource, "unknown");
});

test("nozzle type falls back to the declared value and is tagged honestly", () => {
  const printerView = buildPrinterView(k2({ nozzleType: "hardened_steel" }), liveStatus({}), undefined);
  assert.equal(printerView.nozzleType, "hardened_steel");
  assert.equal(printerView.nozzleTypeSource, "manual");

  const liveView = buildPrinterView(k2(), liveStatus({ nozzleType: "brass" }), undefined);
  assert.equal(liveView.nozzleType, "brass");
  assert.equal(liveView.nozzleTypeSource, "printer");

  const noneView = buildPrinterView(k2(), liveStatus({}), undefined);
  assert.equal(noneView.nozzleType, null);
  assert.equal(noneView.nozzleTypeSource, "unknown");
});

test("an offline printer still shows the configured nozzle as a manual fallback", () => {
  const view = buildPrinterView(k2({ nozzleDiameterMm: 0.4 }), undefined, undefined);
  assert.equal(view.nozzleDiameter, 0.4);
  assert.equal(view.nozzleDiameterSource, "manual");
});

test("live filament from the job wins over config and is tagged as from the printer", () => {
  const view = buildPrinterView(
    k2(),
    liveStatus({ activeFilament: { material: "PLA", color: "#1A2B3C", tray: null, remainPct: null } }),
    undefined
  );
  assert.equal(view.liveMaterial, "PLA");
  assert.equal(view.liveMaterialColor, "#1A2B3C");
  assert.equal(view.liveMaterialSource, "printer");
  assert.equal(view.activeTray, null);
});

test("with no live filament, the configured material is used and tagged as manual", () => {
  const view = buildPrinterView(k2({ material: "PETG" }), liveStatus({}), undefined);
  assert.equal(view.liveMaterial, null);
  assert.equal(view.material, "PETG");
  assert.equal(view.liveMaterialSource, "manual");
});

test("no live filament and no configured material is unknown, never invented", () => {
  const view = buildPrinterView(k2({ material: "" }), liveStatus({}), undefined);
  assert.equal(view.liveMaterial, null);
  assert.equal(view.liveMaterialSource, "unknown");
});

test("normalizePrinterConfig rejects a bogus configured diameter", () => {
  assert.equal(k2({ nozzleDiameterMm: 0 }).nozzleDiameterMm, null);
  assert.equal(k2({ nozzleDiameterMm: "abc" }).nozzleDiameterMm, null);
  assert.equal(k2({ nozzleDiameterMm: 0.4 }).nozzleDiameterMm, 0.4);
});
