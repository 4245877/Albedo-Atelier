import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildPrinterInventory,
  printerInventoryRevision,
  toPrinterInventoryEntry,
  PRINTER_INVENTORY_FORBIDDEN_FIELDS,
  type PrinterInventoryEntry
} from "./inventory";
import type { PrinterRecord } from "./config";

/**
 * Wire contract of `GET /api/printers/inventory`, pinned as a committed JSON
 * fixture. apps/fulfillment consumes this endpoint through its own runtime
 * validator and keeps an identical copy of the fixture in
 * `apps/api/src/infra/integrations/orchestrator/printer-inventory.contract.json`
 * — its contract test replays the same payload through that validator.
 *
 * If this test fails after a deliberate DTO change:
 *   1. regenerate: UPDATE_CONTRACT=1 pnpm test
 *   2. copy the regenerated fixture into the fulfillment repo (same filename)
 *      and make its contract test pass.
 */
const CONTRACT_PATH = path.resolve(process.cwd(), "contracts", "printer-inventory.contract.json");

const FIXED_NOW = "2026-07-12T12:00:00.000Z";

function record(overrides: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    id: "contract-printer",
    name: "Contract Printer",
    model: "Contract 3000",
    type: "FDM",
    printerClass: "contract-class",
    protocol: "moonraker",
    host: "printer.internal.example",
    port: 7125,
    material: "PETG",
    nozzleDiameterMm: 0.4,
    nozzleType: "hardened_steel",
    buildVolume: { x: 220, y: 220, z: 250 },
    swatch: "#4c4f55",
    snapshotUrl: "http://go2rtc:1984/api/frame.jpeg?src=contract",
    streamUrl: "http://go2rtc:1984/api/stream.mp4?src=contract",
    interfaceUrl: "http://printer.internal.example:4408",
    enabled: true,
    apiKey: "super-secret-api-key",
    serial: "0123456789ABCDEF",
    accessCode: "12345678",
    allowInsecureTls: false,
    automaticContinuation: { allowed: false, mechanism: "", verifiedAt: null },
    light: {
      enabled: null,
      pin: "LED",
      invert: false,
      onGcode: "",
      offGcode: "",
      statusObject: "",
      statusField: "value",
      bambuNode: ""
    },
    position: 10,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    version: 3,
    metadata: { importedFrom: "printers.json" },
    ...overrides
  };
}

/** The exact JSON a consumer receives (undefined keys dropped, like fastify does). */
function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function buildContractPayload(): unknown {
  return wire(
    buildPrinterInventory([
      record(),
      // A DISABLED printer: present in the inventory (unlike /api/printers) so a
      // consumer can tell «отключён» from «удалён».
      record({
        id: "contract-disabled",
        name: "Contract Disabled",
        enabled: false,
        protocol: "bambu",
        printerClass: "",
        position: 20,
        version: 1
      }),
      // Everything optional left unspecified: "" and null must survive as null.
      record({
        id: "contract-minimal",
        name: "Contract Minimal",
        model: "",
        type: "Resin",
        printerClass: "",
        protocol: "creality",
        material: "",
        nozzleDiameterMm: null,
        nozzleType: "",
        buildVolume: null,
        swatch: "",
        position: 30,
        version: 1
      })
    ])
  );
}

test("GET /api/printers/inventory wire contract matches the committed fixture", () => {
  const actual = buildContractPayload();

  if (process.env.UPDATE_CONTRACT === "1") {
    mkdirSync(path.dirname(CONTRACT_PATH), { recursive: true });
    writeFileSync(CONTRACT_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  }

  const expected = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  assert.deepEqual(
    actual,
    expected,
    "The printer inventory DTO changed. If deliberate: UPDATE_CONTRACT=1 pnpm test, " +
      "then copy contracts/printer-inventory.contract.json into apps/fulfillment."
  );
});

test("the inventory never carries connection parameters or credentials", () => {
  const payload = buildContractPayload() as { printers: Array<Record<string, unknown>> };

  for (const printer of payload.printers) {
    for (const field of PRINTER_INVENTORY_FORBIDDEN_FIELDS) {
      assert.ok(
        !(field in printer),
        `forbidden field "${field}" appeared in the printer inventory contract`
      );
    }
    // Belt and braces: no value anywhere in the entry may equal a stored secret.
    const serialized = JSON.stringify(printer);
    for (const secret of ["super-secret-api-key", "0123456789ABCDEF", "12345678"]) {
      assert.ok(!serialized.includes(secret), `a credential leaked into ${printer.id}`);
    }
    assert.ok(!serialized.includes("printer.internal.example"), "a device address leaked");
  }
});

test("a disabled printer stays in the inventory and is flagged", () => {
  const payload = buildContractPayload() as { printers: PrinterInventoryEntry[]; count: number };
  const disabled = payload.printers.find((printer) => printer.id === "contract-disabled");

  assert.ok(disabled, "the disabled printer must still be published");
  assert.equal(disabled.enabled, false);
  assert.equal(payload.count, 3);
});

test("empty configuration strings are published as null, never as ''", () => {
  const entry = toPrinterInventoryEntry(
    record({ model: "  ", printerClass: "", material: "", nozzleType: "", swatch: "" })
  );

  assert.equal(entry.model, null);
  assert.equal(entry.printerClass, null);
  assert.equal(entry.material, null);
  assert.equal(entry.nozzleType, null);
  assert.equal(entry.swatch, null);
});

test("printers are ordered by position, then by id", () => {
  const snapshot = buildPrinterInventory([
    record({ id: "c", position: 20 }),
    record({ id: "a", position: 30 }),
    record({ id: "b", position: 20 })
  ]);

  assert.deepEqual(
    snapshot.printers.map((printer) => printer.id),
    ["b", "c", "a"]
  );
});

test("the revision changes on add, edit and delete — and only then", () => {
  const base = [record({ id: "a", version: 1 }), record({ id: "b", version: 1 })];
  const stable = buildPrinterInventory(base).revision;

  assert.equal(
    buildPrinterInventory([base[1], base[0]]).revision,
    stable,
    "storage order must not change the revision"
  );
  assert.notEqual(
    buildPrinterInventory([...base, record({ id: "c", version: 1 })]).revision,
    stable,
    "adding a printer must change the revision"
  );
  assert.notEqual(
    buildPrinterInventory([record({ id: "a", version: 2 }), base[1]]).revision,
    stable,
    "editing a printer (version bump) must change the revision"
  );
  assert.notEqual(
    buildPrinterInventory([base[0]]).revision,
    stable,
    "deleting a printer must change the revision"
  );
});

test("updatedAt is the newest per-printer timestamp; null for an empty farm", () => {
  const empty = buildPrinterInventory([]);
  assert.equal(empty.updatedAt, null);
  assert.equal(empty.count, 0);
  assert.equal(empty.revision, printerInventoryRevision([]));

  const snapshot = buildPrinterInventory([
    record({ id: "a", updatedAt: "2026-07-12T12:00:00.000Z" }),
    record({ id: "b", updatedAt: "2026-07-13T09:30:00.000Z" })
  ]);
  assert.equal(snapshot.updatedAt, "2026-07-13T09:30:00.000Z");
});
