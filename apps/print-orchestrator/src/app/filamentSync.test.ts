import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import type { AmsTraySnapshot, PrinterLiveStatus } from "../infra/printers/status/types";
import { FulfillmentError } from "../infra/fulfillment/inventoryClient";
import {
  buildSyncItems,
  FilamentSync,
  type InventorySyncClient,
  type SyncPayload,
} from "./filamentSync";

/*
 * Loaded-reel sync. buildSyncItems is pure (device status → the reels to bind);
 * FilamentSync owns the de-duplicated, soft-failing dispatch. A recording client
 * captures what the poller would post to fulfillment, and a scripted one lets a
 * failed sync be retried on the next poll.
 */

function baseStatus(over: Partial<PrinterLiveStatus>): PrinterLiveStatus {
  return {
    id: "p",
    online: true,
    status: "printing",
    currentFile: "model.gcode",
    progressPct: 10,
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
    ...over,
  };
}

function tray(t: number, over: Partial<AmsTraySnapshot> = {}): AmsTraySnapshot {
  return {
    tray: t,
    material: "material" in over ? over.material ?? null : "PLA",
    color: "color" in over ? over.color ?? null : "#FF0000",
    remainPct: over.remainPct ?? 100,
    nominalWeightG: over.nominalWeightG ?? 1000,
    active: over.active ?? false,
  };
}

function config(over: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    id: "p",
    name: "Printer",
    model: "",
    type: "FDM",
    protocol: "moonraker",
    host: "127.0.0.1",
    port: 4408,
    material: "",
    swatch: "",
    snapshotUrl: "",
    streamUrl: "",
    enabled: true,
    apiKey: "",
    serial: "",
    accessCode: "",
    light: { pin: "LED" },
    ...over,
  } as PrinterConfig;
}

function recordingSync(over: Partial<{ resolved: boolean }> = {}) {
  const calls: SyncPayload[] = [];
  const client: InventorySyncClient = {
    enabled: true,
    syncLoadedFilament: async (input) => {
      calls.push(input);
      return { resolved: over.resolved ?? true };
    },
  };
  return { calls, client };
}

/** Yields the poll ticks needed for fire-and-forget deliveries to settle. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Captures the structural log records the sync emits, for the no-data notices. */
function recordingLogger() {
  const info: Array<{ obj: unknown; message?: string }> = [];
  const warn: Array<{ obj: unknown; message?: string }> = [];
  return {
    info,
    warn,
    logger: {
      info: (obj: unknown, message?: string) => void info.push({ obj, message }),
      warn: (obj: unknown, message?: string) => void warn.push({ obj, message }),
    },
  };
}

// ── buildSyncItems (pure) ───────────────────────────────────────────────────

test("buildSyncItems: Bambu yields one item per loaded AMS tray, empties skipped", () => {
  const items = buildSyncItems(
    config({ protocol: "bambu" }),
    baseStatus({
      amsTrays: [
        tray(0, { material: "PLA", color: "#FF0000" }),
        tray(1, { material: "PETG", color: "#00FF00" }),
        tray(2, { material: null, color: null }), // empty slot → skipped
      ],
    })
  );

  assert.deepEqual(items, [
    { amsTray: 0, material: "PLA", color: "#FF0000" },
    { amsTray: 1, material: "PETG", color: "#00FF00" },
  ]);
});

test("buildSyncItems: Moonraker/K2 yields the single active reel, no tray", () => {
  const items = buildSyncItems(
    config({ protocol: "moonraker" }),
    baseStatus({ activeFilament: { material: "PETG", color: "#4C4F55", tray: null, remainPct: null } })
  );

  assert.deepEqual(items, [{ material: "PETG", color: "#4C4F55" }]);
});

test("buildSyncItems: a material-less active reel yields nothing (never invents)", () => {
  const items = buildSyncItems(
    config({ protocol: "moonraker" }),
    baseStatus({ activeFilament: { material: null, color: "#FFFFFF", tray: null, remainPct: null } })
  );

  assert.deepEqual(items, []);
});

test("buildSyncItems: no live filament (Creality/offline) yields nothing", () => {
  assert.deepEqual(buildSyncItems(config({ protocol: "creality" }), baseStatus({ activeFilament: null })), []);
  assert.deepEqual(buildSyncItems(config({ protocol: "bambu" }), baseStatus({ amsTrays: null })), []);
});

// ── FilamentSync (dispatch) ─────────────────────────────────────────────────

test("a disabled client makes syncPrinter a no-op", async () => {
  const client: InventorySyncClient = {
    enabled: false,
    syncLoadedFilament: async () => {
      throw new Error("must not be called when disabled");
    },
  };
  const sync = new FilamentSync(client);
  sync.syncPrinter(config(), baseStatus({ activeFilament: { material: "PLA", color: "#111", tray: null, remainPct: null } }));
  await settle();
});

