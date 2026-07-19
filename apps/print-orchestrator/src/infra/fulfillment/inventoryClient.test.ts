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

type RecordedRequest = { url: string; headers: Record<string, string>; body: unknown };

function mockFetch(status: number, body: unknown): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    requests.push({
      url: String(input),
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
