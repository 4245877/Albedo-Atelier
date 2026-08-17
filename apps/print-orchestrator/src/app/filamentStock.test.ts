import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FulfillmentError,
  type FilamentStockSummary,
  type LoadedReel
} from "../infra/fulfillment/inventoryClient";
import { FilamentStock, type InventoryStockClient } from "./filamentStock";

/*
 * The read side of the fulfillment integration. What matters here is not the
 * happy path (a fetch returns rows) but the three states an operator must be
 * able to tell apart on the board: never configured, configured but not yet
 * answered, and answered once but silent now — the last of which must keep the
 * previous balances and flag them, never blank them.
 */

function summary(over: Partial<FilamentStockSummary> = {}): FilamentStockSummary {
  return {
    totalG: 12_000,
    reelsInUse: 2,
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
      }
    ],
    ...over
  };
}

const REEL: LoadedReel = {
  printerId: "k2",
  printerName: "Creality K2",
  amsTray: null,
  stockId: "s1",
  material: "PETG",
  color: "black",
  updatedAt: "2026-07-13T14:11:05.266Z"
};

/** A client whose two reads are scripted per call, so an outage can follow a success. */
function scriptedClient(script: Array<FilamentStockSummary | Error>): InventoryStockClient & {
  calls: number;
} {
  let index = 0;
  return {
    enabled: true,
    calls: 0,
    async fetchStockSummary() {
      const step = script[Math.min(index, script.length - 1)];
      (this as { calls: number }).calls += 1;
      index += 1;
      if (step instanceof Error) throw step;
      return step;
    },
    async fetchLoadedReels() {
      const step = script[Math.min(index - 1, script.length - 1)];
      if (step instanceof Error) throw step;
      return [REEL];
    }
  };
}

test("an unconfigured warehouse reports 'not connected', never an empty shelf", async () => {
  const stock = new FilamentStock(undefined);
  await stock.refresh();

  const view = stock.snapshot();
  assert.equal(view.connected, false);
  assert.equal(view.ok, false);
  assert.equal(view.pending, false);
  assert.equal(view.stale, false);
  assert.equal(view.error, null);
  assert.deepEqual(view.positions, []);
});

test("a configured warehouse that has not answered yet is pending, not failing", () => {
  const stock = new FilamentStock(scriptedClient([summary()]));

  const view = stock.snapshot();
  assert.equal(view.connected, true);
  assert.equal(view.pending, true);
  assert.equal(view.ok, false);
  // Nothing has been read, so there is no answer to call stale.
  assert.equal(view.stale, false);
  assert.equal(view.error, null);
});

test("a successful read publishes the positions, the reels and a timestamp", async () => {
  const stock = new FilamentStock(scriptedClient([summary()]), { now: () => 1_000 });
  await stock.refresh();

  const view = stock.snapshot();
  assert.equal(view.ok, true);
  assert.equal(view.pending, false);
  assert.equal(view.stale, false);
  assert.equal(view.positions.length, 1);
  assert.equal(view.positions[0].label, "PETG Чорний");
  assert.equal(view.reels.length, 1);
  assert.equal(view.reelsInUse, 2);
  assert.equal(view.fetchedAt, new Date(1_000).toISOString());
});

test("an outage keeps the last balances and names the reason — it never blanks them", async () => {
  const client = scriptedClient([summary(), new FulfillmentError("склад вернул 502")]);
  const stock = new FilamentStock(client, { refreshIntervalMs: 0 });

  await stock.refresh();
  await stock.refresh();

  const view = stock.snapshot();
  assert.equal(view.connected, true);
  assert.equal(view.ok, false, "the warehouse is silent");
  assert.equal(view.pending, false, "it HAS answered before — this is an outage, not a cold start");
  assert.equal(view.error, "склад вернул 502");
  assert.equal(view.positions.length, 1, "the last known balances survive the outage");
});

test("the last answer goes stale once it ages past the threshold", async () => {
  let now = 1_000;
  const stock = new FilamentStock(scriptedClient([summary()]), {
    staleAfterMs: 5_000,
    now: () => now
  });
  await stock.refresh();
  assert.equal(stock.snapshot().stale, false);

  now += 5_001;
  const view = stock.snapshot();
  assert.equal(view.stale, true);
  assert.equal(view.ok, true, "stale data is still the truth we last had, not a failure");
});

test("refreshIfDue honours the cadence and never runs concurrently", async () => {
  let now = 0;
  const client = scriptedClient([summary()]);
  const stock = new FilamentStock(client, { refreshIntervalMs: 60_000, now: () => now });

  await stock.refreshIfDue();
  assert.equal(client.calls, 1);

  // Well inside the interval: the poll loop asks again, the cache declines.
  now += 1_000;
  await stock.refreshIfDue();
  assert.equal(client.calls, 1);

  now += 60_000;
  await stock.refreshIfDue();
  assert.equal(client.calls, 2);
});

test("a failed read still marks the attempt, so an outage is not retried every poll", async () => {
  let now = 0;
  const client = scriptedClient([new FulfillmentError("склад филамента недоступен (таймаут)")]);
  const stock = new FilamentStock(client, { refreshIntervalMs: 60_000, now: () => now });

  await stock.refreshIfDue();
  assert.equal(client.calls, 1);

  now += 1_000;
  await stock.refreshIfDue();
  assert.equal(client.calls, 1, "the failure did not open a retry storm");
});
