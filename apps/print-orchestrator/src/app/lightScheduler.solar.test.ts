import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { LightScheduleConfig } from "../shared/env";
import { env } from "../shared/env";
import type { PrinterConfig } from "../infra/printers/config";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { EventFeed } from "./eventFeed";
import { LightScheduler } from "./lightScheduler";
import { MONITORING_LEASE_TTL_MS, MonitoringLease } from "./monitoringLease";
import { SolarLightPolicy, type SolarCalculator } from "./solarLightPolicy";

/*
 * The solar light policy through the scheduler: decision priority (manual →
 * automation → monitoring lease → dark×activity), the fallback degradation,
 * the safe-on default, unsupported printers and command economy over repeated
 * polls. Deterministic sun (04:00/18:00 UTC via an injected calculator) and a
 * fake clock; the device is the same recording stub as lightScheduler.test.ts.
 * Runs under TZ=UTC — with offsets −30/+30 the dark period is 17:30 → 04:30.
 */

const RealDate = Date;
let fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0); // midday by default

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
  fakeNow = RealDate.UTC(2026, 6, 2, 12, 0, 0);
});

afterEach(() => {
  globalThis.Date = RealDate;
});

const setNow = (h: number, m = 0, day = 2): void => {
  fakeNow = RealDate.UTC(2026, 6, day, h, m, 0);
};

/** Fixed sun for any requested day: sunrise 04:00 UTC, sunset 18:00 UTC. */
const fixedSun: SolarCalculator = (localNoon) => ({
  sunriseAt: new RealDate(
    RealDate.UTC(localNoon.getFullYear(), localNoon.getMonth(), localNoon.getDate(), 4, 0, 0)
  ),
  sunsetAt: new RealDate(
    RealDate.UTC(localNoon.getFullYear(), localNoon.getMonth(), localNoon.getDate(), 18, 0, 0)
  )
});

function solarConfig(over: Partial<LightScheduleConfig> = {}): LightScheduleConfig {
  return {
    mode: "solar",
    latitude: 50.45,
    longitude: 30.52,
    onOffsetMinutes: -30,
    offOffsetMinutes: 30,
    onlyWhenActive: true,
    fallbackWindow: "16:00-08:00",
    issues: [],
    ...over
  };
}

function k2(over: Partial<PrinterConfig> = {}): PrinterConfig {
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
    },
    ...over
  };
}

/** The Ender 3 V3 KE in this farm: Moonraker, but no light control configured. */
function ender(): PrinterConfig {
  return k2({
    id: "ender",
    name: "Ender 3 V3 KE",
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
  });
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

function makeScheduler(options: {
  status?: Partial<PrinterLiveStatus>;
  config?: Partial<LightScheduleConfig>;
  calculator?: SolarCalculator;
  lease?: MonitoringLease;
  nightLightsEnabled?: () => boolean;
} = {}) {
  const statuses = new Map<string, PrinterLiveStatus>();
  statuses.set("k2", status(options.status));
  const commands: boolean[] = [];
  const warnings: string[] = [];
  const events = new EventFeed();

  const scheduler = new LightScheduler({
    events,
    nightLightsEnabled: options.nightLightsEnabled ?? (() => true),
    getStatus: (id) => statuses.get(id),
    setStatus: (id, s) => statuses.set(id, s),
    solarPolicy: new SolarLightPolicy(solarConfig(options.config), {
      calculator: options.calculator ?? fixedSun,
      onWarning: (message) => warnings.push(message)
    }),
    monitoringLease: options.lease,
    sendLight: async (_printer, on) => {
      commands.push(on);
      const current = statuses.get("k2");
      // The device reports the new state on the next poll; light: null stays null.
      if (current && current.light !== null) statuses.set("k2", { ...current, light: on });
    }
  });
  return { scheduler, statuses, commands, warnings, events };
}

// ── Solar transitions × printer activity ───────────────────────────────────

test("before the on-point the light stays off, 30 min before sunset it turns on for a printing printer", async () => {
  const { scheduler, commands } = makeScheduler({ status: { status: "printing" } });

  setNow(17, 0); // dark starts at 17:30
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [], "still daylight — nothing sent");
  assert.equal(scheduler.evaluate(k2()).reason, "solar_daylight");

  setNow(17, 31);
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [true], "sunset−30min switches the printing printer on");
  assert.equal(scheduler.evaluate(k2()).reason, "solar_dark_active_print");
});

test("after sunrise plus the positive offset the light goes off", async () => {
  const { scheduler, commands } = makeScheduler({
    status: { status: "printing", light: true }
  });

  setNow(4, 29, 3); // dark until 04:30
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [], "still dark — the lit printer stays lit");

  setNow(4, 31, 3);
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [false], "sunrise+30min switches it off");
});

