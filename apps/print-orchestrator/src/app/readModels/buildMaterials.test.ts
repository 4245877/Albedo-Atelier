import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueueJob } from "../../domain/dashboard/types";
import type { PrinterConfig } from "../../infra/printers/config";
import type { FilamentStockView } from "../filamentStock";
import { buildMaterials, formatGrams, swatchFor } from "./buildMaterials";

/*
 * The «Материалы» projection. The card's whole job is to be truthful about a
 * warehouse that lives in ANOTHER service, so the tests are about the seams:
 * whose thresholds decide "low", what happens to queue demand when the shelf
 * cannot be read, and which bindings belong on this farm's board.
 */

function view(over: Partial<FilamentStockView> = {}): FilamentStockView {
  return {
    connected: true,
    ok: true,
    pending: false,
    stale: false,
    fetchedAt: "2026-08-17T12:00:00.000Z",
    error: null,
    totalG: 10_469,
    reelsInUse: 1,
    positions: [
      {
        id: "s1",
        material: "PETG",
        color: "black",
        colorName: "Чорний",
        label: "PETG Чорний",
        stockG: 9469,
        lowStockG: 1000,
        criticalStockG: 300,
        status: "ok"
      },
      {
        id: "s2",
        material: "TPU",
        color: "black",
        colorName: "Чорний",
        label: "TPU Чорний",
        stockG: 0,
        lowStockG: 1000,
        criticalStockG: 300,
        status: "critical"
      }
    ],
    reels: [
      {
        printerId: "k2",
        printerName: "K2 (снимок)",
        amsTray: null,
        stockId: "s1",
        material: "PETG",
        color: "black",
        updatedAt: "2026-07-13T14:11:05.266Z"
      }
    ],
    ...over
  };
}

function job(over: Partial<QueueJob> = {}): QueueJob {
  return {
    id: "j1",
    title: "Кронштейн",
    printer: "k2",
    material: "PETG",
    eta: "3 ч",
    status: "ready",
    ...over
  };
}

const K2 = { id: "k2", name: "Creality K2", material: "PETG" } as unknown as PrinterConfig;

function deps(over: Partial<Parameters<typeof buildMaterials>[0]> = {}) {
  return {
    stock: view(),
    queue: [] as QueueJob[],
    resolvePrinter: (reference: string) => (reference === "k2" ? K2 : undefined),
    printers: [K2],
    ...over
  };
}

test("a position's level is scaled by ITS OWN low threshold, and coloured by the warehouse verdict", () => {
  const materials = buildMaterials(deps());

  const petg = materials.filament[0];
  assert.equal(petg.name, "PETG Чорний");
  assert.equal(petg.have, 9.47);
  assert.equal(petg.unit, "кг");
  assert.equal(petg.full, 1, "the bar's 100% is the position's own low-stock threshold");
  assert.equal(petg.status, "ok");
  assert.equal(petg.low, false);
  assert.equal(petg.grams, 9469);

  const tpu = materials.filament[1];
  assert.equal(tpu.status, "critical", "the verdict comes from the warehouse, not from a local fraction");
  assert.equal(tpu.low, true);
});

test("resin stays empty — the warehouse tracks none, and a zeroed row would read as 'we have none'", () => {
  assert.deepEqual(buildMaterials(deps()).resin, []);
});

test("an unconfigured warehouse reports source.kind 'none', not an empty shelf", () => {
  const materials = buildMaterials(
    deps({ stock: view({ connected: false, ok: false, positions: [], reels: [] }) })
  );

  assert.equal(materials.source.kind, "none");
  assert.equal(materials.source.ok, false);
  assert.deepEqual(materials.filament, []);
});

test("an outage is reported as such, with the last balances kept and the reason named", () => {
  const materials = buildMaterials(
    deps({ stock: view({ ok: false, stale: true, error: "склад вернул 502" }) })
  );

  assert.equal(materials.source.kind, "fulfillment");
  assert.equal(materials.source.ok, false);
  assert.equal(materials.source.stale, true);
  assert.equal(materials.source.error, "склад вернул 502");
  assert.equal(materials.filament.length, 2, "the last known balances are still shown");
});

