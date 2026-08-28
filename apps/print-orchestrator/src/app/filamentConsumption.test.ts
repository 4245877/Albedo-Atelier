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
import { EXTERNAL_SPOOL_TRAY } from "../infra/printers/status/bambuUsage";

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
    interfaceUrl: "",
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
    faults: [],
    mediaPresent: null,
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
    // `??` would swallow an explicit null, and "this spool has no declared
    // weight" is exactly what the external-spool cases need to express.
    nominalWeightG: "nominalWeightG" in over ? (over.nominalWeightG ?? null) : 1000,
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

test("consumeForPrint skips an untracked print (no run) and warns to deduct by hand", async () => {
  // A Moonraker print already running at startup / revived across a restart has
  // no run identity: its reported length spans the whole job and a synthetic key
  // could collide same-day, under-deducting. It must skip auto-deduction (README
  // “Restart cost”), not deduct with a guessed key.
  const inventory = recordingInventory();
  const events = new EventFeed();
  const consumption = new FilamentConsumption(inventory.client, events);

  consumption.consumeForPrint(
    printer({ id: "k2", protocol: "moonraker" }),
    status(),
    status({ filamentUsedMm: 500 }),
    undefined,
    "vase.gcode"
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(inventory.calls.length, 0, "an untracked print never auto-deducts");
  assert.match(feed(events), /не отслеживалась/);
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

// ── Sub-gram carry (micro-consumption) ──────────────────────────────────────

test("a sub-gram Bambu consumption is carried, not sent — no movement, no key used", async () => {
  const inventory = recordingInventory();
  let persisted = 0;
  const consumption = new FilamentConsumption(inventory.client, new EventFeed(), () => {
    persisted += 1;
  });

  // 0.05 % of 1000 g = 0.5 g — below the 1 g minimum unit.
  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(0, 49.95)] }),
    { printId: "run-1", amsStart: [tray(0, 50)] },
    "tiny.3mf"
  );
  await flush();

  assert.equal(inventory.calls.length, 0, "nothing below the minimum unit is sent");
  assert.deepEqual(consumption.serializeCarry(), { "a1:t0": { grams: 0.5 } });
  assert.ok(persisted >= 1, "the carry survives via persistence");
});

test("the carry is folded into the next print's deduction exactly once", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed(), () => {}, [], {
    initialCarry: { "a1:t0": { grams: 0.5 } }
  });

  // Another 0.5 g print: 0.5 carried + 0.5 new = 1 g → sent.
  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(0, 49.95)] }),
    { printId: "run-2", amsStart: [tray(0, 50)] },
    "tiny.3mf"
  );
  await flush();

  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].grams, 1);
  assert.equal(inventory.calls[0].idempotencyKey, "a1:run-2:t0", "the key belongs to the real deduction");
  assert.deepEqual(consumption.serializeCarry(), {}, "the carry is zeroed once it rides in a payload");
});

test("a queued redelivery does not re-add the carried remainder", async () => {
  const inventory = flakyInventory(1, () => new FulfillmentError("склад недоступен", "unreachable"));
  const consumption = new FilamentConsumption(inventory.client, new EventFeed(), () => {}, [], {
    initialCarry: { "a1:t0": { grams: 0.7 } }
  });

  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(0, 49.94)] }), // 0.6 g + 0.7 carried = 1.3 g → send 1 g, carry 0.3 g
    { printId: "run-3", amsStart: [tray(0, 50)] },
    null
  );
  await flush();

  assert.equal(consumption.pendingCount, 1, "the combined payload is queued");
  const carryAfter = consumption.serializeCarry()["a1:t0"]?.grams ?? 0;
  assert.ok(Math.abs(carryAfter - 0.3) < 1e-6, "only the sub-gram remainder stays carried");

  consumption.serialize()[0].nextAttemptAtMs = 0;
  await consumption.retryPending();

  assert.equal(inventory.calls.length, 2);
  assert.equal(inventory.calls[1].grams, inventory.calls[0].grams, "redelivery retries the same amount");
  assert.equal(inventory.calls[1].grams, 1, "the integer part rode along exactly once");
});