test("at night an idle printer stays dark under LIGHT_ONLY_WHEN_ACTIVE, a paused one counts as active", async () => {
  const idle = makeScheduler({ status: { status: "idle" } });
  setNow(20, 0);
  await idle.scheduler.applyPolicy([k2()]);
  assert.deepEqual(idle.commands, [], "idle printer gets no light at night");
  assert.equal(idle.scheduler.evaluate(k2()).reason, "printer_inactive");
  assert.equal(idle.scheduler.evaluate(k2()).desired, false);

  const paused = makeScheduler({ status: { status: "paused" } });
  setNow(20, 0);
  await paused.scheduler.applyPolicy([k2()]);
  assert.deepEqual(paused.commands, [true], "paused counts as active");
});

test("with LIGHT_ONLY_WHEN_ACTIVE=false the night light does not require activity", async () => {
  const { scheduler, commands } = makeScheduler({
    status: { status: "idle" },
    config: { onlyWhenActive: false }
  });
  setNow(20, 0);
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [true]);
  assert.equal(scheduler.evaluate(k2()).reason, "solar_dark");
});

// ── Priority: manual override and the monitoring lease ─────────────────────

test("manual override outranks the solar policy until it expires", async () => {
  const { scheduler, commands } = makeScheduler({ status: { status: "printing" } });
  setNow(20, 0); // dark, printing → schedule wants ON

  await scheduler.applyManual(k2(), false); // operator forces OFF at night
  assert.deepEqual(commands, [false]);
  assert.equal(scheduler.evaluate(k2()).reason, "manual_override");
  assert.equal(scheduler.evaluate(k2()).desired, false, "desired mirrors the operator's choice");

  fakeNow += 60 * 1000;
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [false], "schedule stays out under the override");

  fakeNow += 6 * 60 * 1000; // 5-minute override expired
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [false, true], "solar policy reasserts after expiry");
});

test("an active monitoring lease turns the light on even in daylight for an idle printer", async () => {
  let nowMs = fakeNow;
  const lease = new MonitoringLease(MONITORING_LEASE_TTL_MS, () => nowMs);
  const { scheduler, commands } = makeScheduler({ status: { status: "idle" }, lease });

  setNow(12, 0);
  nowMs = fakeNow;
  lease.renew();

  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [true], "open dashboard keeps the printer lit");
  const decision = scheduler.evaluate(k2());
  assert.equal(decision.reason, "monitoring_lease");
  assert.equal(decision.nextTransitionAt?.getTime(), lease.expiresAt()?.getTime());
});

test("an expired lease stops influencing the decision; repeated renewals extend it", async () => {
  let nowMs = fakeNow;
  const lease = new MonitoringLease(MONITORING_LEASE_TTL_MS, () => nowMs);
  const { scheduler, commands } = makeScheduler({ status: { status: "idle" }, lease });

  setNow(12, 0);
  nowMs = fakeNow;
  lease.renew();
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [true]);

  // Two renewals ~30 s apart keep it alive past the single TTL…
  fakeNow += 30 * 1000;
  nowMs = fakeNow;
  lease.renew();
  fakeNow += 80 * 1000; // 110 s after the first renew, 80 s after the second
  nowMs = fakeNow;
  await scheduler.applyPolicy([k2()]);
  assert.equal(scheduler.evaluate(k2()).reason, "monitoring_lease", "extended lease still active");
  assert.deepEqual(commands, [true], "target unchanged — no repeat command");

  // …and once it lapses, daylight takes the light back off.
  fakeNow += 11 * 1000; // 91 s after the second renewal
  nowMs = fakeNow;
  await scheduler.applyPolicy([k2()]);
  assert.equal(scheduler.evaluate(k2()).reason, "solar_daylight");
  assert.deepEqual(commands, [true, false], "lease expiry hands the light back to the schedule");
});

// ── Degradation: fallback window, unknown darkness ──────────────────────────

test("broken solar config degrades to the fallback window without crashing", async () => {
  const { scheduler, commands, warnings } = makeScheduler({
    status: { status: "printing" },
    config: { latitude: null } // e.g. LIGHT_LATITUDE=abc was replaced by null
  });

  setNow(17, 0); // inside 16:00-08:00 → fallback says dark
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [true]);
  const decision = scheduler.evaluate(k2());
  assert.equal(decision.reason, "fallback_window");
  assert.equal(decision.usingFallback, true);
  assert.equal(scheduler.isUsingFallback(), true);
  assert.equal(warnings.length, 1, "degradation warned once");

  setNow(12, 0);
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [true, false], "outside the fallback window the light goes off");
});

test("fallback window crosses midnight like the solar one", async () => {
  const { scheduler } = makeScheduler({
    status: { status: "printing" },
    config: { latitude: null, fallbackWindow: "16:00-08:00" }
  });

  setNow(23, 30);
  assert.equal(scheduler.evaluate(k2()).desired, true);
  setNow(7, 30, 3);
  assert.equal(scheduler.evaluate(k2()).desired, true);
  setNow(9, 0, 3);
  assert.equal(scheduler.evaluate(k2()).desired, false);
});

