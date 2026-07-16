import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status/types";
import type { CameraService } from "./cameraService";
import { EventFeed } from "./eventFeed";
import { PrinterPoller } from "./printerPoller";

/*
 * Average print duration: the mean span of successfully completed runs the
 * poller actually watched start. Driven through an injected statusProvider and
 * a controllable clock, so a run's duration is exactly the fake time advanced
 * between its observed start and completion — no device, no real time passing.
 */

const RealDate = Date;
let fakeNow = RealDate.UTC(2026, 6, 2, 8, 0, 0);

class FakeDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date> | []) {
    if (args.length === 0) {
      super(fakeNow);
    } else {
      super(...args);
    }
  }
  static now(): number {
    return fakeNow;
  }
}

const cameras = { probe: async () => {} } as unknown as CameraService;
const MIN = 60 * 1000;

/** Scripted status the provider reports for every printer on the next poll. */
let script: { status: PrinterLiveStatus["status"]; stateText?: string | null };

beforeEach(() => {
  // @ts-expect-error install controllable clock
  globalThis.Date = FakeDate;
  fakeNow = RealDate.UTC(2026, 6, 2, 8, 0, 0);
  script = { status: "idle" };
});

afterEach(() => {
  globalThis.Date = RealDate;
});

function config(id: string): PrinterConfig {
  return {
    id,
    name: id.toUpperCase(),
    model: "K2",
    type: "FDM",
    protocol: "moonraker",
    host: "127.0.0.1",
    port: 4408,
    material: "",
    swatch: "",
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
      bambuNode: ""
    }
  };
}

function statusFor(printer: PrinterConfig): PrinterLiveStatus {
  return {
    id: printer.id,
    online: script.status !== "offline",
    status: script.status,
    currentFile: script.status === "printing" ? "model.gcode" : null,
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
    stateText: script.stateText ?? null,
    stateMessage: null,
    error: null,
    updatedAt: new Date().toISOString()
  };
}

function makePoller(printers: PrinterConfig[], persist: () => void = () => {}): PrinterPoller {
  return new PrinterPoller(
    () => printers,
    cameras,
    new EventFeed(),
    persist,
    undefined,
    () => false,
    undefined,
    async (printer) => statusFor(printer)
  );
}

test("averages the spans of runs it watched start and finish", async () => {
  let saves = 0;
  const poller = makePoller([config("a")], () => {
    saves += 1;
  });

  script = { status: "idle" };
  await poller.pollOnce(); // baseline
  assert.equal(poller.today.getAvgPrintMs(), null, "no completed run yet → нет данных");

  // Run 1: 40 minutes, start observed.
  script = { status: "printing" };
  await poller.pollOnce();
  fakeNow += 40 * MIN;
  script = { status: "idle", stateText: "complete" };
  await poller.pollOnce();
  assert.equal(poller.today.getAvgPrintMs(), 40 * MIN);
  assert.ok(saves >= 1, "the completion persisted the aggregate");

  // Run 2: 60 minutes → mean is (40 + 60) / 2 = 50 minutes.
  script = { status: "printing" };
  await poller.pollOnce();
  fakeNow += 60 * MIN;
  script = { status: "idle", stateText: "complete" };
  await poller.pollOnce();
  assert.equal(poller.today.getAvgPrintMs(), 50 * MIN);

  assert.equal(poller.today.serialize().avgDurationCount, 2);
  assert.equal(poller.today.serialize().avgDurationMsTotal, 100 * MIN);
});

test("a pause is included in the timed duration", async () => {
  const poller = makePoller([config("a")]);

  script = { status: "idle" };
  await poller.pollOnce();

  script = { status: "printing" };
  await poller.pollOnce(); // start observed at T0
  fakeNow += 20 * MIN;
  script = { status: "paused" };
  await poller.pollOnce(); // 20 min in
  fakeNow += 30 * MIN;
  script = { status: "printing" };
  await poller.pollOnce(); // resumed at 50 min
  fakeNow += 10 * MIN;
  script = { status: "idle", stateText: "complete" };
  await poller.pollOnce(); // finished at 60 min

  // The whole start→finish span, pause included, is 60 minutes.
  assert.equal(poller.today.getAvgPrintMs(), 60 * MIN);
});

test("a cancelled run is not counted", async () => {
  const poller = makePoller([config("a")]);

  script = { status: "idle" };
  await poller.pollOnce();
  script = { status: "printing" };
  await poller.pollOnce();
  fakeNow += 30 * MIN;
  script = { status: "idle", stateText: "cancelled" };
  await poller.pollOnce();

  assert.equal(poller.today.getAvgPrintMs(), null, "a cancel contributes nothing");
  assert.equal(poller.today.getDone(), 0);
});

test("a run already printing at startup has no known start and is excluded", async () => {
  const poller = makePoller([config("a")]);

  // First observation is a baseline: the printer is already printing, so no
  // start was watched and no PrintRun (with a startedAtMs) exists.
  script = { status: "printing" };
  await poller.pollOnce();
  fakeNow += 45 * MIN;
  script = { status: "idle", stateText: "complete" };
  await poller.pollOnce();

  assert.equal(poller.today.getDone(), 1, "it still counts as completed");
  assert.equal(poller.today.getAvgPrintMs(), null, "but an untimed run is left out of the average");
});
