import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import { makeOfflineStatus } from "../infra/printers/status/mapper";
import type { PrinterLiveStatus } from "../infra/printers/status";
import { EventFeed } from "./eventFeed";
import { LightScheduler } from "./lightScheduler";
import { SolarLightPolicy } from "./solarLightPolicy";

const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date> | []) {
    if (args.length === 0) super(RealDate.UTC(2026, 6, 2, 12));
    else super(...args);
  }
  static now() { return RealDate.UTC(2026, 6, 2, 12); }
}
afterEach(() => { globalThis.Date = RealDate; });

for (const action of ["manual", "scheduled", "snapshot"] as const) {
  test(`${action} light updates preserve a print completion observed while the command is pending`, async () => {
    // @ts-expect-error install deterministic clock
    globalThis.Date = FakeDate;
    const printer = {
      id: "k2", name: "K2", protocol: "moonraker",
      light: { enabled: true, onGcode: "ON", offGcode: "OFF" }
    } as PrinterConfig;
    let current: PrinterLiveStatus = {
      ...makeOfflineStatus(printer, ""), online: true, status: "printing" as const,
      light: false, progressPct: 90, updatedAt: "2026-07-02T11:59:00.000Z"
    };
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const scheduler = new LightScheduler({
      events: new EventFeed(), nightLightsEnabled: () => true,
      getStatus: () => current,
      setStatus: (_id, next) => { current = next; },
      solarPolicy: new SolarLightPolicy({
        mode: "fixed", latitude: null, longitude: null, onOffsetMinutes: 0,
        offOffsetMinutes: 0, onlyWhenActive: true, fallbackWindow: "00:00 – 23:59", issues: []
      }),
      sendLight: async () => {
        began();
        await new Promise<void>((resolve) => { release = resolve; });
      }
    });
    const pending = action === "manual"
      ? scheduler.applyManual(printer, true)
      : action === "scheduled"
        ? scheduler.applyPolicy([printer])
        : scheduler.ensureForSnapshot(printer);
    await started;
    const completed = {
      ...current, status: "idle" as const, stateText: "complete", progressPct: 100,
      updatedAt: "2026-07-02T11:59:30.000Z"
    };
    current = completed;
    release();
    await pending;

    assert.equal(current.status, "idle", "the light response cannot revert the observed print state");
    assert.equal(current.progressPct, 100);
    assert.equal(current.light, true);
    assert.equal(current.updatedAt, completed.updatedAt, "a light command is not fresh print telemetry");
  });
}
