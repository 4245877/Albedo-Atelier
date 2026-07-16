import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { JobError, PrinterOfflineError, ValidationError } from "../core/errors";
import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import type { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import type { EventFeed } from "./eventFeed";
import type { LightScheduler } from "./lightScheduler";
import type { PrinterPoller } from "./printerPoller";
import type { SnapshotStore } from "../infra/persistence/snapshotStore";

/*
 * Guards of the shared remote start (`startPrint`) — the one code path used by
 * the queue (`start-next`), night mode and `POST /api/printers/:id/print`.
 * Most cases fail before any device I/O; the fresh-status re-check is fed by
 * an injected live-status stub, so no network is touched anywhere.
 */

function makePrinter(over: Partial<PrinterConfig> = {}): PrinterConfig {
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
    },
    ...over
  };
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

function makeService(
  printer: PrinterConfig,
  status: PrinterLiveStatus | undefined,
  /** Fresh-status source for the pre-dispatch re-check; defaults to the cached status. */
  liveStatus?: () => Promise<PrinterLiveStatus>
) {
  const poller = {
    getStatus: () => status,
    setStatus: () => {}
  } as unknown as PrinterPoller;
  const events = { push: () => {} } as unknown as EventFeed;
  const cameras = { getEntry: () => undefined } as unknown as CameraService;
  return new PrinterCommandService(
    () => printer,
    poller,
    // startPrint never touches the light path, so an empty scheduler stub suffices.
    {} as LightScheduler,
    cameras,
    events,
    {} as SnapshotStore,
    liveStatus ??
      (async () => {
        if (!status) throw new Error("no live status stubbed");
        return status;
      })
  );
}

test("startPrint refuses when the printer is offline (no live status)", async () => {
  const service = makeService(makePrinter(), undefined);
  await assert.rejects(service.startPrint("k2", "model.gcode"), PrinterOfflineError);
});

test("startPrint refuses when the printer reports offline", async () => {
  const service = makeService(makePrinter(), makeStatus({ online: false, status: "offline" }));
  await assert.rejects(service.startPrint("k2", "model.gcode"), PrinterOfflineError);
});

test("startPrint never interrupts a busy printer", async () => {
  for (const busy of ["printing", "paused"] as const) {
    const service = makeService(makePrinter(), makeStatus({ status: busy }));
    await assert.rejects(
      service.startPrint("k2", "model.gcode"),
      (error: unknown) => error instanceof JobError && error.message.includes("занят"),
      busy
    );
  }
});

test("startPrint refuses a printer in a not-ready state (e.g. error)", async () => {
  const service = makeService(makePrinter(), makeStatus({ status: "error" }));
  await assert.rejects(
    service.startPrint("k2", "model.gcode"),
    (error: unknown) => error instanceof JobError && error.message.includes("не готов")
  );
});

test("startPrint reports remote start as unsupported for Bambu and Creality WS", async () => {
  for (const protocol of ["bambu", "creality"] as const) {
    const service = makeService(makePrinter({ protocol }), makeStatus());
    await assert.rejects(
      service.startPrint("k2", "model.gcode"),
      (error: unknown) => error instanceof JobError && error.message.includes("не поддерживается"),
      protocol
    );
  }
});

test("startPrint rejects unsafe or non-G-code paths before touching the device", async () => {
  const service = makeService(makePrinter(), makeStatus());
  for (const file of ["../secret.gcode", "/etc/shadow.gcode", "notes.txt", "dir/../x.gcode"]) {
    await assert.rejects(
      () => service.startPrint("k2", file),
      (error: unknown) => error instanceof ValidationError,
      file
    );
  }
});

test("startPrint refuses when the fresh device check does not confirm idle", async () => {
  // The poll cache optimistically says idle, but the device answers "unknown"
  // when re-checked right before dispatch — the start must not fire blind.
  let liveCalls = 0;
  const service = makeService(makePrinter(), makeStatus({ status: "idle" }), async () => {
    liveCalls += 1;
    return makeStatus({ status: "unknown" });
  });
  await assert.rejects(
    service.startPrint("k2", "model.gcode"),
    (error: unknown) =>
      error instanceof JobError && error.message.includes("подтверждённого idle")
  );
  assert.equal(liveCalls, 1, "the device state was re-checked fresh");
});

test("startPrint refuses when the device turns out busy at the fresh check", async () => {
  const service = makeService(makePrinter(), makeStatus({ status: "idle" }), async () =>
    makeStatus({ status: "printing", currentFile: "other.gcode" })
  );
  await assert.rejects(
    service.startPrint("k2", "model.gcode"),
    (error: unknown) => error instanceof JobError && error.message.includes("занят")
  );
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a just-dispatched start holds the printer against a double start", async () => {
  // The device accepts the start but keeps reporting idle for a moment (the
  // real Moonraker lag). The second request must be refused by the hold, not
  // dispatched again on the strength of the stale idle.
  const startCalls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/printer/print/start")) {
      startCalls.push(url);
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;

  const service = makeService(makePrinter(), makeStatus({ status: "idle" }));

  await service.startPrint("k2", "model.gcode");
  assert.equal(startCalls.length, 1);

  await assert.rejects(
    service.startPrint("k2", "model.gcode"),
    (error: unknown) => error instanceof JobError && error.message.includes("только что"),
    "the second start within the hold window is refused"
  );
  assert.equal(startCalls.length, 1, "no second start command reached the device");
});
