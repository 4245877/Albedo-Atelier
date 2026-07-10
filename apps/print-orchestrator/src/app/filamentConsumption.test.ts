import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import type { AmsTraySnapshot, PrinterLiveStatus } from "../infra/printers/status/types";
import { EventFeed } from "./eventFeed";
import {
  buildConsumeItems,
  FilamentConsumption,
  type InventoryConsumer
} from "./filamentConsumption";

/*
 * Direct unit tests for the completion→deduction mapping. `buildConsumeItems`
 * is pure (no HTTP, no poller); the FilamentConsumption class is exercised with
 * a recording consumer. The end-to-end path through the poll loop stays in
 * printerPoller.consume.test.ts.
 */

function printer(over: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    id: "a1",
    name: "Bambu A1",
    model: "A1 Combo",
    type: "FDM",
    protocol: "bambu",
    host: "127.0.0.1",
    port: 8883,
    material: "",
    swatch: "",
    snapshotUrl: "",
    streamUrl: "",
    enabled: true,
    apiKey: "",
    serial: "SN",
    accessCode: "AC",
    light: {
      enabled: false,
      pin: "",
      invert: false,
      onGcode: "",
      offGcode: "",
      statusObject: "",
      statusField: "value",
      bambuNode: "chamber_light"
    },
    ...over
  };
}

function status(over: Partial<PrinterLiveStatus> = {}): PrinterLiveStatus {
  return {
    id: "a1",
    online: true,
    status: "idle",
    currentFile: "model.3mf",
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
    ...over
  };
}

function tray(t: number, remainPct: number | null, over: Partial<AmsTraySnapshot> = {}): AmsTraySnapshot {
  return {
    tray: t,
    material: over.material ?? "PLA",
    color: over.color ?? "#FF0000",
    remainPct,
    nominalWeightG: over.nominalWeightG ?? 1000,
    active: over.active ?? false
  };
}

test("buildConsumeItems: Bambu maps per-tray remain drops to gram items", () => {
  const items = buildConsumeItems(
    printer(),
    status(),
    status({ amsTrays: [tray(0, 88), tray(1, 40, { material: "PETG", nominalWeightG: 250 })] }),
    [tray(0, 100), tray(1, 60, { material: "PETG", nominalWeightG: 250 })]
  );
  assert.deepEqual(items, [
    { kind: "grams", grams: 120, amsTray: 0, material: "PLA", color: "#FF0000" },
    { kind: "grams", grams: 50, amsTray: 1, material: "PETG", color: "#FF0000" }
  ]);
});

test("buildConsumeItems: Bambu with no start snapshot yields nothing (never invented)", () => {
  const items = buildConsumeItems(printer(), status(), status({ amsTrays: [tray(0, 80)] }), null);
  assert.deepEqual(items, []);
});

test("buildConsumeItems: Moonraker maps the extruded length to one length item", () => {
  const k2 = printer({ id: "k2", protocol: "moonraker" });
  const items = buildConsumeItems(k2, status(), status({ filamentUsedMm: 1234 }), null);
  assert.deepEqual(items, [{ kind: "length", lengthMm: 1234 }]);
});

test("buildConsumeItems: Moonraker falls back to the previous poll's length", () => {
  const k2 = printer({ id: "k2", protocol: "moonraker" });
  const items = buildConsumeItems(k2, status({ filamentUsedMm: 987 }), status(), null);
  assert.deepEqual(items, [{ kind: "length", lengthMm: 987 }]);
});

test("buildConsumeItems: Moonraker with no reported length yields nothing", () => {
  const k2 = printer({ id: "k2", protocol: "moonraker" });
  assert.deepEqual(buildConsumeItems(k2, status(), status(), null), []);
  assert.deepEqual(buildConsumeItems(k2, status(), status({ filamentUsedMm: 0 }), null), []);
});

function recordingInventory(behaviour: { fail?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const client: InventoryConsumer = {
    enabled: true,
    consume: async (input) => {
      calls.push(input as Record<string, unknown>);
      if (behaviour.fail) throw new Error("нет загруженного филамента");
      return {};
    }
  };
  return { calls, client };
}

test("consumeForPrint dispatches one call per item with per-tray idempotency keys", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());

  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(0, 80), tray(1, 50, { nominalWeightG: 500 })] }),
    { printId: "run-1", amsStart: [tray(0, 100), tray(1, 60, { nominalWeightG: 500 })] },
    "model.3mf"
  );
  await new Promise((resolve) => setImmediate(resolve)); // let the fire-and-forget settle

  assert.equal(inventory.calls.length, 2);
  assert.equal(inventory.calls[0].idempotencyKey, "a1:run-1:t0");
  assert.equal(inventory.calls[1].idempotencyKey, "a1:run-1:t1");
  assert.equal(inventory.calls[0].printJobId, "run-1");
  assert.equal(inventory.calls[0].note, "Печать «model.3mf»");
});

test("consumeForPrint is a no-op without an enabled inventory client", async () => {
  const disabled = new FilamentConsumption(undefined, new EventFeed());
  // Would throw on `.consume` if it tried to dispatch — it must not.
  disabled.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(0, 80)] }),
    { printId: "run-1", amsStart: [tray(0, 100)] },
    null
  );
});

test("a dispatch failure surfaces as one soft feed warning, never a throw", async () => {
  const inventory = recordingInventory({ fail: true });
  const events = new EventFeed();
  const consumption = new FilamentConsumption(inventory.client, events);

  consumption.consumeForPrint(
    printer({ id: "k2", protocol: "moonraker" }),
    status(),
    status({ filamentUsedMm: 500 }),
    { printId: "run-9", amsStart: null },
    "vase.gcode"
  );
  await new Promise((resolve) => setImmediate(resolve));

  const feed = events.list().map((event) => event.text).join("\n");
  assert.match(feed, /склад — нет загруженного филамента/);
});

test("Bambu completion with unmeasurable trays warns once that deduction was skipped", () => {
  const inventory = recordingInventory();
  const events = new EventFeed();
  const consumption = new FilamentConsumption(inventory.client, events);

  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(0, null)] }), // uncalibrated: remain unknown
    { printId: "run-2", amsStart: [tray(0, null)] },
    "model.3mf"
  );

  assert.equal(inventory.calls.length, 0);
  const feed = events.list().map((event) => event.text).join("\n");
  assert.match(feed, /нет данных о расходе филамента/);
});
