import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { JobError } from "../core/errors";
import { FarmStore } from "./farmStore";

/*
 * The file-browser start (`POST /api/printers/:id/print` → `startPrinterFile`)
 * is the operator's "run this file" escape hatch. It creates no task and no run,
 * but it DOES reach a device — so it must not be a way around the bed model.
 *
 * A Moonraker printer is configured with its HTTP mocked (file listing, status,
 * print start), so the whole path runs without a real device.
 */

let dir: string;
let file: string;
let realFetch: typeof globalThis.fetch;
let startCalls: string[];

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-direct-"));
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
    if (url.includes("/server/files/directory")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            files: [{ filename: "part.gcode", size: 1000, modified: 0 }],
            dirs: []
          }
        })
      } as unknown as Response;
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

test("the file browser can start a file while the bed is genuinely free", async () => {
  const store = new FarmStore(file);
  await store.start();

  await store.commands.startPrinterFile("k2", "part.gcode");
  assert.equal(startCalls.length, 1, "the direct start reached the device");

  await store.stop();
});

test("the file browser cannot start over a bed that still holds a finished part", async () => {
  const store = new FarmStore(file);
  await store.start();

  // Run one queue job to completion so the printer's bed cycle ends up
  // AWAITING_CLEARANCE — the state the whole night model hinges on.
  store.addQueueJob({ title: "First", printer: "k2", material: "PLA", file: "part.gcode" });
  const { runId } = await store.startNext();
  store.commands.resolveRun(runId, "SUCCEEDED");
  assert.equal(startCalls.length, 1, "only the queued print has started so far");

  // The escape hatch must refuse just like the canonical dispatch does; without
  // this guard the file browser was a complete bypass of the bed model.
  // The guard refuses before any await, so the thunk form is required here.
  await assert.rejects(
    async () => store.commands.startPrinterFile("k2", "part.gcode"),
    (e: unknown) => e instanceof JobError && /осталась готовая модель|не подтверждён свободным/.test(e.message)
  );
  assert.equal(startCalls.length, 1, "nothing new reached the device");

  await store.stop();
});

test("after an explicit clearance the file browser works again", async () => {
  const store = new FarmStore(file);
  await store.start();

  store.addQueueJob({ title: "First", printer: "k2", material: "PLA", file: "part.gcode" });
  const { runId } = await store.startNext();
  store.commands.resolveRun(runId, "SUCCEEDED");

  const bed = store.commands.clearBed("k2", "part_removed", { actor: "operator-2" });
  assert.equal(bed.state, "CLEAR");
  assert.equal(bed.metadata.clearance, "part_removed");
  assert.equal(bed.metadata.clearedBy, "operator-2");

  // The bed objection is gone. A start immediately after another may still hit
  // the unrelated, pre-existing "command just sent" hold, so the assertion is on
  // the *reason*: whatever happens next, it is no longer the bed.
  await store.commands.startPrinterFile("k2", "part.gcode").catch((error: unknown) => {
    assert.ok(
      error instanceof JobError && /только что отправлена команда/.test(error.message),
      `unexpected refusal after clearance: ${String(error)}`
    );
  });

  await store.stop();
});

test("clearBed refuses an auto_cleared claim for a printer with no verified mechanism", async () => {
  const store = new FarmStore(file);
  await store.start();

  store.addQueueJob({ title: "First", printer: "k2", material: "PLA", file: "part.gcode" });
  const { runId } = await store.startNext();
  store.commands.resolveRun(runId, "SUCCEEDED");

  // The farm config declares no automatic continuation for this K2, so a driver
  // (or an operator picking the wrong option) cannot claim the plate cleared itself.
  assert.throws(
    () => store.commands.clearBed("k2", "auto_cleared"),
    /нет подтверждённой автоматической очистки/
  );

  await store.stop();
});
