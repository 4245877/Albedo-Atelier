import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status/types";
import type { CameraService } from "./cameraService";
import { EventFeed } from "./eventFeed";
import { PrinterPoller } from "./printerPoller";

/*
 * Observed "hours printing" accrual. The poll loop is driven through an injected
 * statusProvider (scripted live statuses) and a controllable clock, so the real
 * accrual runs with no device and no real time passing. Runs under TZ=UTC, so
 * local midnight is UTC midnight. printingMs (exact ms) is asserted for the
 * precise cases; today.getHoursUsed() covers the hours conversion and the sum
 * across printers.
 */

const RealDate = Date;
// 08:00 UTC — mid-day, comfortably clear of a midnight boundary.
let fakeNow = RealDate.UTC(2026, 6, 2, 8, 0, 0);

class FakeDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date>) {
    if (args.length === 0) {
      super(fakeNow);
    } else {
      // @ts-expect-error forward tuple to the real Date constructor
      super(...args);
    }
  }
  static now(): number {
    return fakeNow;
  }
}

const cameras = { probe: async () => {} } as unknown as CameraService;
const MIN = 60 * 1000;

/** State every scripted printer reports on the next poll (drives the accrual). */
let printerState: PrinterLiveStatus["status"] = "printing";

beforeEach(() => {
  // @ts-expect-error install controllable clock
  globalThis.Date = FakeDate;
  fakeNow = RealDate.UTC(2026, 6, 2, 8, 0, 0);
  printerState = "printing";
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

/** Builds the live status the scripted provider returns for one printer. */
function statusFor(printer: PrinterConfig): PrinterLiveStatus {
  const offline = printerState === "offline";
  return {
    id: printer.id,
    online: !offline,
    status: printerState,
    currentFile: printerState === "printing" ? "model.gcode" : null,
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
    updatedAt: new Date().toISOString()
  };
}

function makePoller(printers: PrinterConfig[]): PrinterPoller {
  return new PrinterPoller(
    () => printers,
    cameras,
    new EventFeed(),
    () => {}, // persist
    undefined, // initialToday
    () => false, // night-lights off
    undefined, // inventory
    async (printer) => statusFor(printer)
  );
}

test("accrues observed printing time and sums it across every printer", async () => {
  const poller = makePoller([config("a"), config("b")]);
  printerState = "printing";

  await poller.pollOnce(); // baseline — no interval to credit yet
  assert.equal(poller.today.serialize().printingMs, 0);

  fakeNow += 3 * MIN;
  await poller.pollOnce();
  // Two printers × 3 min each = 6 observed printer-minutes (the same summation
  // that makes "3 printers × 2 h = 6 h").
  assert.equal(poller.today.serialize().printingMs, 6 * MIN);
  assert.equal(poller.today.getHoursUsed(), 0.1);

  fakeNow += 3 * MIN;
  await poller.pollOnce();
  assert.equal(poller.today.serialize().printingMs, 12 * MIN);
  assert.equal(poller.today.getHoursUsed(), 0.2);
});

test("the first interval after start is not reconstructed, only observed", async () => {
  const poller = makePoller([config("a")]);
  printerState = "printing";

  // A large jump before the very first poll must not be credited: there is no
  // earlier observation, so nothing was actually watched.
  fakeNow += 90 * MIN;
  await poller.pollOnce();
  assert.equal(poller.today.serialize().printingMs, 0);

  fakeNow += 3 * MIN;
  await poller.pollOnce();
  assert.equal(poller.today.serialize().printingMs, 3 * MIN);
});

test("a long pause adds no hours beyond the printing interval that preceded it", async () => {
  const poller = makePoller([config("a")]);
  printerState = "printing";
  await poller.pollOnce(); // baseline

  fakeNow += 3 * MIN;
  await poller.pollOnce(); // printing → +3 min
  assert.equal(poller.today.serialize().printingMs, 3 * MIN);

  // Transition printing → paused: the interval that just ended began in
  // printing, so it is still credited (left Riemann sum).
  printerState = "paused";
  fakeNow += 3 * MIN;
  await poller.pollOnce();
  assert.equal(poller.today.serialize().printingMs, 6 * MIN);

  // Now hours pass on pause; none of it is credited.
  printerState = "paused";
  fakeNow += 60 * MIN;
  await poller.pollOnce();
  fakeNow += 60 * MIN;
  await poller.pollOnce();
  assert.equal(poller.today.serialize().printingMs, 6 * MIN);
});

test("an offline stretch and the reconnect are not counted as printing", async () => {
  const poller = makePoller([config("a")]);
  printerState = "printing";
  await poller.pollOnce(); // baseline

  fakeNow += 3 * MIN;
  await poller.pollOnce(); // +3 min printing
  assert.equal(poller.today.serialize().printingMs, 3 * MIN);

  // Drops offline: the last printing interval still counts, the offline stretch
  // does not, and neither does the offline→online reconnect edge.
  printerState = "offline";
  fakeNow += 3 * MIN;
  await poller.pollOnce(); // prev=printing → credited
  assert.equal(poller.today.serialize().printingMs, 6 * MIN);

  fakeNow += 3 * MIN;
  await poller.pollOnce(); // prev=offline → nothing
  assert.equal(poller.today.serialize().printingMs, 6 * MIN);

  printerState = "printing";
  fakeNow += 3 * MIN;
  await poller.pollOnce(); // reconnect, prev=offline → gap not counted
  assert.equal(poller.today.serialize().printingMs, 6 * MIN);

  fakeNow += 3 * MIN;
  await poller.pollOnce(); // prev=printing → printing resumes counting
  assert.equal(poller.today.serialize().printingMs, 9 * MIN);
});

test("a huge gap between polls is capped, not credited in full", async () => {
  const poller = makePoller([config("a")]);
  printerState = "printing";
  await poller.pollOnce(); // baseline

  // The poll loop hung / the process was suspended for two hours.
  fakeNow += 2 * 60 * MIN;
  await poller.pollOnce();

  // Only MAX_PRINT_ACCRUAL_MS is credited — max(10s×6, 5min) = 5 min with the
  // default poll interval — never the full two hours.
  const ms = poller.today.serialize().printingMs;
  assert.equal(ms, 5 * MIN);
  assert.ok(ms < 2 * 60 * MIN);
});

test("an interval spanning local midnight credits only the part after midnight", async () => {
  const poller = makePoller([config("a")]);
  printerState = "printing";

  fakeNow = RealDate.UTC(2026, 6, 2, 23, 58, 0); // 23:58 on day X
  await poller.pollOnce(); // baseline, anchor at 23:58
  assert.equal(poller.today.serialize().printingMs, 0);

  fakeNow = RealDate.UTC(2026, 6, 3, 0, 2, 0); // 00:02 on day X+1 (4-min interval)
  await poller.pollOnce(); // rolls over to the new day, then accrues

  // Only the 2 minutes after local midnight land on the new day; the 2 before
  // it belonged to the previous day, which rolled over to 0.
  assert.equal(poller.today.serialize().printingMs, 2 * MIN);
  assert.equal(poller.today.serialize().key, "2026-07-03");
});
