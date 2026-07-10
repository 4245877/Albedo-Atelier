import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { JobError } from "../core/errors";
import { FarmStore } from "./farmStore";

/*
 * Remote start of the next ready queue job. A Moonraker printer is configured
 * via PRINTERS_CONFIG_JSON and its HTTP endpoints are mocked, so the whole path
 * (resolve printer → guard state → POST /printer/print/start → drop the job) is
 * exercised without a real device. Unsupported/invalid cases fail honestly.
 */

let dir: string;
let file: string;
let realFetch: typeof globalThis.fetch;
let startCalls: string[];
let printState: string;

const config = JSON.stringify([
  {
    id: "k2",
    name: "Creality K2",
    protocol: "moonraker",
    host: "127.0.0.1",
    port: 4408,
    type: "FDM",
    material: "PLA"
  }
]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-start-"));
  file = path.join(dir, "state.json");
  startCalls = [];
  printState = "standby"; // → idle

  process.env.PRINTERS_CONFIG_PATH = path.join(dir, "no-such-file.json");
  process.env.PRINTERS_CONFIG_JSON = config;

  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/printer/print/start")) {
      startCalls.push(url);
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
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

afterEach(async () => {
  globalThis.fetch = realFetch;
  delete process.env.PRINTERS_CONFIG_PATH;
  delete process.env.PRINTERS_CONFIG_JSON;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("starts the next ready job on its Moonraker printer and drops it from the queue", async () => {
  const store = new FarmStore(file);
  await store.start();
  store.addQueueJob({ title: "Chalice", printer: "k2", material: "PLA", file: "chalice.gcode" });

  const result = await store.startNext();
  assert.equal(result.printer, "Creality K2");
  assert.equal(result.job.title, "Chalice");
  assert.equal(startCalls.length, 1, "a real print-start request was sent");
  assert.ok(startCalls[0].includes("filename=chalice.gcode"));
  assert.deepEqual(store.reads.getQueue(), [], "the started job left the queue");

  await store.stop();
});

test("refuses a job with no print file (honest, not a fake start)", async () => {
  const store = new FarmStore(file);
  await store.start();
  store.addQueueJob({ title: "Base", printer: "k2" });

  await assert.rejects(() => store.startNext(), (err: unknown) => {
    assert.ok(err instanceof JobError);
    assert.match((err as JobError).message, /не задан файл/);
    return true;
  });
  assert.equal(startCalls.length, 0);
  assert.equal(store.reads.getQueue().length, 1, "the job stays queued");

  await store.stop();
});

test("refuses a job whose printer is not in the farm config", async () => {
  const store = new FarmStore(file);
  await store.start();
  store.addQueueJob({ title: "Orphan", printer: "ghost-printer", file: "x.gcode" });

  await assert.rejects(() => store.startNext(), /не найден/);
  assert.equal(startCalls.length, 0);

  await store.stop();
});

test("an empty ready queue is an honest error", async () => {
  const store = new FarmStore(file);
  await store.start();

  await assert.rejects(() => store.startNext(), /нет заданий/);

  await store.stop();
});