test("unknown darkness + unknown light state + active print → safe ON, sent once", async () => {
  const { scheduler, commands } = makeScheduler({
    status: { status: "printing", light: null },
    config: { latitude: null, fallbackWindow: "not-a-window" }
  });

  setNow(12, 0);
  await scheduler.applyPolicy([k2()]);
  await scheduler.applyPolicy([k2()]);
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [true], "safe-on sent once, not re-spammed while state is unknown");
  const decision = scheduler.evaluate(k2());
  assert.equal(decision.reason, "dark_unknown_safe_on");
  assert.equal(decision.usingFallback, true);

  // An idle printer under the same unknown darkness is asked to switch off
  // once (state unknown → one command toward the target), never re-spammed.
  const idle = makeScheduler({
    status: { status: "idle", light: null },
    config: { latitude: null, fallbackWindow: "not-a-window" }
  });
  await idle.scheduler.applyPolicy([k2()]);
  await idle.scheduler.applyPolicy([k2()]);
  assert.deepEqual(idle.commands, [false]);
  assert.equal(idle.scheduler.evaluate(k2()).reason, "printer_inactive");
});

// ── Unsupported printers and command economy ────────────────────────────────

test("a printer without light support gets no commands and reads as unsupported", async () => {
  const { scheduler, commands, statuses } = makeScheduler({ status: { status: "printing" } });
  statuses.set("ender", status({ id: "ender", status: "printing" }));

  setNow(20, 0);
  await scheduler.applyPolicy([ender()]);
  await scheduler.applyPolicy([ender()]);
  assert.deepEqual(commands, [], "no light commands for the Ender");

  const decision = scheduler.evaluate(ender());
  assert.equal(decision.reason, "unsupported");
  assert.equal(decision.desired, null);
  const view = scheduler.lightState(ender());
  assert.equal(view.supported, false);
  assert.equal(view.reason, "unsupported");
});

test("automation off means hands off, reported as automation_disabled", async () => {
  const { scheduler, commands } = makeScheduler({
    status: { status: "printing" },
    nightLightsEnabled: () => false
  });
  setNow(20, 0);
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, []);
  const decision = scheduler.evaluate(k2());
  assert.equal(decision.reason, "automation_disabled");
  assert.equal(decision.desired, null);
});

test("repeated polls with an unchanged target send no extra commands", async () => {
  const { scheduler, commands } = makeScheduler({ status: { status: "printing" } });

  setNow(20, 0);
  await scheduler.applyPolicy([k2()]);
  assert.deepEqual(commands, [true]);

  for (let i = 0; i < 5; i += 1) {
    fakeNow += 10 * 1000;
    await scheduler.applyPolicy([k2()]);
  }
  assert.deepEqual(commands, [true], "converged target is left alone poll after poll");
});

// ── Read-model projection and NIGHT_PRINT_WINDOW independence ───────────────

test("lightState projects the decision plus the physical state for the dashboard", async () => {
  const { scheduler } = makeScheduler({ status: { status: "printing", light: false } });

  setNow(20, 0);
  const view = scheduler.lightState(k2());
  assert.equal(view.supported, true);
  assert.equal(view.desired, true, "policy wants the light on");
  assert.equal(view.actual, false, "the device has not confirmed yet — kept separate");
  assert.equal(view.reason, "solar_dark_active_print");
  assert.equal(view.usingFallback, false);
  assert.equal(
    view.nextTransitionAt,
    new RealDate(RealDate.UTC(2026, 6, 3, 4, 30, 0)).toISOString(),
    "next switch is tomorrow's sunrise+30min, ISO-encoded"
  );
});

test("NIGHT_PRINT_WINDOW stays an independent setting: the light policy never reads it", async () => {
  // The night-print window keeps its default while the light schedule follows
  // the solar transitions — at 22:00 the fixed night window (21:30–07:30) has
  // begun AND the solar dark period is on; at 17:31 solar is already dark while
  // the night window has NOT begun. The decisions must follow only the sun.
  assert.equal(env.nightWindow, "21:30 – 07:30", "night-print planning window untouched");

  const { scheduler } = makeScheduler({ status: { status: "printing" } });
  setNow(17, 31); // before 21:30, after sunset−30
  assert.equal(scheduler.evaluate(k2()).desired, true, "solar dark wins regardless of NIGHT_PRINT_WINDOW");

  const morning = makeScheduler({ status: { status: "printing" }, config: { offOffsetMinutes: 30 } });
  setNow(5, 0, 3); // inside 21:30–07:30, but after sunrise+30
  assert.equal(morning.scheduler.evaluate(k2()).desired, false, "solar daylight wins regardless of NIGHT_PRINT_WINDOW");
});
