import assert from "node:assert/strict";
import { test } from "node:test";

import { FulfillmentError } from "../infra/fulfillment/inventoryClient";
import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status/types";
import { EventFeed } from "./eventFeed";
import {
  FilamentConsumption,
  type ConsumePayload,
  type InventoryConsumer,
  type UnreconciledConsume
} from "./filamentConsumption";

/*
 * The unreconciled-debt ledger: what happens to a deduction the warehouse
 * measured but never applied.
 *
 * The behaviour under test is the one the accounting actually depends on — a
 * REJECTED deduction (no loaded reel, not enough stock, an archived position)
 * used to be dropped after a single feed line, while the sub-gram carry had
 * already been zeroed for it. The grams simply vanished, and once a position
 * hit zero on the shelf every subsequent print on that printer vanished the
 * same way. These tests pin the debt down instead: durable, measured, settleable.
 */

function k2(over: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    id: "k2",
    name: "Creality K2",
    model: "Creality K2",
    type: "FDM",
    protocol: "moonraker",
    host: "127.0.0.1",
    port: 4408,
    material: "PETG",
    swatch: "",
    snapshotUrl: "",
    streamUrl: "",
    interfaceUrl: "",
    enabled: true,
    apiKey: "",
    serial: "",
    accessCode: "",
    light: {
      enabled: false,
      pin: "",
      invert: false,
      onGcode: "",
      offGcode: "",
      statusObject: "",
      statusField: "value",
      bambuNode: ""
    },
    ...over
  };
}

function status(over: Partial<PrinterLiveStatus> = {}): PrinterLiveStatus {
  return {
    id: "k2",
    online: true,
    status: "idle",
    currentFile: "vase.gcode",
    progressPct: null,
    remainingMinutes: null,
    filamentUsedMm: null,
    slicerFilamentG: null,
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
    faults: [],
    mediaPresent: null,
    error: null,
    updatedAt: new Date().toISOString(),
    ...over
  };
}

/** A client that refuses the way fulfillment refuses: reached, and said no. */
function rejectingInventory(message = "нет загруженного филамента") {
  const calls: ConsumePayload[] = [];
  const client: InventoryConsumer = {
    enabled: true,
    consume: async (input) => {
      calls.push(input);
      throw new FulfillmentError(message, "rejected");
    }
  };
  return { calls, client };
}

/** A client that refuses N times, then accepts — the "operator fixed it" shape. */
function healingInventory(failures: number) {
  const calls: ConsumePayload[] = [];
  let remaining = failures;
  const client: InventoryConsumer = {
    enabled: true,
    consume: async (input) => {
      calls.push(input);
      if (remaining > 0) {
        remaining -= 1;
        throw new FulfillmentError("недостаточно филамента на складе", "rejected");
      }
      return { duplicate: false, appliedG: 5 };
    }
  };
  return { calls, client };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function rejectedDebt(): Promise<{
  consumption: FilamentConsumption;
  saves: number[];
  debts: UnreconciledConsume[];
}> {
  const inventory = rejectingInventory();
  let saves = 0;
  const consumption = new FilamentConsumption(inventory.client, new EventFeed(), () => {
    saves += 1;
  });

  consumption.consumeForPrint(
    k2(),
    status(),
    status({ filamentUsedMm: 1450 }),
    { printId: "run-7", amsStart: null },
    "vase.gcode"
  );
  await settle();

  return { consumption, saves: [saves], debts: consumption.listUnreconciled() };
}

test("a REJECTED deduction becomes a durable debt instead of vanishing", async () => {
  const { debts } = await rejectedDebt();

  assert.equal(debts.length, 1, "the measured grams must not disappear on a refusal");
  const debt = debts[0];
  assert.equal(debt.printerId, "k2");
  assert.equal(debt.job, "vase.gcode");
  assert.match(debt.reason, /нет загруженного филамента/);
  // The quantity is an OBSERVATION, so it is recorded as measured — not as the
  // slicer estimate, which may never be deducted without a human.
  assert.deepEqual(debt.measured, { lengthMm: 1450 });
  assert.equal(debt.estimatedGrams, null);
});

test("a rejected debt keeps the original payload, key included, so settling cannot double-deduct", async () => {
  const { debts } = await rejectedDebt();
  const payload = debts[0].payload;

  assert.ok(payload, "the debt must carry the delivery it owed");
  assert.equal(payload.idempotencyKey, "k2:run-7");
  assert.equal(payload.lengthMm, 1450);
  assert.equal(payload.printJobId, "run-7");
});

test("recording a debt persists it — durability never depends on a later unrelated save", async () => {
  const inventory = rejectingInventory();
  let saves = 0;
  const consumption = new FilamentConsumption(inventory.client, new EventFeed(), () => {
    saves += 1;
  });
  const before = saves;

  consumption.consumeForPrint(
    k2(),
    status(),
    status({ filamentUsedMm: 1450 }),
    { printId: "run-7", amsStart: null },
    "vase.gcode"
  );
  await settle();

  assert.ok(saves > before, "the debt must schedule a state save itself");
});

test("settling a debt re-posts the original deduction and clears it", async () => {
  const inventory = healingInventory(1);
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());

  consumption.consumeForPrint(
    k2(),
    status(),
    status({ filamentUsedMm: 1450 }),
    { printId: "run-7", amsStart: null },
    "vase.gcode"
  );
  await settle();

  const debt = consumption.listUnreconciled()[0];
  assert.ok(debt, "the refusal left a debt");

  const result = await consumption.settleUnreconciled(debt.id);

  assert.equal(result.settled, true);
  assert.equal(consumption.listUnreconciled().length, 0, "a settled debt is gone");
  assert.equal(inventory.calls.length, 2, "the deduction was re-posted");
  assert.equal(
    inventory.calls[1].idempotencyKey,
    inventory.calls[0].idempotencyKey,
    "settling reuses the ORIGINAL key, so a delivery that had landed cannot be applied twice"
  );
});

