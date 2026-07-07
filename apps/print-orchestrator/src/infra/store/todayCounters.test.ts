import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { PrinterConfig } from "../printers/config";
import type { CameraService } from "./cameraService";
import { EventFeed } from "./eventFeed";
import { PrinterPoller } from "./printerPoller";

/*
 * Today's completion/failure counters are hydrated from persisted state and
 * persisted again whenever the poller observes a transition, so they survive a
 * same-day restart (and reset cleanly once the day rolls over).
 */

const cameras = { probe: async () => {} } as unknown as CameraService;
const noop = () => {};

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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

test("hydrates today counters from persisted state (same day)", () => {
  const poller = new PrinterPoller(() => [], cameras, new EventFeed(), noop, {
    key: today(),
    done: 5,
    failed: 2
  });
  assert.equal(poller.getTodayDone(), 5);
  assert.equal(poller.getTodayFailed(), 2);
  assert.deepEqual(poller.serializeToday(), { key: today(), done: 5, failed: 2 });
});

test("resets hydrated counters when the persisted day has already passed", () => {
  const poller = new PrinterPoller(() => [], cameras, new EventFeed(), noop, {
    key: "2000-01-01",
    done: 5,
    failed: 2
  });
  assert.equal(poller.getTodayDone(), 0);
  assert.equal(poller.getTodayFailed(), 0);
});

// ── A real printing→complete transition persists the incremented counter ──

let realFetch: typeof globalThis.fetch;
let printState: string;
let httpFail: boolean;

beforeEach(() => {
  printState = "standby";
  httpFail = false;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (httpFail) return { ok: false, status: 502, json: async () => ({}) } as unknown as Response;
    if (url.includes("/printer/objects/query")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { status: { print_stats: { state: printState } } } })
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a completion transition increments and persists the done counter", async () => {
  let saves = 0;
  const printer = k2();
  const poller = new PrinterPoller(() => [printer], cameras, new EventFeed(), () => {
    saves += 1;
  });

  printState = "printing";
  await poller.pollOnce(); // baseline observation — no event, no count
  assert.equal(poller.getTodayDone(), 0);

  printState = "complete";
  await poller.pollOnce(); // printing → idle(complete)

  assert.equal(poller.getTodayDone(), 1, "the completion was counted");
  assert.ok(saves >= 1, "the counter change was persisted");
  assert.equal(poller.serializeToday().done, 1);
});

test("a reconnect mid-print does not announce a false start or double-count", async () => {
  const printer = k2();
  const feed = new EventFeed();
  const poller = new PrinterPoller(() => [printer], cameras, feed);

  printState = "printing";
  await poller.pollOnce(); // baseline: printing, online (no event)

  httpFail = true;
  await poller.pollOnce(); // lost connection → offline

  httpFail = false;
  printState = "printing";
  await poller.pollOnce(); // reconnect, still printing → only "снова на связи"

  const starts = feed.list().filter((event) => event.text.includes("начал печать"));
  assert.equal(starts.length, 0, "reconnect must not announce a brand-new print start");

  printState = "complete";
  await poller.pollOnce(); // printing → complete
  assert.equal(poller.getTodayDone(), 1, "the single print is counted exactly once");
});
