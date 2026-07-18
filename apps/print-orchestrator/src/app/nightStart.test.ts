import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { JobError } from "../core/errors";
import { FarmStore } from "./farmStore";

/*
 * Physical night (unattended) start — the path POST /api/queue/night/start
 * drives (a one-line delegate to FarmStore.startNight). A Moonraker printer is
 * configured and its HTTP mocked, so the full path (build plan → gate → POST
 * /printer/print/start → drop the job) runs without a real device.
 *
 * The safety rule under test: an unattended launch is fail-closed — only an
 * explicitly night-marked, blocker-free, materially-verified job may start, and
 * exactly the job the plan shows.
 */

let dir: string;
let file: string;
let realFetch: typeof globalThis.fetch;
let startCalls: string[];

const config = JSON.stringify([
  { id: "k2", name: "Creality K2", protocol: "moonraker", host: "127.0.0.1", port: 4408, type: "FDM", material: "PLA" }
]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-night-"));
  file = path.join(dir, "state.json");
  startCalls = [];

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
        json: async () => ({ result: { status: { print_stats: { state: "standby" } } } })
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PRINTERS_CONFIG_PATH;
  delete process.env.PRINTERS_CONFIG_JSON;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unmarked ready job is never launched unattended, and nothing is dispatched", async () => {
  const store = new FarmStore(file);
  await store.start();
  // Ready and otherwise startable, but NOT flagged night.
  store.addQueueJob({ title: "Part", printer: "k2", material: "PLA", file: "part.gcode" });

  await assert.rejects(() => store.startNight(), (e: unknown) => e instanceof JobError);
  assert.equal(startCalls.length, 0, "no unattended start reached the device");
  assert.equal(store.reads.getQueue().length, 1, "the job stays queued");

  await store.stop();
});

test("the unknown.gcode / unknown-material / client-ETA case is blocked for unattended print", async () => {
  const store = new FarmStore(file);
  await store.start();
  // Marked night, but the material is unknown and the file is a bare unverified
  // name with only a client-supplied ETA — exactly the diagnostic that used to
  // pass with blockers: []. It must now be refused.
  store.addQueueJob({ title: "Mystery", printer: "k2", night: true, eta: "2ч", file: "unknown.gcode" });

  await assert.rejects(
    () => store.startNight(),
    (e: unknown) => e instanceof JobError && /материал не подтверждён/.test(e.message)
  );
  assert.equal(startCalls.length, 0);

  await store.stop();
});

test("a night-flagged job with a contradicting material is refused", async () => {
  const store = new FarmStore(file);
  await store.start();
  store.addQueueJob({ title: "Vase", printer: "k2", night: true, material: "PETG", eta: "2ч", file: "vase.gcode" });

  await assert.rejects(() => store.startNight(), (e: unknown) => e instanceof JobError);
  assert.equal(startCalls.length, 0);

  await store.stop();
});

test("a fully-qualified night job (marked, known material, valid file, idle) starts exactly once", async () => {
  const store = new FarmStore(file);
  await store.start();
  store.addQueueJob({ title: "Chalice", printer: "k2", night: true, material: "PLA", eta: "2ч", file: "chalice.gcode" });

  const result = await store.startNight();
  assert.equal(result.candidate.title, "Chalice");
  assert.equal(startCalls.length, 1, "the confirmed unattended job was dispatched once");
  assert.ok(startCalls[0].includes("filename=chalice.gcode"));
  assert.deepEqual(store.reads.getQueue(), [], "the launched job left the queue");

  await store.stop();
});
