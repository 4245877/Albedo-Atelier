import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { JobError } from "../core/errors";
import { FarmStore } from "./farmStore";

/*
 * The file-browser start (`POST /api/printers/:id/print` → `startPrinterFile`)
 * is the operator's "run this file" escape hatch — and it must not be a second
 * dispatch path. It now creates a managed task + a manual assignment + a device
 * -file record and calls the SAME `DispatchService.startAssignment` everything
 * else does, so every check (bed, file identity, DispatchEligibility, the start
 * guard, idempotency, the audit trail) applies to it too.
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

test("the file browser start goes through the canonical dispatch, not the driver", async () => {
  const store = new FarmStore(file);
  await store.start();

  const result = await store.commands.startPrinterFile("k2", "part.gcode");
  assert.equal(startCalls.length, 1, "the direct start reached the device");

  // The escape hatch is now a *managed* start: task → assignment → run, all
  // durable and traceable. Before this it produced none of them, which is exactly
  // what made it a bypass of every check the canonical path performs.
  const detail = store.printQueue.getTaskDetail(result.taskId);
  assert.equal(detail.task.state, "PRINTING");
  assert.equal(detail.task.onDeviceFile, "part.gcode");

  const assignment = store.printQueue.getAssignment(result.assignmentId);
  assert.equal(assignment.state, "ACTIVE");
  assert.equal(assignment.source, "manual");
  assert.match(assignment.reason ?? "", /файлового браузера/);
  assert.equal(assignment.binding.expectedRemotePath, "part.gcode");

  const run = detail.printRuns.find((r) => r.id === result.runId)!;
  assert.equal(run.assignmentId, result.assignmentId, "the run traces to the assignment");
  assert.equal(run.file, "part.gcode");

  // The file that was found on the device is recorded as adopted, not as
  // something the orchestrator delivered.
  const device = store.deviceArtifacts.listForPrinter("k2").find((d) => d.remotePath === "part.gcode")!;
  assert.equal(device.transferMode, "manual_file_transfer");
  assert.equal(device.confirmedBy, "operator");

  // …and the whole thing is journalled.
  const audit = store.printQueue.listAudit(300);
  assert.ok(audit.some((e) => e.entityType === "assignment" && e.action === "assigned_manually"));
  assert.ok(audit.some((e) => e.entityType === "print_run" && e.action === "started"));

  await store.stop();
});

test("the file browser refuses a file that is not actually on the printer", async () => {
  const store = new FarmStore(file);
  await store.start();

  await assert.rejects(
    async () => store.commands.startPrinterFile("k2", "ghost.gcode"),
    (e: unknown) => e instanceof Error && /ghost\.gcode/.test(e.message)
  );
  assert.equal(startCalls.length, 0, "nothing reached the device");

  await store.stop();
});

test("the file browser cannot start over a bed that still holds a finished part", async () => {
  const store = new FarmStore(file);
  await store.start();

  // Run one queue job to completion so the printer's bed cycle ends up
  // AWAITING_CLEARANCE — the state the whole night model hinges on.
  // One print run through the same file-browser path (which adopts and verifies
  // the on-device file), so the bed ends up holding a finished part.
  const { runId } = await store.commands.startPrinterFile("k2", "part.gcode");
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

  // One print run through the same file-browser path (which adopts and verifies
  // the on-device file), so the bed ends up holding a finished part.
  const { runId } = await store.commands.startPrinterFile("k2", "part.gcode");
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

  // One print run through the same file-browser path (which adopts and verifies
  // the on-device file), so the bed ends up holding a finished part.
  const { runId } = await store.commands.startPrinterFile("k2", "part.gcode");
  store.commands.resolveRun(runId, "SUCCEEDED");

  // The farm config declares no automatic continuation for this K2, so a driver
  // (or an operator picking the wrong option) cannot claim the plate cleared itself.
  assert.throws(
    () => store.commands.clearBed("k2", "auto_cleared"),
    /нет подтверждённой автоматической очистки/
  );

  await store.stop();
});
