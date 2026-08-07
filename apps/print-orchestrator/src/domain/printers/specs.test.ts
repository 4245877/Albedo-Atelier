import assert from "node:assert/strict";
import { test } from "node:test";

import type { Fact, PrinterDiscoveryRecord } from "./discovery";
import { resolvePrinterSpecs, withLiveReading, type DeclaredPrinterSpecs } from "./specs";

/*
 * The priority matrix. This is the only place in the service that decides who
 * answers "what nozzle is on this machine?", so the whole rule is pinned here:
 * printer → manual → catalog → unknown, with a losing manual value reported
 * rather than dropped.
 */

const PROBED_AT = "2026-08-07T10:00:00.000Z";
const EDITED_AT = "2026-08-01T09:00:00.000Z";

function declared(overrides: Partial<DeclaredPrinterSpecs> = {}): DeclaredPrinterSpecs {
  return { type: "FDM", updatedAt: EDITED_AT, ...overrides };
}

function discovered(
  facts: PrinterDiscoveryRecord["facts"],
  overrides: Partial<PrinterDiscoveryRecord> = {}
): PrinterDiscoveryRecord {
  return {
    id: "p1",
    protocol: "bambu",
    facts,
    probedAt: PROBED_AT,
    succeeded: true,
    error: null,
    version: 1,
    ...overrides
  };
}

const fromPrinter = <T>(value: T, via = "MQTT print.x"): Fact<T> => ({
  value,
  source: "printer",
  via
});
const fromCatalog = <T>(value: T): Fact<T> => ({
  value,
  source: "catalog",
  via: "справочник моделей"
});

test("the device beats a manual value, and the overruled one is reported", () => {
  const specs = resolvePrinterSpecs(
    declared({ nozzleDiameterMm: 0.6 }),
    discovered({ nozzleDiameterMm: fromPrinter(0.4, "MQTT print.nozzle_diameter") })
  );

  assert.equal(specs.nozzleDiameterMm.value, 0.4);
  assert.equal(specs.nozzleDiameterMm.source, "printer");
  assert.equal(specs.nozzleDiameterMm.via, "MQTT print.nozzle_diameter");
  assert.equal(specs.nozzleDiameterMm.observedAt, PROBED_AT);
  // The operator's value is not silently dropped — the card shows it as a
  // conflict, which is how a physical nozzle swap gets noticed.
  assert.equal(specs.nozzleDiameterMm.overriddenManual, 0.6);
});

test("a manual value that AGREES with the device raises no conflict", () => {
  const specs = resolvePrinterSpecs(
    declared({ nozzleDiameterMm: 0.4 }),
    discovered({ nozzleDiameterMm: fromPrinter(0.4) })
  );

  assert.equal(specs.nozzleDiameterMm.source, "printer");
  assert.equal(specs.nozzleDiameterMm.overriddenManual, null);
});

test("with the device silent, the manual value stands and is tagged manual", () => {
  const specs = resolvePrinterSpecs(declared({ nozzleType: "hardened_steel" }), null);

  assert.equal(specs.nozzleType.value, "hardened_steel");
  assert.equal(specs.nozzleType.source, "manual");
  assert.equal(specs.nozzleType.observedAt, EDITED_AT);
  assert.equal(specs.nozzleType.overriddenManual, null);
});

test("the operator outranks the catalogue, which is kept as a hint", () => {
  // The catalogue only knows the model; the operator has seen this machine. So
  // a bed the operator declared wins — but the model's figure stays visible so
  // an honest mistake is still noticeable.
  const specs = resolvePrinterSpecs(
    declared({ buildVolume: { x: 250, y: 250, z: 250 } }),
    discovered({ buildVolume: fromCatalog({ x: 256, y: 256, z: 256 }) })
  );

  assert.deepEqual(specs.buildVolume.value, { x: 250, y: 250, z: 250 });
  assert.equal(specs.buildVolume.source, "manual");
  assert.deepEqual(specs.buildVolume.catalogHint, { x: 256, y: 256, z: 256 });
});

test("a catalogue value agreeing with the manual one raises no hint", () => {
  const specs = resolvePrinterSpecs(
    declared({ buildVolume: { x: 256, y: 256, z: 256 } }),
    discovered({ buildVolume: fromCatalog({ x: 256, y: 256, z: 256 }) })
  );

  assert.equal(specs.buildVolume.source, "manual");
  assert.equal(specs.buildVolume.catalogHint, null);
});

test("with nothing declared, the catalogue answers and says so", () => {
  const specs = resolvePrinterSpecs(
    declared(),
    discovered({ buildVolume: fromCatalog({ x: 180, y: 180, z: 180 }) })
  );

  assert.deepEqual(specs.buildVolume.value, { x: 180, y: 180, z: 180 });
  assert.equal(specs.buildVolume.source, "catalog");
  assert.equal(specs.buildVolume.via, "справочник моделей");
});