test("grams are sent as WHOLE units; the fraction stays in the carry (no rounding drift)", async () => {
  // Contract with fulfillment: stock moves in whole grams, so the payload is
  // pre-normalized here — what is sent is exactly what fulfillment applies,
  // and the sub-gram tail keeps accumulating instead of being rounded away.
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());

  // 0.26 % of 1000 g = 2.6 g → send 2 g, carry 0.6 g.
  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(0, 49.74)] }),
    { printId: "run-a", amsStart: [tray(0, 50)] },
    null
  );
  await flush();

  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].grams, 2, "integer grams on the wire");
  const carried = consumption.serializeCarry()["a1:t0"]?.grams ?? 0;
  assert.ok(Math.abs(carried - 0.6) < 1e-6, "the 0.6 g tail is carried, not lost");

  // Next print: 0.5 g measured + 0.6 carried = 1.1 g → send 1 g, carry 0.1 g.
  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(0, 49.95)] }),
    { printId: "run-b", amsStart: [tray(0, 50)] },
    null
  );
  await flush();

  assert.equal(inventory.calls.length, 2);
  assert.equal(inventory.calls[1].grams, 1);
  const carried2 = consumption.serializeCarry()["a1:t0"]?.grams ?? 0;
  assert.ok(Math.abs(carried2 - 0.1) < 1e-6, "the remainder keeps accumulating across prints");
});

test("an exact whole-gram total leaves no phantom carry (float noise absorbed)", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed(), () => {}, [], {
    initialCarry: { "a1:t0": { grams: 0.4 } }
  });

  // 2.6 g measured + 0.4 carried = 3.0 g exactly → send 3 g, carry 0.
  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(0, 49.74)] }),
    { printId: "run-c", amsStart: [tray(0, 50)] },
    null
  );
  await flush();

  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].grams, 3, "float noise must not shave a whole gram off");
  assert.deepEqual(consumption.serializeCarry(), {}, "no residual carry on an exact total");
});

test("a short Moonraker length is carried per printer until it reaches the unit", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());
  const k2 = printer({ id: "k2", protocol: "moonraker" });

  consumption.consumeForPrint(k2, status(), status({ filamentUsedMm: 200 }), { printId: "r1", amsStart: null }, null);
  await flush();
  assert.equal(inventory.calls.length, 0, "200 mm is below the minimum length");
  assert.deepEqual(consumption.serializeCarry(), { "k2:main": { lengthMm: 200 } });

  consumption.consumeForPrint(k2, status(), status({ filamentUsedMm: 200 }), { printId: "r2", amsStart: null }, null);
  await flush();
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].lengthMm, 400, "carried mm folded into the next real deduction");
  assert.deepEqual(consumption.serializeCarry(), {});
});

// ── Auth failures (401/403 — configuration, not network) ───────────────────

test("an auth refusal queues the deduction and notifies the operator ONCE", async () => {
  const inventory = flakyInventory(
    99,
    () => new FulfillmentError("склад отклонил сервисную авторизацию (HTTP 401)", "auth")
  );
  const events = new EventFeed();
  const consumption = new FilamentConsumption(inventory.client, events);
  const k2 = printer({ id: "k2", protocol: "moonraker" });

  consumption.consumeForPrint(k2, status(), status({ filamentUsedMm: 500 }), { printId: "r1", amsStart: null }, "a.gcode");
  await flush();
  consumption.consumeForPrint(k2, status(), status({ filamentUsedMm: 600 }), { printId: "r2", amsStart: null }, "b.gcode");
  await flush();

  assert.equal(consumption.pendingCount, 2, "auth failures are queued (not processed server-side)");
  assert.equal(
    events.list().filter((event) => event.text.includes("авторизаци")).length,
    1,
    "one config-error event per outage — no duplicate spam"
  );

  // Redelivery keeps failing on auth: entries stay owed, still no extra event.
  for (const entry of consumption.serialize()) entry.nextAttemptAtMs = 0;
  await consumption.retryPending();
  assert.equal(consumption.pendingCount, 2);
  assert.equal(events.list().filter((event) => event.text.includes("авторизаци")).length, 1);
});

