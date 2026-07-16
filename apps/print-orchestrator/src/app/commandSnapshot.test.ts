import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { CameraError } from "../core/errors";
import type { CameraFrame } from "../infra/printers/camera";
import type { PrinterConfig } from "../infra/printers/config";
import type { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import type { EventFeed } from "./eventFeed";
import type { LightScheduler } from "./lightScheduler";
import type { PrinterPoller } from "./printerPoller";
import { SnapshotStore } from "../infra/persistence/snapshotStore";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-cmd-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

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
    snapshotUrl: "http://go2rtc:1984/api/frame.jpeg?src=k2",
    streamUrl: "http://go2rtc:1984/api/stream.mp4?src=k2",
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

/** A camera stub that records which capture method the command service used. */
function makeCameras(behaviour: {
  fresh?: () => Promise<CameraFrame>;
  cached?: () => Promise<CameraFrame>;
}): { cameras: CameraService; calls: string[] } {
  const calls: string[] = [];
  const cameras = {
    async captureFresh() {
      calls.push("captureFresh");
      return (behaviour.fresh ?? (async () => ({ data: Buffer.from([1]), mime: "image/jpeg" })))();
    },
    async getFrame() {
      calls.push("getFrame");
      return (behaviour.cached ?? (async () => ({ data: Buffer.from([0]), mime: "image/jpeg" })))();
    },
    getEntry() {
      return undefined;
    }
  } as unknown as CameraService;
  return { cameras, calls };
}

function makeEvents(): { events: EventFeed; pushed: string[] } {
  const pushed: string[] = [];
  const events = {
    push(_icon: string, text: string) {
      pushed.push(text);
    }
  } as unknown as EventFeed;
  return { events, pushed };
}

function makePoller(status: unknown): PrinterPoller {
  return { getStatus: () => status } as unknown as PrinterPoller;
}

/** These tests never touch the light path, so an empty scheduler stub suffices. */
const noopLights = {} as LightScheduler;

test("snapshot captures a fresh frame — never the short-lived cache", async () => {
  const printer = makePrinter();
  const { cameras, calls } = makeCameras({});
  const { events } = makeEvents();
  const snapshots = new SnapshotStore(dir);
  const service = new PrinterCommandService(
    () => printer,
    makePoller({ status: "printing", currentFile: "chalice.gcode" }),
    noopLights,
    cameras,
    events,
    snapshots
  );

  await service.snapshot("k2");

  assert.deepEqual(calls, ["captureFresh"], "used the fresh-capture path only");
});

test("the feed event is written only after the file is saved", async () => {
  const printer = makePrinter();
  const { cameras } = makeCameras({
    fresh: async () => ({ data: Buffer.from([1, 2, 3]), mime: "image/jpeg" })
  });
  const { events, pushed } = makeEvents();
  const snapshots = new SnapshotStore(dir);
  const service = new PrinterCommandService(
    () => printer,
    makePoller({ status: "printing", currentFile: "chalice.gcode" }),
    noopLights,
    cameras,
    events,
    snapshots
  );

  const result = await service.snapshot("k2");

  assert.equal(pushed.length, 1, "exactly one feed event");
  assert.match(pushed[0], /Creality K2/);
  // The record and the file both exist, and the event describes a real saved image.
  assert.equal(snapshots.list("k2").length, 1);
  assert.ok(fs.existsSync(path.join(dir, result.snapshot.path)));
  // The captured job/status is carried into the metadata.
  assert.equal(result.snapshot.status, "printing · chalice.gcode");
  // The refreshed view surfaces the new snapshot to the UI.
  assert.equal(result.printer.latestSnapshotUrl, result.snapshot.url);
  assert.equal(result.printer.snapshotAvailable, true);
});

test("a capture error writes no file, no metadata and no event", async () => {
  const printer = makePrinter();
  const { cameras } = makeCameras({
    fresh: async () => {
      throw new CameraError("k2", "снимок недоступен — go2rtc не отдал кадр вовремя");
    }
  });
  const { events, pushed } = makeEvents();
  const snapshots = new SnapshotStore(dir);
  const service = new PrinterCommandService(
    () => printer,
    makePoller(undefined),
    noopLights,
    cameras,
    events,
    snapshots
  );

  await assert.rejects(() => service.snapshot("k2"), /CAMERA_ERROR|снимок недоступен/);

  assert.deepEqual(pushed, [], "no feed event on failure");
  assert.deepEqual(snapshots.list("k2"), [], "no metadata recorded");
  // No snapshot files were written under the printer directory.
  assert.equal(fs.existsSync(path.join(dir, "k2")), false);
});

test("if the file write fails, no feed event is recorded", async () => {
  const printer = makePrinter();
  const { cameras } = makeCameras({});
  const { events, pushed } = makeEvents();
  // A snapshot store whose save always fails, standing in for a disk error.
  const failingSnapshots = {
    async save() {
      throw new Error("disk full");
    }
  } as unknown as SnapshotStore;
  const service = new PrinterCommandService(
    () => printer,
    makePoller({ status: "idle", currentFile: null }),
    noopLights,
    cameras,
    events,
    failingSnapshots
  );

  await assert.rejects(() => service.snapshot("k2"), /disk full/);
  assert.deepEqual(pushed, [], "the event is not written when the save fails");
});