test("queue demand is summed per material and compared with the whole shelf of that material", () => {
  const materials = buildMaterials(
    deps({ queue: [job({ filamentG: 200 }), job({ id: "j2", filamentG: 140 })] })
  );

  assert.equal(materials.queueNeeds.length, 1);
  assert.equal(materials.queueNeeds[0].status, "ok");
  assert.match(materials.queueNeeds[0].text, /PETG — нужно 340 г/);
  assert.match(materials.queueNeeds[0].text, /на складе 9\.5 кг/);
});

test("demand above the shelf is a warning", () => {
  const materials = buildMaterials(deps({ queue: [job({ material: "TPU", filamentG: 120 })] }));

  assert.equal(materials.queueNeeds[0].status, "warn");
  assert.match(materials.queueNeeds[0].text, /на складе 0 г/);
});

test("a material with no position at all is a warning of its own", () => {
  const materials = buildMaterials(deps({ queue: [job({ material: "ABS", filamentG: 120 })] }));

  assert.equal(materials.queueNeeds[0].status, "warn");
  assert.match(materials.queueNeeds[0].text, /позиции на складе нет/);
});

test("jobs with no measured weight are counted and stated, never silently ignored", () => {
  const materials = buildMaterials(
    deps({ queue: [job({ filamentG: 200 }), job({ id: "j2" }), job({ id: "j3" })] })
  );

  assert.match(materials.queueNeeds[0].text, /нужно 200 г \(\+2 без оценки\)/);
});

test("only committed (ready) jobs count as demand", () => {
  const materials = buildMaterials(
    deps({ queue: [job({ status: "review", filamentG: 200 }), job({ id: "j2", status: "unconfirmed", filamentG: 90 })] })
  );

  assert.deepEqual(materials.queueNeeds, []);
});

test("with an unreadable warehouse, demand is reported alone — no shortage and no all-clear is claimed", () => {
  const materials = buildMaterials(
    deps({
      stock: view({ ok: false, error: "склад вернул 502" }),
      queue: [job({ material: "TPU", filamentG: 5000 })]
    })
  );

  assert.equal(materials.queueNeeds[0].status, "ok", "a shortage cannot be asserted against unknown stock");
  assert.doesNotMatch(materials.queueNeeds[0].text, /на складе/);
});

test("reel bindings are named from the live config and drop printers this farm does not have", () => {
  const materials = buildMaterials(
    deps({
      stock: view({
        reels: [
          {
            printerId: "k2",
            printerName: "K2 (снимок)",
            amsTray: 1,
            stockId: "s1",
            material: "PETG",
            color: "black",
            updatedAt: "2026-07-13T14:11:05.266Z"
          },
          {
            printerId: "deleted-printer",
            printerName: "Проданный A1",
            amsTray: null,
            stockId: "s2",
            material: "TPU",
            color: "black",
            updatedAt: "2026-07-13T14:11:05.266Z"
          }
        ]
      })
    })
  );

  assert.equal(materials.loaded.length, 1);
  assert.equal(materials.loaded[0].printer, "Creality K2", "the live name wins over the warehouse snapshot");
  assert.equal(materials.loaded[0].slot, "AMS-слот 1");
  assert.equal(materials.loaded[0].colorName, "Чорний", "the localized name comes from the bound position");
});

test("a material contradiction is local knowledge and survives a warehouse outage", () => {
  const materials = buildMaterials(
    deps({
      stock: view({ connected: false, ok: false, positions: [], reels: [] }),
      queue: [job({ material: "ABS" })]
    })
  );

  assert.equal(materials.mismatch.length, 1);
  assert.equal(materials.mismatch[0].needs, "ABS");
  assert.equal(materials.mismatch[0].loaded, "PETG");
});

test("swatchFor passes a stored hex through and never guesses a colour it does not know", () => {
  assert.equal(swatchFor("#a1b2c3"), "#a1b2c3");
  assert.equal(swatchFor("a1b2c3"), "#a1b2c3");
  assert.equal(swatchFor("yellow"), "#e0c04a");
  assert.equal(swatchFor("хамелеон"), swatchFor(""), "an unknown name falls back to the neutral swatch");
});

test("formatGrams speaks grams under a kilo and kilos above it", () => {
  assert.equal(formatGrams(340), "340 г");
  assert.equal(formatGrams(999), "999 г");
  assert.equal(formatGrams(1000), "1.0 кг");
  assert.equal(formatGrams(9469), "9.5 кг");
});
