import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { FulfillmentError, FulfillmentInventoryClient } from "./inventoryClient";

/*
 * Inter-service authentication and failure taxonomy of the fulfillment client.
 * The real fetch is replaced with a recorder, so no network is touched: what
 * matters is WHAT is sent (the x-service-token header on every request) and how
 * each response class maps to a FulfillmentFailureKind — in particular that
 * 401/403 is an `auth` configuration error, never a transient network failure.
 */

const TOKEN = "test-service-token-value";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function mockFetch(status: number, body: unknown): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    requests.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers: { ...(init?.headers ?? {}) },
      body: init?.body ? JSON.parse(init.body) : null,
    });
    return new Response(body === null ? "" : JSON.stringify(body), { status });
  }) as typeof fetch;
  return requests;
}

function client(token: string = TOKEN): FulfillmentInventoryClient {
  return new FulfillmentInventoryClient("http://fulfillment.test", token);
}

test("consume sends the x-service-token header", async () => {
  const requests = mockFetch(200, { duplicate: false, stock: null, movement: null });

  await client().consume({
    printerId: "k2",
    lengthMm: 500,
    printJobId: "run-1",
    idempotencyKey: "k2:run-1",
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/inventory\/filament\/consume$/);
  assert.equal(requests[0].headers["x-service-token"], TOKEN);
});

test("sync sends the x-service-token header", async () => {
  const requests = mockFetch(200, { resolved: true });

  await client().syncLoadedFilament({ printerId: "k2", material: "PLA", color: "#000000" });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/inventory\/printer-filament\/sync$/);
  assert.equal(requests[0].headers["x-service-token"], TOKEN);
});

test("an empty token sends no x-service-token header (compat mode)", async () => {
  const requests = mockFetch(200, { resolved: true });

  await client("").syncLoadedFilament({ printerId: "k2", material: "PLA" });

  assert.equal("x-service-token" in requests[0].headers, false);
});

test("401 maps to the auth kind — a configuration error, not a network one", async () => {
  mockFetch(401, { error: "Unauthorized" });

  await assert.rejects(
    () =>
      client().consume({
        printerId: "k2",
        lengthMm: 500,
        printJobId: "run-1",
        idempotencyKey: "k2:run-1",
      }),
    (error: unknown) => {
      assert.ok(error instanceof FulfillmentError);
      assert.equal(error.kind, "auth");
      assert.match(error.message, /ATELIER_FULFILLMENT_TOKEN/);
      return true;
    }
  );
});

test("403 maps to the auth kind for sync too", async () => {
  mockFetch(403, { error: "Forbidden" });

  await assert.rejects(
    () => client().syncLoadedFilament({ printerId: "k2", material: "PLA" }),
    (error: unknown) => error instanceof FulfillmentError && error.kind === "auth"
  );
});

test("a business 4xx with an error body stays `rejected`", async () => {
  mockFetch(400, { error: "нет загруженного филамента" });

  await assert.rejects(
    () =>
      client().consume({
        printerId: "k2",
        lengthMm: 500,
        printJobId: "run-1",
        idempotencyKey: "k2:run-1",
      }),
    (error: unknown) =>
      error instanceof FulfillmentError &&
      error.kind === "rejected" &&
      error.message === "нет загруженного филамента"
  );
});

test("a 5xx stays `unreachable` (delivery unknown → retry is safe)", async () => {
  mockFetch(503, { error: "boom" });

  await assert.rejects(
    () => client().syncLoadedFilament({ printerId: "k2", material: "PLA" }),
    (error: unknown) => error instanceof FulfillmentError && error.kind === "unreachable"
  );
});

