import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { EventFeed } from "./eventFeed";
import { LightScheduler } from "./lightScheduler";

/*
 * Direct unit tests for the LightScheduler: the night policy, the manual
 * override, backoff and per-printer command serialization — with an injected
 * `sendLight` and plain in-memory statuses, so no driver, no fake fetch. The
 * poller-level integration of the same behaviour stays in printerPoller.test.ts.
 * Runs under TZ=UTC; the default night window is 21:30–07:30.
 */

const RealDate = Date;
let fakeNow = RealDate.UTC(2026, 6, 2, 2, 0, 0); // 02:00 UTC → inside the night window

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

beforeEach(() => {
  // @ts-expect-error install controllable clock
  globalThis.Date = FakeDate;
  fakeNow = RealDate.UTC(2026, 6, 2, 2, 0, 0);
});

afterEach(() => {
  globalThis.Date = RealDate;
});

function k2(): PrinterConfig {
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
    interfaceUrl: "",
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

function status(over: Partial<PrinterLiveStatus> = {}): PrinterLiveStatus {
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
    light: false,
    stateText: null,
    stateMessage: null,
    error: null,
    updatedAt: new Date().toISOString(),
    ...over
  };
}

/** A scheduler over one in-memory status map and a recording light "device". */
function makeScheduler(options: {
  light?: boolean | null;
  /** When false the device accepts commands but the reported state never moves. */
  effective?: boolean;
  fail?: boolean;
  nightLightsEnabled?: () => boolean;
}) {
  const statuses = new Map<string, PrinterLiveStatus>();
  statuses.set("k2", status({ light: options.light ?? false }));
  const commands: boolean[] = [];
  const device = { effective: options.effective ?? true, fail: options.fail ?? false };

  const scheduler = new LightScheduler({
    events: new EventFeed(),
    nightLightsEnabled: options.nightLightsEnabled ?? (() => true),
    getStatus: (id) => statuses.get(id),
    setStatus: (id, s) => statuses.set(id, s),
    sendLight: async (_printer, on) => {
      if (device.fail) throw new Error("device unreachable");
      commands.push(on);
      if (device.effective) {
        // What the device would report on the NEXT poll; the scheduler itself
        // patches the live status optimistically after a successful send.
        const current = statuses.get("k2");
        if (current) statuses.set("k2", { ...current, light: on });
      }
    }
  });
  return { scheduler, statuses, commands, device };
}

test("applyPolicy turns the light on inside the night window and off outside", async () => {
  const { scheduler, statuses, commands } = makeScheduler({ light: false });

  await scheduler.applyPolicy([k2()]); // 02:00 → night
  assert.deepEqual(commands, [true], "night window switches the light on");
  assert.equal(statuses.get("k2")!.light, true);

  fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0); // noon → day
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [true, false], "daytime switches it back off");
  assert.equal(statuses.get("k2")!.light, false);
});

test("applyPolicy is a no-op when the automation is disabled or the printer is offline", async () => {
  const gated = makeScheduler({ light: false, nightLightsEnabled: () => false });
  await gated.scheduler.applyPolicy([k2()]);
  assert.deepEqual(gated.commands, [], "disabled automation never touches the light");

  const offline = makeScheduler({ light: false });
  offline.statuses.set("k2", status({ online: false, status: "offline", light: null }));
  await offline.scheduler.applyPolicy([k2()]);
  assert.deepEqual(offline.commands, [], "offline printer is left alone");
});

test("applyManual installs a 5-minute override; the schedule reasserts after expiry", async () => {
  const { scheduler, statuses, commands } = makeScheduler({ light: true });

  // Night (schedule wants ON); the operator forces OFF.
  await scheduler.applyManual(k2(), false);
  assert.deepEqual(commands, [false]);
  assert.equal(statuses.get("k2")!.light, false);

  // 1 minute later the override still holds — no scheduled command.
  fakeNow += 60 * 1000;
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [false], "schedule stays out under the override");

  // 6 minutes after the click the override expired: the schedule reasserts ON.
  fakeNow += 6 * 60 * 1000;
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [false, true], "schedule reasserts after 5 minutes");
  assert.equal(statuses.get("k2")!.light, true);
});

test("a non-converging pin backs off after 3 attempts instead of resending forever", async () => {
  const { scheduler, statuses, commands } = makeScheduler({ light: true, effective: false });
  fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0); // day → schedule wants OFF

  for (let i = 0; i < 6; i += 1) {
    // The scheduler patches the status optimistically; simulate the next poll
    // reporting the real (stuck) pin state before each policy pass.
    statuses.set("k2", status({ light: true }));
    await scheduler.applyPolicy([k2()]);
    fakeNow += 11 * 1000;
  }

  assert.ok(
    commands.length <= 3,
    `expected backoff after ~3 attempts, got ${commands.length} commands`
  );
});

test("light operations for one printer never interleave (strict serialization)", async () => {
  const statuses = new Map<string, PrinterLiveStatus>([["k2", status({ light: false })]]);
  let inFlight = 0;
  let maxInFlight = 0;
  const order: boolean[] = [];

  const scheduler = new LightScheduler({
    events: new EventFeed(),
    nightLightsEnabled: () => true,
    getStatus: (id) => statuses.get(id),
    setStatus: (id, s) => statuses.set(id, s),
    sendLight: async (_printer, on) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(on);
      inFlight -= 1;
    }
  });

  await Promise.all([
    scheduler.applyManual(k2(), true),
    scheduler.applyManual(k2(), false),
    scheduler.applyManual(k2(), true)
  ]);

  assert.equal(maxInFlight, 1, "commands for one printer run strictly one at a time");
  assert.deepEqual(order, [true, false, true], "commands run in submission order");
});

test("ensureForSnapshot lights up only when the night policy itself would", async () => {
  // Night, light off → switches on and reports true.
  const night = makeScheduler({ light: false });
  assert.equal(await night.scheduler.ensureForSnapshot(k2()), true);
  assert.deepEqual(night.commands, [true]);
  assert.equal(night.statuses.get("k2")!.light, true);

  // Already on → nothing to do.
  const lit = makeScheduler({ light: true });
  assert.equal(await lit.scheduler.ensureForSnapshot(k2()), false);
  assert.deepEqual(lit.commands, []);

  // Daytime → a frame is meant to be unlit.
  const day = makeScheduler({ light: false });
  fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0);
  assert.equal(await day.scheduler.ensureForSnapshot(k2()), false);
  assert.deepEqual(day.commands, []);

  // Automation off → hands off the lights.
  const off = makeScheduler({ light: false, nightLightsEnabled: () => false });
  assert.equal(await off.scheduler.ensureForSnapshot(k2()), false);
  assert.deepEqual(off.commands, []);
});
