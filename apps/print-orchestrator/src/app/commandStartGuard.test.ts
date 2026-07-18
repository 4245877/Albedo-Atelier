import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { JobError } from "../core/errors";
import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { openDatabase } from "../infra/db/database";
import { SqliteStartGuardRepository } from "../infra/db/repositories/startGuardRepository";
import type { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import type { EventFeed } from "./eventFeed";
import type { LightScheduler } from "./lightScheduler";
import type { PrinterPoller } from "./printerPoller";
import type { SnapshotStore } from "../infra/persistence/snapshotStore";
import type { StartGuardStore } from "./startGuard";

/*
 * The durable double-start guarantee: one operator/queue command must never
 * produce two physical prints, even when a Moonraker response is lost, the
 * command is retried, and/or the process restarts. The guard lives in SQLite
 * (a temp file here) so a "restart" is a fresh connection to the same file.
 * No real device is touched — `sendPrinterStart` hits `globalThis.fetch`, mocked.
 */

function makePrinter(): PrinterConfig {
  return {
    id: "k2",
    name: "Creality K2",
    model: "K2",
    type: "FDM",
    protocol: "moonraker",
    host: "192.168.0.132",
    material: "PETG",
    nozzleDiameterMm: null,
    nozzleType: "",
    swatch: "#4c4f55",
    snapshotUrl: "",
    streamUrl: "",
    interfaceUrl: "",
    enabled: true,
    apiKey: "",
    serial: "",
    accessCode: "",
    light: {
      enabled: false,
      pin: "",
      invert: false,
      onGcode: "",
      offGcode: "",
      statusObject: "",
      statusField: "value",
      bambuNode: "chamber_light"
    }
  } as PrinterConfig;
}

function makeStatus(over: Partial<PrinterLiveStatus> = {}): PrinterLiveStatus {
  return {
    id: "k2",
    online: true,
    status: "idle",
    currentFile: null,
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

/**
 * A command service wired to a shared guard store with a controllable
 * live-status source. Each call builds a fresh service (fresh in-memory
 * `recentStarts`) — so passing the *same* guard store models a restart / a
 * later attempt after the short in-memory hold has expired.
 */
function makeService(guards: StartGuardStore, live: () => PrinterLiveStatus) {
  const cached = makeStatus({ status: "idle" });
  const poller = {
    getStatus: () => cached,
    setStatus: () => {}
  } as unknown as PrinterPoller;
  const events = { push: () => {} } as unknown as EventFeed;
  const cameras = { getEntry: () => undefined } as unknown as CameraService;
  return new PrinterCommandService(
    () => makePrinter(),
    poller,
    {} as LightScheduler,
    cameras,
    events,
    {} as SnapshotStore,
    async () => live(),
    () => guards
  );
}

const tmpDirs: string[] = [];
function tempGuardStore(): { store: StartGuardStore; dbPath: string; reopen: () => StartGuardStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "start-guard-"));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, "queue.db");
  return {
    store: new SqliteStartGuardRepository(openDatabase(dbPath)),
    dbPath,
    // A new connection to the same file — the durability boundary a restart crosses.
    reopen: () => new SqliteStartGuardRepository(openDatabase(dbPath))
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Mocks Moonraker's start endpoint; returns the number of start commands seen. */
function mockStart(behavior: () => Response | never): { count: () => number } {
  let n = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/printer/print/start")) {
      n += 1;
      return behavior();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
  return { count: () => n };
}

const timeoutError = () => {
  throw Object.assign(new Error("Moonraker timed out"), { name: "TimeoutError" });
};

test("lost response: a timed-out start holds the printer as UNKNOWN and does not report success", async () => {
  const { store } = tempGuardStore();
  const dispatch = mockStart(timeoutError);
  const service = makeService(store, () => makeStatus({ status: "idle" }));

  await assert.rejects(service.startPrint("k2", "model.gcode", "q1"));
  assert.equal(dispatch.count(), 1, "the command was sent exactly once");

  const guard = store.get("k2");
  assert.ok(guard, "an intent was recorded");
  assert.equal(guard?.state, "UNKNOWN", "an unconfirmed outcome is held, not treated as failed");
  assert.equal(guard?.jobRef, "q1");
});

test("retry after a lost response never re-dispatches while the outcome is unconfirmed", async () => {
  const { store } = tempGuardStore();
  const dispatch = mockStart(timeoutError);

  // First attempt: times out → guard UNKNOWN.
  await assert.rejects(makeService(store, () => makeStatus({ status: "idle" })).startPrint("k2", "model.gcode", "q1"));
  assert.equal(dispatch.count(), 1);

  // A fresh service (hold expired) retries. The device still reads idle, so the
  // start cannot be confirmed → it is refused WITHOUT sending a second command.
  const retry = makeService(store, () => makeStatus({ status: "idle" }));
  await assert.rejects(
    retry.startPrint("k2", "model.gcode", "q1"),
    (e: unknown) => e instanceof JobError && /неподтверждённый/.test(e.message)
  );
  assert.equal(dispatch.count(), 1, "no second start command reached the device");
});

test("if the lost-response print actually took, reconcile confirms it without re-dispatching", async () => {
  const { store } = tempGuardStore();
  const dispatch = mockStart(timeoutError);

  await assert.rejects(makeService(store, () => makeStatus({ status: "idle" })).startPrint("k2", "model.gcode", "q1"));
  assert.equal(dispatch.count(), 1);

  // The device turns out to be printing the guarded file — the start took, the
  // response was merely lost. Reconcile reports success and clears the intent,
  // sending nothing.
  const reconcile = makeService(store, () => makeStatus({ status: "printing", currentFile: "model.gcode" }));
  const view = await reconcile.startPrint("k2", "model.gcode", "q1");
  assert.equal(view.id, "k2");
  assert.equal(dispatch.count(), 1, "no second start command");
  assert.equal(store.get("k2")?.state, "ACKED", "the intent is now confirmed");
});

test("crash/restart: an unconfirmed guard persists and blocks a blind re-dispatch on a new connection", async () => {
  const seed = tempGuardStore();
  const dispatch = mockStart(timeoutError);

  // Attempt on the first "process": times out → UNKNOWN persisted to disk.
  await assert.rejects(makeService(seed.store, () => makeStatus({ status: "idle" })).startPrint("k2", "model.gcode", "q1"));
  assert.equal(dispatch.count(), 1);

  // Simulate a restart: a brand-new connection to the same database file, and a
  // fresh command service. It must see the persisted intent and refuse to send.
  const afterRestart = seed.reopen();
  assert.equal(afterRestart.get("k2")?.state, "UNKNOWN", "the guard survived the restart");

  const restarted = makeService(afterRestart, () => makeStatus({ status: "idle" }));
  await assert.rejects(
    restarted.startPrint("k2", "model.gcode", "q1"),
    (e: unknown) => e instanceof JobError && /неподтверждённый/.test(e.message)
  );
  assert.equal(dispatch.count(), 1, "restart did not produce a second physical start");
});

test("a definitive rejection (file 404) clears the guard so a corrected retry can proceed", async () => {
  const { store } = tempGuardStore();
  const dispatch = mockStart(() => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response);
  const service = makeService(store, () => makeStatus({ status: "idle" }));

  await assert.rejects(service.startPrint("k2", "missing.gcode", "q1"));
  assert.equal(dispatch.count(), 1);
  assert.equal(store.get("k2"), null, "nothing started, so the printer is not held");
});

test("a successful queue start keeps an ACKED guard until it is explicitly resolved", async () => {
  const { store } = tempGuardStore();
  const dispatch = mockStart(() => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
  const service = makeService(store, () => makeStatus({ status: "idle" }));

  await service.startPrint("k2", "model.gcode", "q1");
  assert.equal(dispatch.count(), 1);
  assert.equal(store.get("k2")?.state, "ACKED", "held until the queue job removal is durable");

  service.resolveStartGuard("k2");
  assert.equal(store.get("k2"), null);
});

test("a successful direct operator start (no queue job) clears its guard immediately", async () => {
  const { store } = tempGuardStore();
  mockStart(() => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
  const service = makeService(store, () => makeStatus({ status: "idle" }));

  await service.startPrint("k2", "model.gcode");
  assert.equal(store.get("k2"), null, "no queue source to re-dispatch → cleared at once");
});

test("clearStartGuard lifts a held guard when idle, but refuses while the printer is printing", async () => {
  const { store } = tempGuardStore();
  store.upsert({
    printerId: "k2",
    file: "model.gcode",
    state: "UNKNOWN",
    jobRef: "q1",
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  // Refused while printing — it must never mask a running job.
  const busy = makeService(store, () => makeStatus({ status: "printing", currentFile: "model.gcode" }));
  await assert.rejects(busy.clearStartGuard("k2"), (e: unknown) => e instanceof JobError && /печатает/.test(e.message));
  assert.ok(store.get("k2"), "guard retained while printing");

  // Allowed once the operator has confirmed the printer is idle.
  const idle = makeService(store, () => makeStatus({ status: "idle" }));
  await idle.clearStartGuard("k2");
  assert.equal(store.get("k2"), null);
});