test("the token value never leaks into error messages or request bodies", async () => {
  mockFetch(401, { error: "Unauthorized" });

  let thrown: FulfillmentError | null = null;
  try {
    await client().consume({
      printerId: "k2",
      lengthMm: 500,
      printJobId: "run-1",
      idempotencyKey: "k2:run-1",
    });
  } catch (error) {
    thrown = error as FulfillmentError;
  }

  assert.ok(thrown);
  assert.equal(thrown.message.includes(TOKEN), false, "error message carries no secret");

  const requests = mockFetch(200, { resolved: true });
  await client().syncLoadedFilament({ printerId: "k2", material: "PLA" });
  assert.equal(
    JSON.stringify(requests[0].body).includes(TOKEN),
    false,
    "the token travels only in the header, never the payload"
  );
});

/*
 * Warehouse reads. These feed the dashboard's «Материалы» card, so the contract
 * that matters is that a partially-broken payload degrades into fewer rows —
 * never into a NaN balance rendered as fact — and that an outage still throws
 * (the caller must be able to tell "empty shelf" from "no answer").
 */

test("the warehouse reads are GETs that carry the service token and no body", async () => {
  const requests = mockFetch(200, { filamentKg: 1, reelsInUse: 0, stock: [] });

  await client().fetchStockSummary();

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/inventory\/summary$/);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].headers["x-service-token"], TOKEN);
  assert.equal(requests[0].body, null);
});

test("fetchStockSummary converts the kilogram roll-up to grams and keeps the warehouse verdict", async () => {
  mockFetch(200, {
    filamentKg: 18.479,
    reelsInUse: 2,
    stock: [
      {
        id: "s1",
        material: "PETG",
        color: "black",
        colorName: "Чорний",
        label: "PETG Чорний",
        stockG: 9469,
        lowStockG: 1000,
        criticalStockG: 300,
        status: "ok",
      },
    ],
  });

  const summary = await client().fetchStockSummary();

  assert.ok(summary);
  assert.equal(summary.totalG, 18_479);
  assert.equal(summary.reelsInUse, 2);
  assert.equal(summary.positions.length, 1);
  assert.equal(summary.positions[0].status, "ok");
});

test("a malformed position is dropped, never turned into a NaN balance", async () => {
  mockFetch(200, {
    filamentKg: "не число",
    stock: [
      { id: "broken", material: "", stockG: 100 },
      { id: "s1", material: "PLA", color: "black", stockG: "оценочно", status: "странно" },
    ],
  });

  const summary = await client().fetchStockSummary();

  assert.ok(summary);
  assert.equal(summary.totalG, 0, "an unparseable roll-up reads as 0, not NaN");
  assert.equal(summary.positions.length, 1, "the nameless position is dropped");
  assert.equal(summary.positions[0].stockG, 0);
  assert.equal(summary.positions[0].status, "ok", "an unknown status is not invented into a warning");
  assert.equal(summary.positions[0].label, "PLA black", "the label falls back to what is known");
});

test("fetchLoadedReels keeps the null slot of a single-spool printer distinct from slot 0", async () => {
  mockFetch(200, {
    items: [
      { printerId: "k2", printerName: "K2", amsTray: null, stockId: "s1", material: "PETG", color: "black", updatedAt: "t" },
      { printerId: "a1", printerName: "A1", amsTray: 0, stockId: "s2", material: "PLA", color: "white", updatedAt: "t" },
      { printerId: "", material: "PLA" },
    ],
  });

  const reels = await client().fetchLoadedReels();

  assert.equal(reels?.length, 2, "the row binding no printer is dropped");
  assert.equal(reels?.[0].amsTray, null);
  assert.equal(reels?.[1].amsTray, 0);
});

test("an unreachable warehouse throws instead of reporting an empty shelf", async () => {
  mockFetch(503, null);

  await assert.rejects(
    () => client().fetchStockSummary(),
    (error: unknown) => error instanceof FulfillmentError && error.kind === "unreachable"
  );
});

test("the reads are a no-op while the integration is disabled", async () => {
  const disabled = new FulfillmentInventoryClient("", TOKEN);

  assert.equal(await disabled.fetchStockSummary(), null);
  assert.equal(await disabled.fetchLoadedReels(), null);
});
