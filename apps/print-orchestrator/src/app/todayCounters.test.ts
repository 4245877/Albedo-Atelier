import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import type { CameraService } from "./cameraService";
import { EventFeed } from "./eventFeed";
import { PrinterPoller } from "./printerPoller";
import { TodayCounters } from "./todayCounters";

/*
 * Today's completion/failure counters are hydrated from persisted state and
 * persisted again whenever the poller observes a transition, so they survive a
 * same-day restart (and reset cleanly once the day rolls over). The first
 * block tests the TodayCounters accumulator directly; the rest drive it the
 * way production does — through the poller's observed transitions.
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

// ── TodayCounters directly (no poller) ─────────────────────────────────────

test("TodayCounters: completions, failures and the average accumulate and serialize", () => {
  const counters = new TodayCounters();
  counters.recordCompleted(30 * 60 * 1000);
  counters.recordCompleted(60 * 60 * 1000);
  counters.recordCompleted(null); // untimed run: counts as done, skips the average
  counters.recordFailed();

  assert.equal(counters.getDone(), 3);
  assert.equal(counters.getFailed(), 1);
  assert.equal(counters.getAvgPrintMs(), 45 * 60 * 1000, "mean of the two timed runs");

  const persisted = counters.serialize();
  assert.equal(persisted.key, today());
  assert.equal(persisted.done, 3);
  assert.equal(persisted.avgDurationCount, 2);

  // A fresh instance hydrated from that projection reads back identically.
  const restored = new TodayCounters(persisted);
  assert.deepEqual(restored.serialize(), persisted);
});

test("TodayCounters: a stale persisted day resets on the first read", () => {
  const counters = new TodayCounters({
    key: "2000-01-01",
    done: 9,
    failed: 4,
    printingMs: 1000,
    avgDurationMsTotal: 1000,
    avgDurationCount: 1
  });
  assert.equal(counters.getDone(), 0);
  assert.equal(counters.getFailed(), 0);
  assert.equal(counters.getHoursUsed(), 0);
  assert.equal(counters.getAvgPrintMs(), null);
});

test("TodayCounters: creditPrintingInterval clips to local midnight and caps a huge gap", () => {
  const counters = new TodayCounters();
  const now = Date.now();

  // A normal 10 s interval is credited in full.
  assert.equal(counters.creditPrintingInterval(now - 10_000, now), 10_000);

  // An interval reaching back before local midnight only credits today's part
  // (which is also subject to the max-accrual cap, so just assert the bound).
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const sinceMidnight = now - midnight.getTime();
  const credited = counters.creditPrintingInterval(midnight.getTime() - 60 * 60 * 1000, now);
  assert.ok(credited <= sinceMidnight, "nothing from before midnight is credited");

  // A wall-clock jump far beyond the poll cadence cannot inject hours.
  const capped = counters.creditPrintingInterval(now - 24 * 60 * 60 * 1000, now);
  assert.ok(capped <= 5 * 60 * 1000, `a hung poll credits at most the cap, got ${capped}`);
});

// ── Through the poller (hydration + observed transitions) ──────────────────

test("hydrates today counters from persisted state (same day)", () => {
  const poller = new PrinterPoller(() => [], cameras, new EventFeed(), noop, {
    key: today(),
    done: 5,
    failed: 2,
    printingMs: 2 * 60 * 60 * 1000, // 2 observed printer-hours
    avgDurationMsTotal: 90 * 60 * 1000, // two runs, 45 min mean
    avgDurationCount: 2
  });
  assert.equal(poller.today.getDone(), 5);
  assert.equal(poller.today.getFailed(), 2);
  assert.equal(poller.today.getHoursUsed(), 2);
  assert.equal(poller.today.getAvgPrintMs(), 45 * 60 * 1000);
  assert.deepEqual(poller.today.serialize(), {
    key: today(),
    done: 5,
    failed: 2,
    printingMs: 2 * 60 * 60 * 1000,
    avgDurationMsTotal: 90 * 60 * 1000,
    avgDurationCount: 2
  });
});

test("resets hydrated counters when the persisted day has already passed", () => {
  const poller = new PrinterPoller(() => [], cameras, new EventFeed(), noop, {
    key: "2000-01-01",
    done: 5,
    failed: 2,
    printingMs: 2 * 60 * 60 * 1000,
    avgDurationMsTotal: 90 * 60 * 1000,
    avgDurationCount: 2
  });
  assert.equal(poller.today.getDone(), 0);
  assert.equal(poller.today.getFailed(), 0);
  assert.equal(poller.today.getHoursUsed(), 0);
  assert.equal(poller.today.getAvgPrintMs(), null, "a passed day resets the average to нет данных");
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
  assert.equal(poller.today.getDone(), 0);

  printState = "complete";
  await poller.pollOnce(); // printing → idle(complete)

  assert.equal(poller.today.getDone(), 1, "the completion was counted");
  assert.ok(saves >= 1, "the counter change was persisted");
  assert.equal(poller.today.serialize().done, 1);
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
  assert.equal(poller.today.getDone(), 1, "the single print is counted exactly once");
});