test("a failed settlement leaves the debt standing with the new reason", async () => {
  const inventory = rejectingInventory("позиция склада архивирована");
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());

  consumption.consumeForPrint(
    k2(),
    status(),
    status({ filamentUsedMm: 1450 }),
    { printId: "run-7", amsStart: null },
    "vase.gcode"
  );
  await settle();

  const debt = consumption.listUnreconciled()[0];
  const result = await consumption.settleUnreconciled(debt.id);

  assert.equal(result.settled, false);
  assert.match(result.reason ?? "", /архивирован/);
  assert.equal(
    consumption.listUnreconciled().length,
    1,
    "a debt that disappears on a failed settlement is exactly the drift this prevents"
  );
});

test("a debt with nothing measured cannot be settled automatically", async () => {
  const inventory = healingInventory(0);
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());

  // Nothing measurable: the device reported no length at all.
  consumption.consumeForPrint(
    k2(),
    status(),
    status({ filamentUsedMm: null }),
    { printId: "run-8", amsStart: null, estimatedGrams: 39.4 },
    "vase.gcode"
  );
  await settle();

  const debt = consumption.listUnreconciled()[0];
  assert.equal(debt.measured, null);
  assert.equal(debt.payload, null);
  assert.equal(debt.estimatedGrams, 39.4, "the slicer figure rides along as an orientation");

  const result = await consumption.settleUnreconciled(debt.id);
  assert.equal(result.settled, false, "an estimate must never become a deduction on its own");
  assert.equal(inventory.calls.length, 0, "nothing is posted for an unmeasured debt");
});

test("acknowledging a debt persists the acknowledgement", async () => {
  const inventory = rejectingInventory();
  let saves = 0;
  const consumption = new FilamentConsumption(inventory.client, new EventFeed(), () => {
    saves += 1;
  });

  consumption.consumeForPrint(
    k2(),
    status(),
    status({ filamentUsedMm: 1450 }),
    { printId: "run-7", amsStart: null },
    "vase.gcode"
  );
  await settle();

  const debt = consumption.listUnreconciled()[0];
  const before = saves;
  assert.equal(consumption.clearUnreconciled(debt.id), true);
  assert.ok(saves > before, "a restart must not resurrect a debt the operator wrote off");
  assert.equal(consumption.clearUnreconciled(debt.id), false, "clearing twice is not a save");
});

test("an expired queue entry becomes a debt rather than only a reset-on-restart counter", async () => {
  const unreachable: InventoryConsumer = {
    enabled: true,
    consume: async () => {
      throw new FulfillmentError("склад недоступен", "unreachable");
    }
  };
  let now = 1_000_000;
  const consumption = new FilamentConsumption(
    unreachable,
    new EventFeed(),
    () => {},
    [],
    { maxAgeMs: 1000, now: () => now }
  );

  consumption.consumeForPrint(
    k2(),
    status(),
    status({ filamentUsedMm: 1450 }),
    { printId: "run-7", amsStart: null },
    "vase.gcode"
  );
  await settle();
  assert.equal(consumption.pendingCount, 1, "an unreachable warehouse queues the deduction");

  now += 120_000; // past both the first backoff (60 s) and the give-up age
  await consumption.retryPending();

  assert.equal(consumption.pendingCount, 0, "the entry was given up on");
  const debts = consumption.listUnreconciled();
  assert.equal(debts.length, 1, "giving up must leave an owed deduction behind");
  assert.deepEqual(debts[0].measured, { lengthMm: 1450 });
  assert.equal(debts[0].payload?.idempotencyKey, "k2:run-7");
  assert.equal(consumption.metrics().dropped.expired, 1);
});

test("an unmeasured debt settles on an operator-stated figure, once", async () => {
  // The A1's external spool reports no tray_weight, so nothing can measure its
  // prints. A person naming the number is the only honest way to move the shelf.
  const inventory = healingInventory(0);
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());

  consumption.consumeForPrint(
    k2({ id: "a1", name: "Bambu A1", protocol: "bambu" }),
    status({ id: "a1" }),
    status({ id: "a1" }),
    { printId: "run-9", amsStart: null, estimatedGrams: 39.45 },
    "clip.3mf"
  );
  await settle();

  const debt = consumption.listUnreconciled()[0];
  assert.equal(debt.payload, null, "there was nothing measured to re-post");

  const result = await consumption.settleUnreconciled(debt.id, 39.45);

  assert.equal(result.settled, true);
  assert.equal(consumption.listUnreconciled().length, 0);
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].grams, 39, "whole grams — the warehouse's unit");
  assert.equal(
    inventory.calls[0].idempotencyKey,
    `manual:${debt.id}`,
    "keyed on the debt, so a double-submit settles it exactly once"
  );
});

test("an operator figure below the warehouse's minimum unit is refused, not rounded to zero", async () => {
  const inventory = healingInventory(0);
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());

  consumption.consumeForPrint(
    k2({ id: "a1", protocol: "bambu" }),
    status({ id: "a1" }),
    status({ id: "a1" }),
    { printId: "run-9", amsStart: null },
    "clip.3mf"
  );
  await settle();
  const debt = consumption.listUnreconciled()[0];

  for (const bad of [0, 0.4, Number.NaN]) {
    const result = await consumption.settleUnreconciled(debt.id, bad);
    assert.equal(result.settled, false, `${bad} must not settle a debt`);
  }
  assert.equal(inventory.calls.length, 0);
  assert.equal(consumption.listUnreconciled().length, 1, "the debt still stands");
});
