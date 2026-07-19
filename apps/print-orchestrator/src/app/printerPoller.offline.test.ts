import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import type { AmsTraySnapshot, PrinterLiveStatus } from "../infra/printers/status/types";
import type { CameraService } from "./cameraService";
import { EventFeed } from "./eventFeed";
import { FilamentConsumption, type InventoryConsumer } from "./filamentConsumption";
import { PrinterPoller } from "./printerPoller";

/*
 * Prints that END while the connection is down. The device reconnects already
 * idle: the poller must neither leave the run dangling forever nor silently
 * lose the deduction — it recovers the consumption when the device data
 * honestly allows it (Bambu remain drop; Moonraker confirmed end state) and
 * otherwise raises a prominent manual-check event. Double deduction must be
 * impossible on later polls.
 */

const noopCameras = { probe: async () => {} } as unknown as CameraService;

function recordingInventory() {
  const calls: Array<Record<string, unknown>> = [];
  const client: InventoryConsumer = {
    enabled: true,
    consume: async (input) => {
      calls.push(input as Record<string, unknown>);
      return {};
    }
  };
  return { calls, client };
}

function baseStatus(over: Partial<PrinterLiveStatus>): PrinterLiveStatus {
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

function offlineStatus(): PrinterLiveStatus {
  return baseStatus({ online: false, status: "offline", currentFile: null, error: "нет связи" });
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

function bambuConfig(over: Partial<PrinterConfig> = {}): PrinterConfig {
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
  } as PrinterConfig;
}

function scriptedProvider(sequence: PrinterLiveStatus[]): (p: PrinterConfig) => Promise<PrinterLiveStatus> {
  let index = 0;
  return async () => {
    const status = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return status;
  };
}

function makePoller(printer: PrinterConfig, sequence: PrinterLiveStatus[], inventory: InventoryConsumer) {
  const events = new EventFeed();
  const poller = new PrinterPoller(
    () => [printer],
    noopCameras,
    events,
    () => {},
    undefined,
    () => false,
    new FilamentConsumption(inventory, events),
    scriptedProvider(sequence)
  );
  return { poller, events };
}

async function pollTimes(poller: PrinterPoller, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await poller.pollOnce();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function feedText(events: EventFeed): string {
  return events
    .list()
    .map((event) => event.text)
    .join("\n");
}

test("Bambu: a print that ended offline is deducted once on reconnect, run closed", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 100)] }),
    offlineStatus(),
    // Back online, already idle; the AMS remain still shows the whole print's drop.
    baseStatus({ status: "idle", amsTrays: [tray(0, 85)] }),
    baseStatus({ status: "idle", amsTrays: [tray(0, 85)] }),
    baseStatus({ status: "idle", amsTrays: [tray(0, 85)] })
  ];
  const { poller, events } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 6);

  assert.equal(inventory.calls.length, 1, "exactly one recovered deduction, never a double");
  assert.equal(inventory.calls[0].grams, 150);
  assert.match(String(inventory.calls[0].idempotencyKey), /^a1:[0-9a-f-]{36}:t0$/, "the run's original key");
  assert.match(feedText(events), /расход восстановлен/);
  assert.equal(poller.today.getDone(), 0, "an unobserved ending is never auto-counted as completed");
});

test("Bambu: an offline ending with no usable data raises a manual-check event", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, null)] }), // uncalibrated
    offlineStatus(),
    baseStatus({ status: "idle", amsTrays: [tray(0, null)] })
  ];
  const { poller, events } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 4);

  assert.equal(inventory.calls.length, 0, "nothing is invented");
  assert.match(feedText(events), /завершилась во время потери связи/);
  assert.match(feedText(events), /спишите вручную/);
});

test("a printer that reconnects still printing keeps its run for the normal completion", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 100)] }),
    offlineStatus(),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 92)] }), // survived the gap
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: [tray(0, 80)] })
  ];
  const { poller, events } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 5);

  assert.equal(inventory.calls.length, 1, "the normal completion path deducts once");
  assert.equal(inventory.calls[0].grams, 200, "measured from the ORIGINAL start snapshot");
  assert.doesNotMatch(feedText(events), /во время потери связи/);
  assert.equal(poller.today.getDone(), 1, "an observed ending still counts");
});

test("Moonraker: a confirmed offline completion recovers the length; no dangling run", async () => {
  const inventory = recordingInventory();
  const k2 = bambuConfig({ id: "k2", protocol: "moonraker" });
  const sequence = [
    baseStatus({ id: "k2", status: "idle" }),
    baseStatus({ id: "k2", status: "printing", stateText: "printing" }),
    offlineStatus(),
    baseStatus({ id: "k2", status: "idle", stateText: "complete", progressPct: 100, filamentUsedMm: 1500 }),
    baseStatus({ id: "k2", status: "idle", stateText: "complete", progressPct: 100, filamentUsedMm: 1500 })
  ];
  const { poller, events } = makePoller(k2, sequence, inventory.client);

  await pollTimes(poller, 5);

  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].lengthMm, 1500);
  assert.match(feedText(events), /расход восстановлен/);
});

test("Moonraker: a rebooted device (no end evidence) goes to manual check, not a guess", async () => {
  const inventory = recordingInventory();
  const k2 = bambuConfig({ id: "k2", protocol: "moonraker" });
  const sequence = [
    baseStatus({ id: "k2", status: "idle" }),
    baseStatus({ id: "k2", status: "printing", stateText: "printing", filamentUsedMm: 800 }),
    offlineStatus(),
    // Klipper restarted: standby, counter reset — the 800 mm tail is not trustworthy.
    baseStatus({ id: "k2", status: "idle", stateText: "standby", filamentUsedMm: 0 })
  ];
  const { poller, events } = makePoller(k2, sequence, inventory.client);

  await pollTimes(poller, 4);

  assert.equal(inventory.calls.length, 0);
  assert.match(feedText(events), /спишите вручную/);
});