test("the serialized queue contains no tokens or HTTP headers", async () => {
  const inventory = flakyInventory(99, () => new FulfillmentError("склад недоступен", "unreachable"));
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());
  const k2 = printer({ id: "k2", protocol: "moonraker" });

  consumption.consumeForPrint(k2, status(), status({ filamentUsedMm: 500 }), { printId: "r1", amsStart: null }, null);
  await flush();

  const serialized = JSON.stringify(consumption.serialize()).toLowerCase();
  assert.doesNotMatch(serialized, /token/, "no token-like fields are persisted");
  assert.doesNotMatch(serialized, /header/, "no header state is persisted");
  // `note` may be present (undefined) on the in-memory payload; JSON drops it.
  const keys = Object.keys(JSON.parse(JSON.stringify(consumption.serialize()[0].input)));
  assert.deepEqual(
    keys.sort(),
    ["idempotencyKey", "lengthMm", "printJobId", "printerId"].sort(),
    "the queue stores only the business payload"
  );
});

// ── Queue bounds: overflow + expiry are loud and counted ────────────────────

test("queue overflow drops the OLDEST entry with an operator event and a metric", async () => {
  const inventory = flakyInventory(99, () => new FulfillmentError("склад недоступен", "unreachable"));
  const events = new EventFeed();
  const consumption = new FilamentConsumption(inventory.client, events, () => {}, [], { maxPending: 1 });
  const k2 = printer({ id: "k2", protocol: "moonraker" });

  consumption.consumeForPrint(k2, status(), status({ filamentUsedMm: 500 }), { printId: "r1", amsStart: null }, "old.gcode");
  await flush();
  consumption.consumeForPrint(k2, status(), status({ filamentUsedMm: 600 }), { printId: "r2", amsStart: null }, "new.gcode");
  await flush();

  assert.equal(consumption.pendingCount, 1, "the cap holds");
  assert.equal(consumption.serialize()[0].input.printJobId, "r2", "the newest entry survives");
  assert.equal(consumption.metrics().dropped.overflow, 1, "the drop is counted with its reason");
  assert.match(feed(events), /переполнена/);
  assert.match(feed(events), /old\.gcode/, "the dropped deduction is named for manual recovery");
});

test("expiry records the reason in the metric and the feed", async () => {
  const inventory = flakyInventory(99, () => new FulfillmentError("таймаут", "unreachable"));
  const events = new EventFeed();
  const pending: PendingConsume[] = [
    {
      input: { printerId: "k2", lengthMm: 500, printJobId: "run-7", idempotencyKey: "k2:run-7" },
      printerName: "Creality K2",
      attempts: 50,
      nextAttemptAtMs: 0,
      firstFailedAtMs: Date.now() - 8 * 24 * 60 * 60 * 1000
    }
  ];
  const consumption = new FilamentConsumption(inventory.client, events, () => {}, pending);

  await consumption.retryPending();

  assert.equal(consumption.pendingCount, 0);
  assert.equal(consumption.metrics().dropped.expired, 1);
  assert.match(feed(events), /отброшено/);
});

test("a rejected retry is counted under its own drop reason", async () => {
  const inventory = flakyInventory(99, () => new FulfillmentError("недостаточно остатка", "rejected"));
  const pending: PendingConsume[] = [
    {
      input: { printerId: "k2", lengthMm: 500, printJobId: "run-8", idempotencyKey: "k2:run-8" },
      printerName: "Creality K2",
      attempts: 1,
      nextAttemptAtMs: 0,
      firstFailedAtMs: Date.now()
    }
  ];
  const consumption = new FilamentConsumption(inventory.client, new EventFeed(), () => {}, pending);

  await consumption.retryPending();

  assert.equal(consumption.metrics().dropped.rejected, 1);
});

// ── Offline-completion recovery (consumeAfterReconnect) ─────────────────────

test("Bambu offline completion: the remain drop is recovered with the normal keys", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());

  const result = consumption.consumeAfterReconnect(
    printer(),
    status({ amsTrays: [tray(0, 80)] }),
    { printId: "run-off", amsStart: [tray(0, 100)] },
    "model.3mf"
  );
  await flush();

  assert.equal(result, "deducted");
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].grams, 200);
  assert.equal(inventory.calls[0].idempotencyKey, "a1:run-off:t0", "the run's original key — dedupable");
});

