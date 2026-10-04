import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import { makeOfflineStatus } from "../infra/printers/status/mapper";
import type { PrinterLiveStatus } from "../infra/printers/status";
import type { SnapshotStore } from "../infra/persistence/snapshotStore";
import type { CameraService } from "./cameraService";
import { PrinterCommandService } from "./commandService";
import { EventFeed } from "./eventFeed";
import { FilamentConsumption, type InventoryConsumer } from "./filamentConsumption";
import type { LightScheduler } from "./lightScheduler";
import { PrinterPoller } from "./printerPoller";

// Exercise the real command service and poller together. A command's status
// read used to overwrite the cache and erase the edge the next poll needed.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function printer(): PrinterConfig {
  return {
    id: "k2", name: "K2", model: "K2", type: "FDM", protocol: "moonraker",
    host: "127.0.0.1", enabled: true, material: "PLA", swatch: "",
    snapshotUrl: "", streamUrl: "", interfaceUrl: "", apiKey: "", serial: "", accessCode: "",
    light: {
      enabled: true, pin: "LED", invert: false, onGcode: "LIGHT_ON", offGcode: "LIGHT_OFF",
      statusObject: "output_pin LED", statusField: "value", bambuNode: "chamber_light"
    }
  };
}

function status(config: PrinterConfig, over: Partial<PrinterLiveStatus> = {}): PrinterLiveStatus {
  return {
    ...makeOfflineStatus(config, ""), online: true, status: "idle", stateText: "standby",
    error: null, currentFile: "part.gcode", filamentUsedMm: 0, light: false, ...over
  };
}

function fixture() {
  const config = printer();
  let device = status(config);
  let enabled = true;
  const events = new EventFeed();
  const consumed: Record<string, unknown>[] = [];
  const inventory: InventoryConsumer = {
    enabled: true,
    consume: async (payload) => { consumed.push(payload as Record<string, unknown>); return {}; }
  };
  const observed: string[] = [];
  const cameras = { probe: async () => {}, getEntry: () => undefined } as unknown as CameraService;
  const provider = async () => device;
  const poller = new PrinterPoller(
    () => enabled ? [config] : [], cameras, events, () => {}, undefined, () => false,
    new FilamentConsumption(inventory, events), provider, undefined,
    { runObserver: (_id, prev, next) => observed.push(`${prev?.status ?? "none"}->${next.status}`) }
  );
  const commands = new PrinterCommandService(
    () => config, poller, { applyManual: async () => {} } as unknown as LightScheduler,
    cameras, events, {} as SnapshotStore, provider
  );
  return {
    config, poller, events, commands, consumed, observed,
    setEnabled: (next: boolean) => { enabled = next; },
    set: (over: Partial<PrinterLiveStatus>) => { device = status(config, over); }
  };
}

async function begin(f: ReturnType<typeof fixture>) {
  await f.poller.pollOnce();
  f.set({ status: "printing", stateText: "printing", progressPct: 10 });
  await f.poller.pollOnce();
}

async function settle() { await new Promise((resolve) => setImmediate(resolve)); }

test("a command refresh observes completion once, including counters, consumption and the run hook", async () => {
  const f = fixture();
  await begin(f);
  f.set({ stateText: "complete", progressPct: 100, filamentUsedMm: 1000 });

  const view = await f.commands.setLight("k2", true);
  assert.equal(view.stateText, "complete");
  await f.poller.pollOnce();
  await f.poller.pollOnce();
  await settle();

  assert.equal(f.events.list().filter((event) => event.text.includes("завершил печать")).length, 1);
  assert.equal(f.poller.today.getDone(), 1);
  assert.equal(f.consumed.length, 1, "the same physical print is deducted once");
  assert.equal(f.observed.filter((edge) => edge === "printing->idle").length, 1);
});

test("the immediate post-start read retains run identity for its eventual completion", async () => {
  const f = fixture();
  await f.poller.pollOnce();
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.match(String(input), /\/printer\/print\/start\?/);
    f.set({ status: "printing", stateText: "printing", progressPct: 0 });
    return { ok: true, status: 200, json: async () => ({ result: "ok" }) } as Response;
  }) as typeof globalThis.fetch;

  await f.commands.startPrint("k2", "part.gcode");
  f.set({ stateText: "complete", progressPct: 100, filamentUsedMm: 1000 });
  await f.poller.pollOnce();
  await settle();

  assert.ok(f.observed.includes("idle->printing"), "command read reaches the canonical run observer");
  assert.equal(f.poller.today.getDone(), 1);
  assert.equal(f.consumed.length, 1, "the post-start read created the tracked run");
  assert.equal(f.poller.filament.listUnreconciled().length, 0);
});

