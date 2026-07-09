import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { PrinterConfig } from "../printers/config";
import { EventFeed } from "./eventFeed";
import type { CameraService } from "./cameraService";
import { PrinterPoller } from "./printerPoller";

/*
 * Integration-style tests: a fake global `fetch` simulates one Moonraker K2 so
 * the real driver code (getMoonrakerStatus / sendMoonrakerLightCommand) runs
 * end to end, and a fake `Date` gives us deterministic control over the
 * 5-minute manual override and the night window. Runs under TZ=UTC.
 */

const RealDate = Date;
let fakeNow = RealDate.UTC(2026, 6, 2, 2, 0, 0); // 02:00 UTC → inside 21:30–07:30

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

/** Simulated device: whether SET_PIN actually moves the pin, and its state. */
interface FakeDevice {
  light: boolean;
  /** When false, SET_PIN is "accepted" but the pin never changes (misconfig). */
  effective: boolean;
  /** How many gcode/light commands the device received. */
  lightCommands: number;
  /** Force the Moonraker HTTP calls to fail. */
  fail: boolean;
}

let device: FakeDevice;
let realFetch: typeof globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  } as unknown as Response;
}

beforeEach(() => {
  // @ts-expect-error install controllable clock
  globalThis.Date = FakeDate;
  fakeNow = RealDate.UTC(2026, 6, 2, 2, 0, 0);
  device = { light: true, effective: true, lightCommands: 0, fail: false };
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (device.fail) return jsonResponse({}, 502);

    if (url.includes("/printer/objects/query")) {
      return jsonResponse({
        result: {
          status: {
            print_stats: { state: "standby" },
            "output_pin LED": { value: device.light ? 1 : 0 }
          }
        }
      });
    }
    if (url.includes("/printer/gcode/script")) {
      device.lightCommands += 1;
      const script = decodeURIComponent(url); // SET_PIN PIN=LED VALUE=1/0
      if (device.effective) {
        if (/VALUE=1/.test(script)) device.light = true;
        else if (/VALUE=0/.test(script)) device.light = false;
      }
      return jsonResponse({ result: "ok" });
    }
    return jsonResponse({}, 404);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.Date = RealDate;
  globalThis.fetch = realFetch;
});

function k2Config(): PrinterConfig {
  return {
    id: "k2",
    name: "Creality K2",
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
      enabled: true,
      pin: "LED",
      invert: false,
      onGcode: "SET_PIN PIN=LED VALUE=1",
      offGcode: "SET_PIN PIN=LED VALUE=0",
      statusObject: "output_pin LED",
      statusField: "value",
      bambuNode: "chamber_light"
    }
  };
}

function makePoller(printer: PrinterConfig): PrinterPoller {
  const cameras = { probe: async () => {} } as unknown as CameraService;
  return new PrinterPoller(() => [printer], cameras, new EventFeed());
}

test("manual override holds the operator's state, then the schedule reasserts", async () => {
  const printer = k2Config();
  const poller = makePoller(printer);

  // 02:00 UTC → schedule wants ON; device already on → no command.
  device.light = true;
  await poller.pollOnce();
  const baseline = device.lightCommands;

  // Operator turns the light OFF manually.
  await poller.applyManualLight(printer, false);
  assert.equal(device.light, false, "manual OFF reaches the device");

  // 1 minute later: override still active, schedule must NOT turn it back on.
  fakeNow += 60 * 1000;
  const beforeSchedule = device.lightCommands;
  await poller.pollOnce();
  assert.equal(device.light, false, "override keeps the light off");
  assert.equal(device.lightCommands, beforeSchedule, "schedule sent no command under override");

  // 6 minutes after the manual command: override expired, schedule reasserts ON.
  fakeNow += 6 * 60 * 1000;
  await poller.pollOnce();
  assert.equal(device.light, true, "schedule turns the light back on after 5 min");
  assert.ok(device.lightCommands > baseline, "schedule issued a command after expiry");
});

test("a scheduled command already in flight does not clobber a fresh manual one", async () => {
  const printer = k2Config();
  const poller = makePoller(printer);

  // Daytime → schedule wants OFF. Device currently on.
  fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0);
  device.light = true;
  await poller.pollOnce(); // seed statuses (light on)
  device.light = true; // schedule will want to turn it off

  // Race: schedule poll (wants OFF) and a manual ON fire concurrently.
  await Promise.all([poller.pollOnce(), poller.applyManualLight(printer, true)]);

  // Manual must win: light on and an override active (so the next poll leaves it).
  assert.equal(device.light, true, "manual ON is the final state");
  fakeNow += 60 * 1000;
  const before = device.lightCommands;
  await poller.pollOnce();
  assert.equal(device.light, true, "override still protects the manual state");
  assert.equal(device.lightCommands, before, "schedule stayed out under override");
});

test("rapid repeated manual clicks stay consistent and install one override", async () => {
  // Daytime so the schedule would otherwise fight to keep it OFF.
  fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0);
  const printer = k2Config();
  const poller = makePoller(printer);
  device.light = false;

  // Five near-simultaneous clicks (as if the button guard were absent).
  await Promise.all(
    Array.from({ length: 5 }, () => poller.applyManualLight(printer, true))
  );
  assert.equal(device.light, true, "final state is deterministic (ON)");

  // The override protects that state on the next poll despite it being daytime.
  fakeNow += 60 * 1000;
  const before = device.lightCommands;
  await poller.pollOnce();
  assert.equal(device.light, true, "override holds after the burst of clicks");
  assert.equal(device.lightCommands, before, "schedule sent nothing under the override");
});

test("schedule stops retrying and backs off when the pin never converges", async () => {
  const printer = k2Config();
  const poller = makePoller(printer);

  // Daytime → schedule wants OFF, but the pin is broken: commands are accepted
  // yet the reported state never changes.
  fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0);
  device.light = true;
  device.effective = false;

  for (let i = 0; i < 6; i += 1) {
    await poller.pollOnce();
    fakeNow += 11 * 1000; // just over a poll interval
  }

  // After MAX_LIGHT_ATTEMPTS (3) the poller backs off instead of sending forever.
  assert.ok(
    device.lightCommands <= 3,
    `expected the poller to back off after ~3 attempts, got ${device.lightCommands}`
  );
});

test("a manual command resets the convergence backoff", async () => {
  const printer = k2Config();
  const poller = makePoller(printer);

  fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0);
  device.light = true;
  device.effective = false;
  for (let i = 0; i < 5; i += 1) {
    await poller.pollOnce();
    fakeNow += 11 * 1000;
  }
  const afterBackoff = device.lightCommands;

  // The pin gets fixed and the operator issues a manual command.
  device.effective = true;
  await poller.applyManualLight(printer, false);
  assert.ok(device.lightCommands > afterBackoff, "manual command still reaches the device");
  assert.equal(device.light, false);
});

test("stale map entries are pruned when a printer leaves the enabled set", async () => {
  const printer = k2Config();
  let enabled: PrinterConfig[] = [printer];
  const cameras = { probe: async () => {} } as unknown as CameraService;
  const poller = new PrinterPoller(() => enabled, cameras, new EventFeed());

  await poller.pollOnce();
  assert.ok(poller.getStatus("k2"), "status recorded while enabled");

  enabled = [];
  await poller.pollOnce();
  assert.equal(poller.getStatus("k2"), undefined, "status pruned once disabled");
});