test("Bambu offline completion with unmeasurable trays is honestly unknown", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());

  const result = consumption.consumeAfterReconnect(
    printer(),
    status({ amsTrays: [tray(0, null)] }),
    { printId: "run-off", amsStart: [tray(0, null)] },
    null
  );
  await flush();

  assert.equal(result, "unknown");
  assert.equal(inventory.calls.length, 0, "nothing is invented");
});

test("Moonraker offline completion: a confirmed end state trusts the length counter", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());
  const k2 = printer({ id: "k2", protocol: "moonraker" });

  const result = consumption.consumeAfterReconnect(
    k2,
    status({ stateText: "complete", progressPct: 100, filamentUsedMm: 1234 }),
    { printId: "run-off", amsStart: null },
    "vase.gcode"
  );
  await flush();

  assert.equal(result, "deducted");
  assert.equal(inventory.calls[0].lengthMm, 1234);
  assert.equal(inventory.calls[0].idempotencyKey, "k2:run-off");
});

test("Moonraker offline cancellation with real usage still deducts", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());
  const k2 = printer({ id: "k2", protocol: "moonraker" });

  const result = consumption.consumeAfterReconnect(
    k2,
    status({ stateText: "cancelled", filamentUsedMm: 900 }),
    { printId: "run-off", amsStart: null },
    null
  );
  await flush();

  assert.equal(result, "deducted", "a cancelled print's measured usage is still material spent");
  assert.equal(inventory.calls[0].lengthMm, 900);
});

test("Moonraker offline end without a confirmed state is unknown (rebooted counter)", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());
  const k2 = printer({ id: "k2", protocol: "moonraker" });

  // Klipper restarted while offline: idle/standby, counter reset — nothing trustworthy.
  const result = consumption.consumeAfterReconnect(
    k2,
    status({ stateText: "standby", filamentUsedMm: 0 }),
    { printId: "run-off", amsStart: null },
    null
  );
  await flush();

  assert.equal(result, "unknown");
  assert.equal(inventory.calls.length, 0);
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

// ── The external spool, and the difference between measured and estimated ────
//
// Bambu's `parseAmsTrays` used to return null for a printer with no AMS, so an
// external-spool print produced no baseline, no measurement, no reel binding —
// and, because the "nothing to deduct" branch only pushed a feed line, no
// durable record either. The feed is capped and unacknowledged, so the warehouse
// drifted by a spool at a time. This farm's A1 Combo reports zero AMS units and
// feeds externally, which means every print it has run took that path.

test("an external spool WITH a known weight is measured like any other tray", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());
  const external = (remainPct: number) =>
    tray(EXTERNAL_SPOOL_TRAY, remainPct, { nominalWeightG: 1000, material: "PLA" });

  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [external(88)] }),
    { printId: "run-x", amsStart: [external(95)] },
    "cube.3mf"
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].amsTray, EXTERNAL_SPOOL_TRAY);
  assert.equal(inventory.calls[0].grams, 70, "7 % of a 1 kg spool");
  assert.equal(consumption.listUnreconciled().length, 0, "a measured print owes nothing");
});

test("an unmeasurable print records a DURABLE debt, not just a feed line", async () => {
  // The ordinary external spool: no `tray_weight`, so a remain-drop cannot be
  // turned into grams. Nothing observed it, so nothing may be deducted — but the
  // obligation must survive the feed scrolling away.
  const inventory = recordingInventory();
  const events = new EventFeed();
  const consumption = new FilamentConsumption(inventory.client, events);
  const external = (remainPct: number) =>
    tray(EXTERNAL_SPOOL_TRAY, remainPct, { nominalWeightG: null, material: "PLA" });

  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [external(88)] }),
    { printId: "run-y", amsStart: [external(95)], estimatedGrams: 128.44 },
    "cube.3mf"
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(inventory.calls.length, 0, "an estimate is never posted to the warehouse");
  const debts = consumption.listUnreconciled();
  assert.equal(debts.length, 1);
  assert.equal(debts[0].printerId, "a1");
  assert.equal(debts[0].job, "cube.3mf");
  assert.equal(debts[0].estimatedGrams, 128.44, "the slicer's figure is kept as an orientation");
  assert.match(debts[0].reason, /оценка, не замер/, "and is labelled as one");
  assert.match(feed(events), /спишите вручную/);
});

