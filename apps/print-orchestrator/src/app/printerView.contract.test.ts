import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import type { CameraEntry } from "./cameraService";
import { buildPrinterView } from "./printerView";

/**
 * Wire contract of `GET /api/printers` (one PrinterView entry), pinned as a
 * committed JSON fixture. apps/fulfillment consumes this endpoint through its
 * own runtime validator and keeps an identical copy of the fixture in
 * `apps/api/src/infra/integrations/orchestrator/printer-view.contract.json`
 * — its contract test replays the same payloads through that validator.
 *
 * If this test fails after a deliberate DTO change:
 *   1. regenerate: UPDATE_CONTRACT=1 pnpm test
 *   2. copy the regenerated fixture into the fulfillment repo (same filename)
 *      and make its contract test pass.
 */
const CONTRACT_PATH = path.resolve(process.cwd(), "contracts", "printer-view.contract.json");

const FIXED_NOW = "2026-07-12T12:00:00.000Z";

function config(overrides: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    id: "contract-printer",
    name: "Contract Printer",
    model: "Contract 3000",
    type: "FDM",
    protocol: "moonraker",
    host: "printer.internal.example",
    port: 7125,
    material: "PETG",
    swatch: "#4c4f55",
    snapshotUrl: "http://go2rtc:1984/api/frame.jpeg?src=contract",
    streamUrl: "http://go2rtc:1984/api/stream.mp4?src=contract",
    interfaceUrl: "http://printer.internal.example:4408",
    enabled: true,
    apiKey: "",
    serial: "",
    accessCode: "",
    light: { pin: "LED" },
    ...overrides,
  };
}

function liveStatus(overrides: Partial<PrinterLiveStatus> = {}): PrinterLiveStatus {
  return {
    id: "contract-printer",
    online: true,
    status: "printing",
    currentFile: "benchy.gcode",
    progressPct: 42.5,
    remainingMinutes: 87,
    filamentUsedMm: 1234.5,
    amsTrays: null,
    nozzleDiameterMm: 0.4,
    nozzleType: "hardened_steel",
    activeFilament: { material: "PETG", color: "#112233", tray: 1, remainPct: 61 },
    nozzleTemp: 215,
    nozzleTarget: 220,
    bedTemp: 60,
    bedTarget: 60,
    chamberTemp: 31,
    light: true,
    stateText: "printing",
    stateMessage: null,
    error: null,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

const onlineCamera: CameraEntry = {
  state: "online",
  snapshotAt: FIXED_NOW,
  frame: null,
  fetchedAt: 0,
};

/** The exact JSON a consumer receives (undefined keys dropped, like fastify does). */
function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function buildContractPayloads(): Record<string, unknown> {
  return {
    // A busy printer with full live telemetry and an online camera.
    printing: wire(
      buildPrinterView(config(), liveStatus(), onlineCamera, "/api/printers/contract-printer/snapshots/snap-1")
    ),
    // A finished print: raw device marker in stateText, used by fulfillment to
    // tell completion from cancellation.
    completed: wire(
      buildPrinterView(
        config(),
        liveStatus({
          status: "idle",
          stateText: "complete",
          progressPct: 100,
          remainingMinutes: 0,
          currentFile: "benchy.gcode",
        }),
        onlineCamera,
        null
      )
    ),
    // A device-reported failure: `error` must be present on the wire.
    errored: wire(
      buildPrinterView(
        config(),
        liveStatus({
          status: "error",
          stateText: "error",
          stateMessage: "Nozzle thermal runaway",
          error: "Nozzle thermal runaway",
        }),
        onlineCamera,
        null
      )
    ),
    // Never polled successfully: no live status, camera never probed.
    offline: wire(buildPrinterView(config({ id: "contract-offline", name: "Contract Offline" }), undefined, undefined, null)),
  };
}

test("GET /api/printers wire contract matches the committed fixture", () => {
  const actual = buildContractPayloads();

  if (process.env.UPDATE_CONTRACT === "1") {
    mkdirSync(path.dirname(CONTRACT_PATH), { recursive: true });
    writeFileSync(CONTRACT_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  }

  let committed: unknown;
  try {
    committed = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  } catch {
    assert.fail(
      `Missing/unreadable ${CONTRACT_PATH}. Generate it with UPDATE_CONTRACT=1 pnpm test, ` +
        "then copy it to apps/fulfillment (see the comment at the top of this file)."
    );
  }

  assert.deepEqual(
    actual,
    committed,
    "PrinterView wire shape changed. If intentional: UPDATE_CONTRACT=1 pnpm test, " +
      "copy the fixture to the fulfillment repo and run its contract test."
  );
});

test("the wire contract never leaks connection parameters or credentials", () => {
  const forbidden = [
    "host",
    "port",
    "protocol",
    "apiKey",
    "serial",
    "accessCode",
    "snapshotUrl",
    "streamUrl",
    "deviceUi",
  ];

  for (const [name, payload] of Object.entries(buildContractPayloads())) {
    const keys = Object.keys(payload as Record<string, unknown>);
    for (const key of forbidden) {
      assert.ok(!keys.includes(key), `${name}: field "${key}" must not be exposed`);
    }
  }
});

test("the wire contract carries every field the fulfillment monitor requires", () => {
  const required = [
    "id",
    "name",
    "model",
    "status",
    "online",
    "stateText",
    "stateMessage",
    "updatedAt",
    "job",
    "progress",
    "nozzle",
    "bed",
    "minutesLeft",
    "material",
    "liveMaterial",
  ];

  for (const [name, payload] of Object.entries(buildContractPayloads())) {
    const keys = Object.keys(payload as Record<string, unknown>);
    for (const key of required) {
      assert.ok(keys.includes(key), `${name}: field "${key}" is part of the contract`);
    }
  }
});
