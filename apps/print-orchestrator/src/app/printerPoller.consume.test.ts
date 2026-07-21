import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import type { AmsTraySnapshot, PrinterLiveStatus } from "../infra/printers/status/types";
import type { CameraService } from "./cameraService";
import { EventFeed } from "./eventFeed";
import { FilamentConsumption, type InventoryConsumer } from "./filamentConsumption";
import { FilamentSync, type InventorySyncClient, type SyncPayload } from "./filamentSync";
import { PrinterPoller } from "./printerPoller";

/*
 * Filament auto-consume on print completion. The poll loop is driven through an
 * injected `statusProvider` (a scripted sequence of live statuses), so the real
 * completion logic runs without any device — no MQTT, no HTTP. A recording
 * InventoryConsumer captures the deductions the poller dispatches to fulfillment.
 *
 * Covered: Bambu success (per AMS tray), multi-slot, cancellation, error/FAILED,
 * missing consumption data, re-delivery/idempotency, and the unchanged Moonraker
 * length path.
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

function bambuConfig(): PrinterConfig {
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
      enabled: true,
      pin: "",
      invert: false,
      onGcode: "",
      offGcode: "",
      statusObject: "",
      statusField: "value",
      bambuNode: "chamber_light"
    }
  };
}

/** Returns a statusProvider that yields the given sequence, then repeats the last. */
function scriptedProvider(sequence: PrinterLiveStatus[]): (p: PrinterConfig) => Promise<PrinterLiveStatus> {
  let index = 0;
  return async () => {
    const status = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return status;
  };
}

function makePoller(
  printer: PrinterConfig,
  sequence: PrinterLiveStatus[],
  inventory: InventoryConsumer,
  filamentSync?: FilamentSync
): { poller: PrinterPoller; events: EventFeed } {
  const events = new EventFeed();
  const poller = new PrinterPoller(
    () => [printer],
    noopCameras,
    events,
    () => {}, // persist
    undefined, // initialToday
    () => false, // night-lights off: never touch the (fake) device light
    new FilamentConsumption(inventory, events),
    scriptedProvider(sequence),
    filamentSync
  );
  return { poller, events };
}

async function pollTimes(poller: PrinterPoller, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await poller.pollOnce();
  }
}

function feedText(events: EventFeed): string {
  return events
    .list()
    .map((event) => event.text)
    .join("\n");
}

test("Bambu: a completed print deducts grams for the used AMS tray", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }), // baseline
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 100)] }), // start
    baseStatus({
      status: "idle",
      stateText: "FINISH",
      progressPct: 100,
      amsTrays: [tray(0, 90)] // 10 % of 1000 g → 100 g
    })
  ];
  const { poller } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 3);

  assert.equal(inventory.calls.length, 1, "one deduction for the one used tray");
  const call = inventory.calls[0];
  assert.equal(call.printerId, "a1");
  assert.equal(call.grams, 100);
  assert.equal(call.amsTray, 0);
  assert.equal(call.material, "PLA");
  assert.equal(call.color, "#FF0000");
  assert.equal(call.lengthMm, undefined, "grams source does not also send a length");
  assert.match(String(call.idempotencyKey), /^a1:[0-9a-f-]{36}:t0$/, "per-run, per-tray idempotency key");
  assert.equal(poller.today.getDone(), 1);
});

test("Bambu: a multi-colour print deducts each used slot separately", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({
      status: "printing",
      stateText: "RUNNING",
      amsTrays: [
        tray(0, 100, { material: "PLA", color: "#FF0000", nominalWeightG: 1000 }),
        tray(1, 60, { material: "PETG", color: "#00FF00", nominalWeightG: 250 }),
        tray(2, 40, { material: "ABS", nominalWeightG: 1000 }) // never touched
      ]
    }),
    baseStatus({
      status: "idle",
      stateText: "FINISH",
      progressPct: 100,
      amsTrays: [
        tray(0, 88, { material: "PLA", color: "#FF0000", nominalWeightG: 1000 }), // 120 g
        tray(1, 40, { material: "PETG", color: "#00FF00", nominalWeightG: 250 }), // 50 g
        tray(2, 40, { material: "ABS", nominalWeightG: 1000 }) // unchanged
      ]
    })
  ];
  const { poller } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 3);

  assert.equal(inventory.calls.length, 2, "only the two used slots are deducted");
  const byTray = new Map(inventory.calls.map((c) => [c.amsTray, c]));
  assert.equal(byTray.get(0)!.grams, 120);
  assert.equal(byTray.get(1)!.grams, 50);
  assert.equal(byTray.get(1)!.material, "PETG");
  // Distinct idempotency keys per slot so neither is deduped against the other.
  assert.notEqual(byTray.get(0)!.idempotencyKey, byTray.get(1)!.idempotencyKey);
});

