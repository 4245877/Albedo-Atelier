import assert from "node:assert/strict";
import { test } from "node:test";

import { JobError, PrinterOfflineError } from "../../core/errors";
import type { PrinterConfig } from "../printers/config";
import type { PrinterLiveStatus } from "../printers/status";
import type { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import type { EventFeed } from "./eventFeed";
import type { PrinterPoller } from "./printerPoller";
import type { SnapshotStore } from "./snapshotStore";

/*
 * Pre-dispatch guards of the shared remote start (`startPrint`) — the one code
 * path used by the queue (`start-next`), night mode and the new
 * `POST /api/printers/:id/print`. Every case here fails before any device I/O,
 * so no network is touched.
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

function makeService(printer: PrinterConfig, status: PrinterLiveStatus | undefined) {
  const poller = {
    getStatus: () => status,
    setStatus: () => {}
  } as unknown as PrinterPoller;
  const events = { push: () => {} } as unknown as EventFeed;
  const cameras = { getEntry: () => undefined } as unknown as CameraService;
  return new PrinterCommandService(
    () => printer,
    poller,
    cameras,
    events,
    {} as SnapshotStore
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