test("syncs the loaded reel, then dedups an unchanged reel across polls", async () => {
  const { calls, client } = recordingSync();
  const sync = new FilamentSync(client);
  const status = baseStatus({ activeFilament: { material: "PETG", color: "#080808", tray: null, remainPct: null } });

  for (let i = 0; i < 4; i += 1) {
    sync.syncPrinter(config(), status);
    await settle();
  }

  assert.equal(calls.length, 1, "the unchanged reel is posted exactly once");
  assert.deepEqual(calls[0], { printerId: "p", amsTray: undefined, material: "PETG", color: "#080808" });
});

test("a changed reel re-syncs; each AMS slot is tracked independently", async () => {
  const { calls, client } = recordingSync();
  const sync = new FilamentSync(client);
  const bambu = config({ protocol: "bambu" });

  sync.syncPrinter(bambu, baseStatus({ amsTrays: [tray(0, { material: "PLA", color: "#FF0000" })] }));
  await settle();
  // Same slot, new colour → one more call; a second untouched slot appears too.
  sync.syncPrinter(
    bambu,
    baseStatus({
      amsTrays: [
        tray(0, { material: "PLA", color: "#0000FF" }),
        tray(1, { material: "PETG", color: "#00FF00" }),
      ],
    })
  );
  await settle();

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], { printerId: "p", amsTray: 0, material: "PLA", color: "#0000FF" });
  assert.deepEqual(calls[2], { printerId: "p", amsTray: 1, material: "PETG", color: "#00FF00" });
});

test("a failed sync is retried on the next poll (signature stays unmarked)", async () => {
  let fail = true;
  const calls: SyncPayload[] = [];
  const client: InventorySyncClient = {
    enabled: true,
    syncLoadedFilament: async (input) => {
      calls.push(input);
      if (fail) throw new FulfillmentError("склад недоступен", "unreachable");
      return { resolved: true };
    },
  };
  const sync = new FilamentSync(client);
  const status = baseStatus({ activeFilament: { material: "PLA", color: "#222", tray: null, remainPct: null } });

  sync.syncPrinter(config(), status);
  await settle();
  assert.equal(calls.length, 1, "first attempt failed");

  fail = false;
  sync.syncPrinter(config(), status);
  await settle();
  assert.equal(calls.length, 2, "same reel is retried because the failure did not mark it synced");

  sync.syncPrinter(config(), status);
  await settle();
  assert.equal(calls.length, 2, "once it succeeds, the unchanged reel is not posted again");
});

test("an unresolved reel (resolved:false) is not retried every poll", async () => {
  const { calls, client } = recordingSync({ resolved: false });
  const sync = new FilamentSync(client);
  const status = baseStatus({ activeFilament: { material: "PLA", color: "#333", tray: null, remainPct: null } });

  for (let i = 0; i < 3; i += 1) {
    sync.syncPrinter(config(), status);
    await settle();
  }

  assert.equal(calls.length, 1, "a stable no-match state is posted once, not on every tick");
});

// ── No-data logging ─────────────────────────────────────────────────────────

test("an online printer that reports no loaded filament is logged once per dry spell", async () => {
  const { calls, client } = recordingSync();
  const { info, logger } = recordingLogger();
  const sync = new FilamentSync(client);
  sync.useLogger(logger);
  // Online, idle, no active reel (a K2 between prints).
  const dry = baseStatus({ status: "idle", activeFilament: null });

  for (let i = 0; i < 3; i += 1) {
    sync.syncPrinter(config(), dry);
    await settle();
  }

  assert.equal(calls.length, 0, "nothing is synced when the device names no reel");
  assert.equal(info.length, 1, "the dry spell is flagged once, not on every tick");
  assert.match(String(info[0].message), /no loaded filament/i);
  assert.deepEqual(info[0].obj, { printer: "p", protocol: "moonraker", status: "idle" });
});

test("an offline printer reporting no filament is not flagged (offline is its own signal)", async () => {
  const { client } = recordingSync();
  const { info, logger } = recordingLogger();
  const sync = new FilamentSync(client);
  sync.useLogger(logger);

  sync.syncPrinter(config(), baseStatus({ online: false, status: "offline", activeFilament: null }));
  await settle();

  assert.equal(info.length, 0, "an offline device is not a 'no data' warning");
});

test("a printer that resumes reporting, then goes dry again, is flagged afresh", async () => {
  const { client } = recordingSync();
  const { info, logger } = recordingLogger();
  const sync = new FilamentSync(client);
  sync.useLogger(logger);
  const dry = baseStatus({ status: "idle", activeFilament: null });
  const loaded = baseStatus({ activeFilament: { material: "PLA", color: "#010203", tray: null, remainPct: null } });

  sync.syncPrinter(config(), dry); // first dry spell → logged
  await settle();
  sync.syncPrinter(config(), loaded); // names a reel → clears the flag
  await settle();
  sync.syncPrinter(config(), dry); // new dry spell → logged again
  await settle();

  assert.equal(info.length, 2, "each distinct dry spell is flagged, the middle report clears it");
});