test("Bambu: a cancelled print with measured usage still deducts (but never counts as done)", async () => {
  // Cancellation decides the OUTCOME, not the deduction: the AMS remain drop
  // measures what was physically extruded before the cancel, so that material
  // is deducted — while the print is not counted as completed.
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 100)] }),
    baseStatus({ status: "idle", stateText: "cancelled", amsTrays: [tray(0, 90)] }) // 10 % of 1000 g used
  ];
  const { poller, events } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 3);

  assert.equal(inventory.calls.length, 1, "the measured consumption of a cancelled print is deducted");
  assert.equal(inventory.calls[0].grams, 100);
  assert.match(feedText(events), /отменена/);
  assert.equal(poller.today.getDone(), 0, "a cancelled print never counts as completed");
});

test("explicit cancellation wins over progressPct >= 99", async () => {
  // A print cancelled at 99–100 % must classify as cancelled, not completed —
  // the progress heuristic is only a fallback for devices without an explicit
  // end state.
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 100)] }),
    baseStatus({ status: "idle", stateText: "cancelled", progressPct: 100, amsTrays: [tray(0, 99)] })
  ];
  const { poller, events } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 3);

  assert.match(feedText(events), /отменена/);
  assert.doesNotMatch(feedText(events), /завершил печать/);
  assert.equal(poller.today.getDone(), 0, "cancel at 100 % is still a cancel");
  assert.equal(inventory.calls.length, 1, "the measured usage is still deducted");
  assert.equal(inventory.calls[0].grams, 10);
});

test("Bambu: a failed print (FAILED/error) deducts the MEASURED usage", async () => {
  // A real Bambu reports both a manual stop and a technical failure as
  // gcode_state FAILED. The filament extruded before the failure is physically
  // gone, so the measured AMS remain drop is deducted — never the job's planned
  // total — while the print still counts as failed, not done.
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 100)] }),
    baseStatus({ status: "error", stateText: "FAILED", error: "Bambu error", amsTrays: [tray(0, 90)] })
  ];
  const { poller } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 3);

  assert.equal(inventory.calls.length, 1, "the measured usage of a failed print is deducted");
  assert.equal(inventory.calls[0].grams, 100); // 10 % of 1000 g actually extruded
  assert.match(String(inventory.calls[0].idempotencyKey), /^a1:[0-9a-f-]{36}:t0$/);
  assert.equal(poller.today.getFailed(), 1);
  assert.equal(poller.today.getDone(), 0, "a failed print never counts as completed");
});

test("Bambu: a repeated FAILED report does not deduct twice", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 100)] }),
    baseStatus({ status: "error", stateText: "FAILED", error: "Bambu error", amsTrays: [tray(0, 90)] }),
    // The device keeps reporting FAILED on later polls.
    baseStatus({ status: "error", stateText: "FAILED", error: "Bambu error", amsTrays: [tray(0, 90)] }),
    baseStatus({ status: "error", stateText: "FAILED", error: "Bambu error", amsTrays: [tray(0, 90)] })
  ];
  const { poller } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 5);

  assert.equal(inventory.calls.length, 1, "the printing→error edge deducts exactly once");
  assert.equal(poller.today.getFailed(), 1, "repeated FAILED is not a second failure");
});

test("Bambu: error→idle after a handled FAILED does not deduct a second time", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 100)] }),
    baseStatus({ status: "error", stateText: "FAILED", error: "Bambu error", amsTrays: [tray(0, 90)] }),
    // The operator clears the error; the printer settles back to idle.
    baseStatus({ status: "idle", stateText: "IDLE", amsTrays: [tray(0, 90)] }),
    baseStatus({ status: "idle", stateText: "IDLE", amsTrays: [tray(0, 90)] })
  ];
  const { poller } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 5);

  assert.equal(inventory.calls.length, 1, "the run is closed at the error edge — idle adds nothing");
  assert.equal(inventory.calls[0].grams, 100);
});

