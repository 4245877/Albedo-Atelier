import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { JobError, PrintIdentityConflictError } from "../core/errors";
import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import type { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import type { EventFeed } from "./eventFeed";
import type { LightScheduler } from "./lightScheduler";
import type { PrinterPoller } from "./printerPoller";
import type { SnapshotStore } from "../infra/persistence/snapshotStore";

/*
 * Guards the dangerous cancel command against a dashboard polling race: when the
 * operator names the job they are looking at, the backend must refuse to cancel
 * a *different* print that has since started. The device is read fresh and the
 * cancel HTTP call is mocked, so no real printer is touched.
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
    status: "printing",
    currentFile: "current.gcode",
    progressPct: 10,
    remainingMinutes: 30,
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

function makeService(live: () => PrinterLiveStatus) {
  const cached = makeStatus();
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
    async () => live()
  );
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockCancel(): { count: () => number } {
  let n = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/printer/print/cancel")) {
      n += 1;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
  return { count: () => n };
}

test("cancel is refused (409) when the device is printing a different job than expected", async () => {
  const cancel = mockCancel();
  // The dashboard saw job "A" (a stale snapshot), but the printer has since moved
  // on to "B". The cancel for "A" must not touch "B".
  const service = makeService(() => makeStatus({ currentFile: "B.gcode" }));

  await assert.rejects(
    service.cancel("k2", { job: "A.gcode" }),
    (e: unknown) => e instanceof PrintIdentityConflictError
  );
  assert.equal(cancel.count(), 0, "no cancel command reached the device");
});

test("cancel proceeds when the expected job matches the running one", async () => {
  const cancel = mockCancel();
  const service = makeService(() => makeStatus({ currentFile: "B.gcode" }));

  await service.cancel("k2", { job: "B.gcode" });
  assert.equal(cancel.count(), 1, "the matching job was cancelled");
});

test("cancel without an expected job stays backward-compatible (cancels the current print)", async () => {
  const cancel = mockCancel();
  const service = makeService(() => makeStatus({ currentFile: "whatever.gcode" }));

  await service.cancel("k2");
  assert.equal(cancel.count(), 1);
});

test("cancel is refused when nothing is printing, regardless of the expected job", async () => {
  const cancel = mockCancel();
  const service = makeService(() => makeStatus({ status: "idle", currentFile: null }));

  await assert.rejects(service.cancel("k2", { job: "A.gcode" }), JobError);
  assert.equal(cancel.count(), 0);
});
