import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import { FulfillmentError } from "../infra/fulfillment/inventoryClient";
import type { AmsTraySnapshot, PrinterLiveStatus } from "../infra/printers/status/types";
import { EventFeed } from "./eventFeed";
import {
  buildConsumeItems,
  FilamentConsumption,
  type InventoryConsumer,
  type PendingConsume
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

// ── Retry queue (unreachable fulfillment) ─────────────────────────────────

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A consumer that fails `failures` times with the given error, then succeeds. */
function flakyInventory(failures: number, error: () => Error) {
  const calls: Array<Record<string, unknown>> = [];
  let remaining = failures;
  const client: InventoryConsumer = {
    enabled: true,
    consume: async (input) => {
      calls.push(input as Record<string, unknown>);
      if (remaining > 0) {
        remaining -= 1;
        throw error();
      }
      return {};
    }
  };
  return { calls, client };
}

test("an unreachable fulfillment queues the deduction and a later retry delivers it", async () => {
  const inventory = flakyInventory(1, () => new FulfillmentError("склад недоступен", "unreachable"));
  const events = new EventFeed();
  let persisted = 0;
  const consumption = new FilamentConsumption(inventory.client, events, () => {
    persisted += 1;
  });

  consumption.consumeForPrint(
    printer({ id: "k2", protocol: "moonraker" }),
    status(),
    status({ filamentUsedMm: 500 }),
    { printId: "run-1", amsStart: null },
    "vase.gcode"
  );
  await flush();

  assert.equal(consumption.pendingCount, 1, "the failed delivery is owed, not lost");
  assert.ok(persisted >= 1, "the queue change is persisted");
  assert.match(feed(events), /будет повторено автоматически/);

  // Not due yet: the first retry is scheduled with a backoff delay.
  await consumption.retryPending();
  assert.equal(inventory.calls.length, 1, "no redelivery before the backoff elapses");

  // Force the entry due (the queue is intentionally reachable via serialize).
  consumption.serialize()[0].nextAttemptAtMs = 0;
  await consumption.retryPending();

  assert.equal(inventory.calls.length, 2, "one redelivery once due");
  assert.equal(consumption.pendingCount, 0);
  assert.equal(inventory.calls[1].idempotencyKey, inventory.calls[0].idempotencyKey, "same key → dedupable");
  assert.match(feed(events), /отложенное списание выполнено/);
});

test("a rejected deduction is warned and dropped — never queued for retry", async () => {
  const inventory = flakyInventory(99, () => new FulfillmentError("нет загруженного филамента", "rejected"));
  const events = new EventFeed();
  const consumption = new FilamentConsumption(inventory.client, events);

  consumption.consumeForPrint(
    printer({ id: "k2", protocol: "moonraker" }),
    status(),
    status({ filamentUsedMm: 500 }),
    { printId: "run-2", amsStart: null },
    "vase.gcode"
  );
  await flush();

  assert.equal(consumption.pendingCount, 0, "a permanent rejection is not retried");
  assert.match(feed(events), /нет загруженного филамента/);
});

test("a retry that ends in rejection drops the entry with a warning", async () => {
  const inventory = flakyInventory(99, () => new FulfillmentError("недостаточно остатка", "rejected"));
  const events = new EventFeed();
  const pending: PendingConsume[] = [
    {
      input: { printerId: "k2", lengthMm: 500, printJobId: "run-3", idempotencyKey: "k2:run-3" },
      printerName: "Creality K2",
      attempts: 1,
      nextAttemptAtMs: 0,
      firstFailedAtMs: Date.now()
    }
  ];
  const consumption = new FilamentConsumption(inventory.client, events, () => {}, pending);

  await consumption.retryPending();

  assert.equal(consumption.pendingCount, 0);
  assert.match(feed(events), /недостаточно остатка/);
});

test("a persisted (restored) pending deduction is redelivered after a restart", async () => {
  const inventory = flakyInventory(0, () => new Error("unused"));
  const events = new EventFeed();
  const pending: PendingConsume[] = [
    {
      input: {
        printerId: "a1",
        grams: 120,
        amsTray: 0,
        material: "PLA",
        printJobId: "run-4",
        idempotencyKey: "a1:run-4:t0",
        note: "Печать «model.3mf»"
      },
      printerName: "Bambu A1",
      attempts: 3,
      nextAttemptAtMs: 0,
      firstFailedAtMs: Date.now()
    }
  ];
  const consumption = new FilamentConsumption(inventory.client, events, () => {}, pending);

  await consumption.retryPending();

  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].idempotencyKey, "a1:run-4:t0", "the original key survives the restart");
  assert.equal(consumption.pendingCount, 0);
});

test("repeated unreachable retries back off and keep the entry", async () => {
  const inventory = flakyInventory(99, () => new FulfillmentError("таймаут", "unreachable"));
  const events = new EventFeed();
  const pending: PendingConsume[] = [
    {
      input: { printerId: "k2", lengthMm: 500, printJobId: "run-5", idempotencyKey: "k2:run-5" },
      printerName: "Creality K2",
      attempts: 1,
      nextAttemptAtMs: 0,
      firstFailedAtMs: Date.now()
    }
  ];
  const consumption = new FilamentConsumption(inventory.client, events, () => {}, pending);

  await consumption.retryPending();

  assert.equal(consumption.pendingCount, 1, "still owed");
  const entry = consumption.serialize()[0];
  assert.equal(entry.attempts, 2);
  assert.ok(entry.nextAttemptAtMs > Date.now(), "backed off into the future");
  assert.doesNotMatch(feed(events), /таймаут/, "repeat failures do not spam the feed");
});

test("an entry older than the give-up age is dropped loudly", async () => {
  const inventory = flakyInventory(99, () => new FulfillmentError("таймаут", "unreachable"));
  const events = new EventFeed();
  const pending: PendingConsume[] = [
    {
      input: { printerId: "k2", lengthMm: 500, printJobId: "run-6", idempotencyKey: "k2:run-6" },
      printerName: "Creality K2",
      attempts: 50,
      nextAttemptAtMs: 0,
      firstFailedAtMs: Date.now() - 8 * 24 * 60 * 60 * 1000 // 8 days ago
    }
  ];
  const consumption = new FilamentConsumption(inventory.client, events, () => {}, pending);

  await consumption.retryPending();

  assert.equal(consumption.pendingCount, 0, "expired entry is not retried forever");
  assert.match(feed(events), /отброшено/);
});

function feed(events: EventFeed): string {
  return events
    .list()
    .map((event) => event.text)
    .join("\n");
}

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