test("Bambu: a FAILED print without measurable AMS data deducts nothing and says why", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    // Uncalibrated trays: remain unknown at both ends — no honest measurement.
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, null)] }),
    baseStatus({ status: "error", stateText: "FAILED", error: "Bambu error", amsTrays: [tray(0, null)] })
  ];
  const { poller, events } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 3);

  assert.equal(inventory.calls.length, 0, "stock is never touched without a measurement");
  assert.match(feedText(events), /нет данных о расходе филамента/, "the skip reason is surfaced");
  assert.equal(poller.today.getFailed(), 1);
});

test("Bambu: completion with no usable consumption data skips and warns softly", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    // Uncalibrated AMS: remain is unknown (-1 → null), so there is no data to deduct.
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, null)] }),
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: [tray(0, null)] })
  ];
  const { poller, events } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 3);

  assert.equal(inventory.calls.length, 0, "nothing invented when the device has no data");
  assert.match(feedText(events), /нет данных о расходе филамента/, "operator sees a soft warning");
  assert.equal(poller.today.getDone(), 1, "the print still counts as completed");
});

test("Bambu: a tiny print that did not move remain is a silent no-op, not a warning", async () => {
  const inventory = recordingInventory();
  // remain is known at both ends but unchanged (print too small for the 1 % step):
  // we measured, there was simply ~nothing to deduct — so no warning is fed.
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 50)] }),
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: [tray(0, 50)] })
  ];
  const { poller, events } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 3);

  assert.equal(inventory.calls.length, 0);
  assert.doesNotMatch(feedText(events), /нет данных о расходе/, "measured ~0 g must not warn");
  assert.equal(poller.today.getDone(), 1);
});

test("Bambu: a re-observed completion does not deduct twice (idempotent)", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle" }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 100)] }),
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: [tray(0, 80)] }),
    // The printer keeps reporting the same finished state on later polls.
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: [tray(0, 80)] }),
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: [tray(0, 80)] })
  ];
  const { poller } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 5);

  assert.equal(inventory.calls.length, 1, "the completion transition fires — and deducts — exactly once");
  assert.equal(inventory.calls[0].grams, 200); // 20 % of 1000 g
});

test("Bambu: a start report without the AMS block falls back to the previous poll's trays", async () => {
  // Bambu MQTT sends partial deltas; the message that flips to RUNNING often
  // carries no `ams` (and the raw cache resets on a new subtask_id). The start
  // snapshot must then come from the last valid pre-print state — remain is
  // printer-level hardware state that does not change between jobs.
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle", amsTrays: [tray(0, 100)] }), // last full pre-print state
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: null }), // partial start report
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: [tray(0, 90)] })
  ];
  const { poller } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 3);

  assert.equal(inventory.calls.length, 1, "the pre-print trays anchor the measurement");
  assert.equal(inventory.calls[0].grams, 100);
});

test("Bambu: a missing start snapshot is backfilled from the first full report while printing", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle", amsTrays: null }), // no AMS data before the start either
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: null }), // start with no snapshot
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 95)] }), // first full report
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: [tray(0, 90)] })
  ];
  const { poller } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 4);

  assert.equal(inventory.calls.length, 1, "the backfilled baseline still yields a measurement");
  assert.equal(inventory.calls[0].grams, 50, "measured from the backfill point — under-, never over-counted");
});

test("Bambu: the backfilled snapshot belongs to the run — a new print never inherits it", async () => {
  const inventory = recordingInventory();
  const sequence = [
    baseStatus({ status: "idle", amsTrays: null }),
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: null }),
    // The print ends before any full AMS report arrived: nothing measurable.
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: null }),
    // A second print starts and finishes with full AMS data.
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 80)] }),
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: [tray(0, 70)] })
  ];
  const { poller, events } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 5);

  assert.equal(inventory.calls.length, 1, "only the second, measurable print deducts");
  assert.equal(inventory.calls[0].grams, 100, "measured strictly within the second run");
  assert.match(feedText(events), /нет данных о расходе филамента/, "the first print's skip is explained");
});

