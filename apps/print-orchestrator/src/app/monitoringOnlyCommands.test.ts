import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import mqtt from "mqtt";

import { JobError } from "../core/errors";
import { normalizePrinterConfig, type PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { shutdownPrinterConnections } from "../infra/printers/status";
import type { SnapshotStore } from "../infra/persistence/snapshotStore";
import type { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import type { EventFeed } from "./eventFeed";
import type { LightScheduler } from "./lightScheduler";
import type { PrinterPoller } from "./printerPoller";
import { buildPrinterView } from "./printerView";

/*
 * The operator-facing commands behind `POST /api/printers/:id/{pause,resume,
 * cancel,light,print}`, against an Anycubic printer that is online and printing
 * — the state in which an operator would be most tempted to press them. Every
 * one is refused by the backend itself (not only hidden in the UI), nothing
 * reaches a transport, and nothing is recorded as done.
 */

const fetchCalls: string[] = [];

beforeEach(() => {
  fetchCalls.length = 0;
  mock.method(globalThis, "fetch", async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error("network must not be touched");
  });
  mock.method(mqtt, "connect", () => {
    throw new Error("no MQTT client may be created");
  });
});

afterEach(() => {
  shutdownPrinterConnections();
  mock.restoreAll();
});

const KOBRA = normalizePrinterConfig({
  id: "kobra-x",
  name: "Kobra X",
  host: "192.168.1.60",
  protocol: "anycubic-lan",
  // A confirmed certificate: fully configured, and still monitoring only.
  tlsFingerprint: "0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0:0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0",
  // Light settings on the record must not make the light controllable.
  light: { enabled: true, onGcode: "M355 S1", offGcode: "M355 S0", bambuNode: "chamber_light" }
}) as PrinterConfig;

function printing(): PrinterLiveStatus {
  return {
    id: "kobra-x",
    online: true,
    status: "printing",
    currentFile: "part.gcode",
    progressPct: 40,
    remainingMinutes: 30,
    filamentUsedMm: null,
    slicerFilamentG: null,
    amsTrays: null,
    nozzleDiameterMm: null,
    nozzleType: null,
    activeFilament: null,
    nozzleTemp: 210,
    nozzleTarget: 210,
    bedTemp: 60,
    bedTarget: 60,
    chamberTemp: null,
    light: null,
    stateText: "printing",
    stateMessage: null,
    faults: [],
    mediaPresent: null,
    error: null,
    updatedAt: new Date().toISOString(),
    currentLayer: 20,
    totalLayers: 50
  };
}

function service(status: PrinterLiveStatus) {
  const events: string[] = [];
  const reads: string[] = [];
  const poller = {
    getStatus: () => status,
    refreshStatus: async (config: PrinterConfig) => {
      reads.push(config.id);
      return status;
    }
  } as unknown as PrinterPoller;
  const lights = {
    applyManual: async () => {
      throw new Error("the light scheduler must not be asked");
    }
  } as unknown as LightScheduler;
  const svc = new PrinterCommandService(
    () => KOBRA,
    poller,
    lights,
    { getEntry: () => undefined } as unknown as CameraService,
    { push: (_icon: string, text: string) => void events.push(text) } as unknown as EventFeed,
    {} as SnapshotStore,
    async () => status
  );
  return { svc, events, reads };
}

test("pause, resume and cancel are refused by the backend and nothing is sent", async () => {
  const { svc, events } = service(printing());
  await assert.rejects(svc.pause("kobra-x"), /не поддерживается/);
  await assert.rejects(svc.cancel("kobra-x"), /не поддерживается/);
  const { svc: paused } = service({ ...printing(), status: "paused" });
  await assert.rejects(paused.resume("kobra-x"), /не поддерживается/);
  assert.deepEqual(events, [], "no «поставил на паузу» / «отменена» is recorded");
  assert.deepEqual(fetchCalls, []);
});

test("the light is refused before the scheduler is asked", async () => {
  const { svc } = service(printing());
  await assert.rejects(svc.setLight("kobra-x", true), JobError);
  await assert.rejects(svc.setLight("kobra-x", false), JobError);
});

test("a direct remote start is refused before the device is even re-read", async () => {
  const idle = { ...printing(), status: "idle" as const, currentFile: null };
  const { svc, reads } = service(idle);
  await assert.rejects(svc.startPrint("kobra-x", "part.gcode"), /не поддерживается/);
  assert.deepEqual(reads, [], "refused before any device read");
  assert.deepEqual(fetchCalls, []);
});

test("the live view says what the printer can do: watch, nothing else", () => {
  const view = buildPrinterView(KOBRA, printing(), undefined);
  assert.equal(view.printControlSupported, false);
  assert.equal(view.remoteStartSupported, false);
  assert.equal(view.filesSupported, false);
  assert.equal(view.lightSupported, false);
  assert.equal(view.snapshotAvailable, false);
  assert.equal(view.camera, "none");
  assert.deepEqual(view.layer, [20, 50]);
  assert.equal(view.setupRequired, false);
});

test("a view whose adapter reports no layers carries no layer key — the published contract is unchanged", () => {
  const k2 = normalizePrinterConfig({ id: "k2", name: "K2", host: "192.0.2.10", protocol: "moonraker" }) as PrinterConfig;
  const { currentLayer: _c, totalLayers: _t, ...noLayers } = printing();
  const view = buildPrinterView(k2, { ...noLayers, id: "k2" }, undefined);
  assert.ok(!("layer" in JSON.parse(JSON.stringify(view))));
  const offline = buildPrinterView(KOBRA, { ...printing(), online: false, status: "offline" }, undefined);
  assert.ok(!("layer" in offline), "an offline printer's last layer is not shown as live");
});