test("the device outranks the catalogue too", () => {
  const specs = resolvePrinterSpecs(
    declared(),
    discovered({
      // Klipper reports its real axis limits; a catalogue entry would be the
      // model's nominal figure. Both can be present, and the device wins.
      buildVolume: fromPrinter(
        { x: 350, y: 350, z: 345 },
        "configfile.settings.stepper_{x,y,z}.position_max"
      )
    })
  );

  assert.deepEqual(specs.buildVolume.value, { x: 350, y: 350, z: 345 });
  assert.equal(specs.buildVolume.source, "printer");
});

test("nothing known stays unknown — no value is invented", () => {
  const specs = resolvePrinterSpecs(declared(), null);

  for (const spec of [specs.nozzleDiameterMm, specs.nozzleType, specs.buildVolume, specs.ams]) {
    assert.equal(spec.value, null);
    assert.equal(spec.source, "unknown");
    assert.equal(spec.via, null);
    assert.equal(spec.observedAt, null);
  }
});

test("«материал» resolves from the ACTIVE slot only", () => {
  const specs = resolvePrinterSpecs(
    declared({ material: "PLA" }),
    discovered({
      materials: fromPrinter(
        [
          { slot: 0, material: "PETG", color: "#112233", remainPct: 80, active: false },
          { slot: 1, material: "ABS", color: null, remainPct: 40, active: true }
        ],
        "MQTT print.ams"
      )
    })
  );

  assert.equal(specs.material.value, "ABS", "the feeding slot, not the first loaded one");
  assert.equal(specs.material.source, "printer");
  assert.equal(specs.material.overriddenManual, "PLA");
});

test("loaded slots with none feeding leave the declared material in place", () => {
  const specs = resolvePrinterSpecs(
    declared({ material: "PLA" }),
    discovered({
      materials: fromPrinter([
        { slot: 0, material: "PETG", color: null, remainPct: 80, active: false }
      ])
    })
  );

  assert.equal(specs.material.value, "PLA");
  assert.equal(specs.material.source, "manual");
});

test("an empty string in a declared field reads as absent, not as a value", () => {
  const specs = resolvePrinterSpecs(declared({ model: "   ", nozzleType: "" }), null);

  assert.equal(specs.model.source, "unknown");
  assert.equal(specs.nozzleType.source, "unknown");
});

test("a failed probe keeps the last known facts in force", () => {
  // The service preserves the facts on failure; the resolver must not treat the
  // failure flag as a reason to distrust them.
  const specs = resolvePrinterSpecs(
    declared(),
    discovered(
      { nozzleType: fromPrinter("hardened_steel", "MQTT print.nozzle_type") },
      { succeeded: false, error: "таймаут" }
    )
  );

  assert.equal(specs.nozzleType.value, "hardened_steel");
  assert.equal(specs.nozzleType.source, "printer");
});

// ── withLiveReading ──────────────────────────────────────────────────────────

test("a live reading overlays the resolution and re-checks the manual conflict", () => {
  const base = resolvePrinterSpecs(declared({ nozzleDiameterMm: 0.6 }), null);
  assert.equal(base.nozzleDiameterMm.source, "manual");

  const live = withLiveReading(base.nozzleDiameterMm, 0.4, "телеметрия", PROBED_AT);
  assert.equal(live.value, 0.4);
  assert.equal(live.source, "printer");
  assert.equal(live.overriddenManual, 0.6, "the manual value that just lost is surfaced");
});

test("a live reading matching the manual value clears the conflict", () => {
  const base = resolvePrinterSpecs(declared({ nozzleDiameterMm: 0.4 }), null);
  const live = withLiveReading(base.nozzleDiameterMm, 0.4, "телеметрия", PROBED_AT);

  assert.equal(live.source, "printer");
  assert.equal(live.overriddenManual, null);
});

test("no live reading leaves the resolution untouched", () => {
  const base = resolvePrinterSpecs(declared({ nozzleDiameterMm: 0.4 }), null);
  assert.deepEqual(withLiveReading(base.nozzleDiameterMm, null, "телеметрия", null), base.nozzleDiameterMm);
});

test("a live reading carries forward a manual value the stored fact had already overruled", () => {
  const base = resolvePrinterSpecs(
    declared({ nozzleDiameterMm: 0.6 }),
    discovered({ nozzleDiameterMm: fromPrinter(0.4) })
  );
  const live = withLiveReading(base.nozzleDiameterMm, 0.4, "телеметрия", PROBED_AT);

  assert.equal(live.overriddenManual, 0.6);
});