test("Bambu: no start snapshot (started before boot) skips deduction", async () => {
  const inventory = recordingInventory();
  // First observation is already 'printing' → treated as a baseline, so no run
  // identity / AMS start snapshot is captured. On completion there is nothing to diff.
  const sequence = [
    baseStatus({ status: "printing", stateText: "RUNNING", amsTrays: [tray(0, 100)] }),
    baseStatus({ status: "idle", stateText: "FINISH", progressPct: 100, amsTrays: [tray(0, 80)] })
  ];
  const { poller, events } = makePoller(bambuConfig(), sequence, inventory.client);

  await pollTimes(poller, 2);

  assert.equal(inventory.calls.length, 0);
  assert.match(feedText(events), /нет данных о расходе филамента/);
});

test("Moonraker: a print started before boot skips deduction (no tracked run)", async () => {
  const inventory = recordingInventory();
  const printer: PrinterConfig = { ...bambuConfig(), id: "k2", protocol: "moonraker" };
  // First observation is already 'printing' → baseline, so no run identity is
  // captured. On completion there is no reliable idempotency anchor, so the
  // reported length must not be auto-deducted with a guessed key.
  const sequence = [
    baseStatus({ id: "k2", status: "printing", stateText: "printing" }),
    baseStatus({ id: "k2", status: "idle", stateText: "complete", progressPct: 100, filamentUsedMm: 1234 })
  ];
  const { poller, events } = makePoller(printer, sequence, inventory.client);

  await pollTimes(poller, 2);

  assert.equal(inventory.calls.length, 0, "no deduction without a tracked run");
  assert.match(feedText(events), /не отслеживалась/);
});

test("Moonraker: the extruded-length path is unchanged (single reel, no tray)", async () => {
  const inventory = recordingInventory();
  const printer: PrinterConfig = { ...bambuConfig(), id: "k2", protocol: "moonraker" };
  const sequence = [
    baseStatus({ id: "k2", status: "idle" }),
    baseStatus({ id: "k2", status: "printing", stateText: "printing" }),
    baseStatus({ id: "k2", status: "idle", stateText: "complete", progressPct: 100, filamentUsedMm: 1234 })
  ];
  const { poller } = makePoller(printer, sequence, inventory.client);

  await pollTimes(poller, 3);

  assert.equal(inventory.calls.length, 1);
  const call = inventory.calls[0];
  assert.equal(call.lengthMm, 1234);
  assert.equal(call.grams, undefined);
  assert.equal(call.amsTray, undefined);
  assert.match(String(call.idempotencyKey), /^k2:[0-9a-f-]{36}$/, "no per-tray suffix for a single reel");
});

test("the poller syncs the loaded reel to fulfillment while a print runs", async () => {
  const inventory = recordingInventory();
  const syncCalls: SyncPayload[] = [];
  const syncClient: InventorySyncClient = {
    enabled: true,
    syncLoadedFilament: async (input) => {
      syncCalls.push(input);
      return { resolved: true };
    }
  };
  const printer: PrinterConfig = { ...bambuConfig(), id: "k2", protocol: "moonraker" };
  // Moonraker reports the active reel from sliced metadata only while printing.
  const active = { material: "PETG", color: "#080808", tray: null, remainPct: null };
  const sequence = [
    baseStatus({ id: "k2", status: "idle" }),
    baseStatus({ id: "k2", status: "printing", stateText: "printing", activeFilament: active }),
    baseStatus({
      id: "k2",
      status: "idle",
      stateText: "complete",
      progressPct: 100,
      filamentUsedMm: 1234
    })
  ];
  const { poller } = makePoller(printer, sequence, inventory.client, new FilamentSync(syncClient));

  await pollTimes(poller, 3);
  await new Promise((resolve) => setImmediate(resolve)); // let fire-and-forget deliveries settle

  assert.equal(syncCalls.length, 1, "the loaded reel is synced once while printing");
  assert.deepEqual(syncCalls[0], {
    printerId: "k2",
    amsTray: undefined,
    material: "PETG",
    color: "#080808"
  });
  // And the completion deduction still fires as before.
  assert.equal(inventory.calls.length, 1);
  assert.equal(inventory.calls[0].lengthMm, 1234);
});
