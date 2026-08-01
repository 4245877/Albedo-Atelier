import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import type { PrinterConfigService } from "../../app/printers/printerConfigService";
import type { PrinterRecord } from "../../domain/printers/config";
import { buildPrinterInventory } from "../../domain/printers/inventory";
import { registerPrinterInventoryRoutes } from "./inventoryRoutes";

/*
 * `GET /api/printers/inventory` end-to-end through fastify: it is the contract
 * apps/fulfillment depends on, so what matters here is the wire — that the
 * route resolves (it lives under the same prefix as `/api/printers/:id`), that a
 * disabled printer is served, and that nothing the operator typed as a
 * credential can come out of it.
 */

const NOW = "2026-07-12T12:00:00.000Z";

function record(overrides: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    id: "k2",
    name: "Creality K2",
    model: "K2 Plus",
    type: "FDM",
    printerClass: "k2",
    protocol: "moonraker",
    host: "10.0.0.5",
    port: 4408,
    material: "PETG",
    nozzleDiameterMm: 0.4,
    nozzleType: "hardened_steel",
    buildVolume: { x: 350, y: 350, z: 350 },
    swatch: "#4c4f55",
    snapshotUrl: "",
    streamUrl: "",
    interfaceUrl: "http://10.0.0.5:4408",
    enabled: true,
    apiKey: "api-key-value",
    serial: "serial-value",
    accessCode: "access-code-value",
    allowInsecureTls: false,
    automaticContinuation: { allowed: false, mechanism: "", verifiedAt: null },
    light: {
      enabled: null,
      pin: "",
      invert: false,
      onGcode: "",
      offGcode: "",
      statusObject: "",
      statusField: "",
      bambuNode: ""
    },
    position: 10,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    metadata: {},
    ...overrides
  };
}

async function inventoryOf(records: PrinterRecord[]) {
  const app = Fastify();
  // A stand-in exposing just the one method the route calls, so the test needs
  // neither a database nor the farm singleton.
  const printerConfig = () =>
    ({ inventory: () => buildPrinterInventory(records) }) as PrinterConfigService;

  await app.register(registerPrinterInventoryRoutes, {
    prefix: "/api/printers/inventory",
    printerConfig
  });
  await app.ready();
  const response = await app.inject({ method: "GET", url: "/api/printers/inventory" });
  await app.close();
  return response;
}

test("serves every configured printer, enabled or not", async () => {
  const response = await inventoryOf([
    record(),
    record({ id: "a1", name: "Bambu A1", protocol: "bambu", enabled: false, position: 20 })
  ]);

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as {
    count: number;
    revision: string;
    printers: Array<{ id: string; enabled: boolean }>;
  };

  assert.equal(payload.count, 2);
  assert.deepEqual(
    payload.printers.map((printer) => [printer.id, printer.enabled]),
    [
      ["k2", true],
      ["a1", false]
    ]
  );
  assert.match(payload.revision, /^[0-9a-f]{16}$/);
});

test("no credential, host, port or camera URL reaches the wire", async () => {
  const response = await inventoryOf([record()]);
  const body = response.body;

  for (const secret of ["api-key-value", "serial-value", "access-code-value", "10.0.0.5", "4408"]) {
    assert.ok(!body.includes(secret), `"${secret}" leaked into the inventory response`);
  }
});

test("an empty farm answers with an empty, well-formed snapshot", async () => {
  const response = await inventoryOf([]);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    revision: buildPrinterInventory([]).revision,
    updatedAt: null,
    count: 0,
    printers: []
  });
});

test("the response is never cached by an intermediary", async () => {
  const response = await inventoryOf([record()]);
  assert.equal(response.headers["cache-control"], "no-store");
});