test("a command-observed cancellation closes its run without inventing success or deducting twice", async () => {
  const f = fixture();
  await begin(f);
  globalThis.fetch = (async (input: string | URL | Request) => {
    assert.match(String(input), /\/printer\/print\/cancel$/);
    f.set({ stateText: "cancelled", progressPct: 30, filamentUsedMm: 500 });
    return { ok: true, status: 200, json: async () => ({ result: "ok" }) } as Response;
  }) as typeof globalThis.fetch;

  await f.commands.cancel("k2");
  await f.poller.pollOnce();
  await settle();

  assert.equal(f.observed.filter((edge) => edge === "printing->idle").length, 1);
  assert.equal(f.poller.today.getDone(), 0);
  assert.equal(f.consumed.length, 1);
  assert.equal(f.events.list().filter((event) => event.text.endsWith("отменена")).length, 1);
});

test("a command refresh records a technical failure once", async () => {
  const f = fixture();
  await begin(f);
  f.set({ status: "error", stateText: "error", error: "heater failed", filamentUsedMm: 500 });
  await f.commands.setLight("k2", true);
  await f.poller.pollOnce();
  await settle();

  assert.equal(f.poller.today.getFailed(), 1);
  assert.equal(f.poller.today.getDone(), 0);
  assert.equal(f.observed.filter((edge) => edge === "printing->error").length, 1);
  assert.equal(f.consumed.length, 1);
});

test("immediate pause and resume observations keep the same run through completion", async () => {
  const f = fixture();
  await begin(f);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    assert.match(url, /\/printer\/print\/(pause|resume)$/);
    f.set(url.endsWith("/pause")
      ? { status: "paused", stateText: "paused", progressPct: 50 }
      : { status: "printing", stateText: "printing", progressPct: 50 });
    return { ok: true, status: 200, json: async () => ({ result: "ok" }) } as Response;
  }) as typeof globalThis.fetch;

  await f.commands.pause("k2");
  await f.commands.resume("k2");
  f.set({ stateText: "complete", progressPct: 100, filamentUsedMm: 1000 });
  await f.poller.pollOnce();
  await settle();

  assert.equal(f.observed.filter((edge) => edge === "printing->paused").length, 1);
  assert.equal(f.observed.filter((edge) => edge === "paused->printing").length, 1);
  assert.equal(f.events.list().filter((event) => event.text.includes("начал печать")).length, 1);
  assert.equal(f.poller.today.getDone(), 1);
  assert.equal(f.consumed.length, 1);
});

test("poll and command reads are serialized so an older pending read cannot overwrite a newer transition", async () => {
  const f = fixture();
  await begin(f);
  let release!: (value: PrinterLiveStatus) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const earlier = f.poller.refreshStatus(f.config, () => {
    began();
    return new Promise<PrinterLiveStatus>((resolve) => { release = resolve; });
  });
  await started;
  f.set({ stateText: "complete", progressPct: 100, filamentUsedMm: 1000 });
  const command = f.commands.setLight("k2", true);
  await settle();
  assert.equal(f.poller.getStatus("k2")?.status, "printing", "the later read waits for the earlier read");
  release(status(f.config, { status: "printing", stateText: "printing", progressPct: 90 }));
  await Promise.all([earlier, command]);
  await settle();

  assert.equal(f.poller.getStatus("k2")?.stateText, "complete");
  assert.equal(f.poller.today.getDone(), 1);
  assert.equal(f.observed.filter((edge) => edge === "printing->idle").length, 1);
});

test("temporarily disabling a printer does not discard its in-flight status-read lock", async () => {
  const f = fixture();
  await begin(f);
  let release!: (value: PrinterLiveStatus) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  const earlier = f.poller.refreshStatus(f.config, () => {
    began();
    return new Promise<PrinterLiveStatus>((resolve) => { release = resolve; });
  });
  await started;
  f.setEnabled(false);
  await f.poller.pollOnce();
  f.setEnabled(true);
  let laterReadStarted = false;
  const later = f.poller.refreshStatus(f.config, async () => {
    laterReadStarted = true;
    return status(f.config, { stateText: "complete", progressPct: 100 });
  });
  await settle();
  assert.equal(laterReadStarted, false, "re-enabled printer remains serialized behind the original read");
  release(status(f.config, { status: "printing", stateText: "printing", progressPct: 90 }));
  await Promise.all([earlier, later]);
  assert.equal(f.poller.getStatus(f.config.id)?.stateText, "complete");
});

test("an unknown print report cannot erase the lifecycle edge used by a later command refresh", async () => {
  const f = fixture();
  await begin(f);
  f.set({ status: "unknown", currentFile: null, nozzleTemp: 210 });
  await f.poller.pollOnce();
  assert.equal(f.poller.getStatus(f.config.id)?.status, "unknown", "partial telemetry remains visible");
  assert.ok(f.observed.every((edge) => !edge.endsWith("->unknown")), "unknown carries no lifecycle verdict");
  f.set({ stateText: "complete", progressPct: 100, filamentUsedMm: 1000 });
  await f.commands.setLight(f.config.id, true);
  await f.poller.pollOnce();
  await settle();
  assert.equal(f.observed.filter((edge) => edge === "printing->idle").length, 1);
  assert.equal(f.poller.today.getDone(), 1);
  assert.equal(f.consumed.length, 1);
});