test("with no slicer figure either, the debt is recorded with no number invented", async () => {
  const consumption = new FilamentConsumption(recordingInventory().client, new EventFeed());
  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(EXTERNAL_SPOOL_TRAY, 88, { nominalWeightG: null })] }),
    { printId: "run-z", amsStart: [tray(EXTERNAL_SPOOL_TRAY, 95, { nominalWeightG: null })] },
    null
  );
  await new Promise((resolve) => setImmediate(resolve));
  const debts = consumption.listUnreconciled();
  assert.equal(debts.length, 1);
  assert.equal(debts[0].estimatedGrams, null, "«we do not know» is not «zero»");
});

test("a print too small to move `remain` is a measurement of ~0, not a debt", async () => {
  // The distinction that keeps the debt list usable: this WAS measured, and the
  // answer was approximately nothing. One row per test cube would bury the real
  // obligations.
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());
  consumption.consumeForPrint(
    printer(),
    status(),
    status({ amsTrays: [tray(0, 80, { nominalWeightG: 1000 })] }),
    { printId: "run-tiny", amsStart: [tray(0, 80, { nominalWeightG: 1000 })] },
    "tiny.3mf"
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(inventory.calls.length, 0);
  assert.equal(consumption.listUnreconciled().length, 0, "measured-as-zero is not an obligation");
});

test("Moonraker: a reported length is a measurement even when it is zero", async () => {
  const consumption = new FilamentConsumption(recordingInventory().client, new EventFeed());
  consumption.consumeForPrint(
    printer({ id: "k2", protocol: "moonraker" }),
    status(),
    status({ filamentUsedMm: 0 }),
    { printId: "run-k", amsStart: null },
    "vase.gcode"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(consumption.listUnreconciled().length, 0);
});

test("Moonraker: no length reported at all IS a debt", async () => {
  const consumption = new FilamentConsumption(recordingInventory().client, new EventFeed());
  consumption.consumeForPrint(
    printer({ id: "k2", protocol: "moonraker" }),
    status(),
    status({ filamentUsedMm: null }),
    { printId: "run-k2", amsStart: null, estimatedGrams: 42 },
    "vase.gcode"
  );
  await new Promise((resolve) => setImmediate(resolve));
  const debts = consumption.listUnreconciled();
  assert.equal(debts.length, 1);
  assert.equal(debts[0].estimatedGrams, 42);
});

test("a multi-tray print deducts per slot and leaves no debt", async () => {
  const inventory = recordingInventory();
  const consumption = new FilamentConsumption(inventory.client, new EventFeed());
  consumption.consumeForPrint(
    printer(),
    status(),
    status({
      amsTrays: [
        tray(0, 90, { nominalWeightG: 1000, material: "PLA" }),
        tray(1, 70, { nominalWeightG: 1000, material: "PETG" }),
        tray(2, 50, { nominalWeightG: 1000, material: "ABS" })
      ]
    }),
    {
      printId: "run-multi",
      amsStart: [
        tray(0, 95, { nominalWeightG: 1000, material: "PLA" }),
        tray(1, 72, { nominalWeightG: 1000, material: "PETG" }),
        tray(2, 50, { nominalWeightG: 1000, material: "ABS" })
      ]
    },
    "three-colour.3mf"
  );
  await new Promise((resolve) => setImmediate(resolve));

  // Two slots dropped; the third did not move and is correctly not deducted.
  assert.equal(inventory.calls.length, 2);
  assert.deepEqual(
    inventory.calls.map((c) => [c.amsTray, c.grams]),
    [[0, 50], [1, 20]]
  );
  assert.equal(consumption.listUnreconciled().length, 0);
});
