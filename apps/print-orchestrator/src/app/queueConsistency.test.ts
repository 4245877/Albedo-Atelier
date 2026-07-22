import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { JobError, NotFoundError, ValidationError } from "../core/errors";
import { FarmStore } from "./farmStore";

/*
 * Cross-interface consistency: the simplified queue/night dashboard and the
 * scheduler are TWO views over ONE model (the SQLite print queue). This suite
 * proves they never fork — same jobs, same order, same lifecycle, and the same
 * night rule — by exercising the exact service methods the two route sets are
 * one-line delegates to:
 *
 *   legacy  /api/queue*             → store.reads.getQueue/getNight,
 *                                     store.addQueueJob/removeQueueJob/
 *                                     reviewQueueJob/startNight
 *   scheduler /api/print/scheduler* → store.printQueue.listOpenQueue/addTask/
 *                                     reorderTask/setTaskScheduling
 *   dashboard /api/dashboard        → store.reads.snapshot
 *
 * A Moonraker printer is configured and its HTTP mocked so `start()` runs
 * without a real device; `pollOnce()` settles telemetry so the night gate is
 * evaluated against a stable idle status.
 */

let dir: string;
let file: string;
let realFetch: typeof globalThis.fetch;

const config = JSON.stringify([
  { id: "k2", name: "Creality K2", protocol: "moonraker", host: "127.0.0.1", port: 4408, type: "FDM", material: "PLA" }
]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-consistency-"));
  file = path.join(dir, "state.json");
  process.env.PRINTERS_CONFIG_PATH = path.join(dir, "no-such-file.json");
  process.env.PRINTERS_CONFIG_JSON = config;

  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
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

/** A started store with settled telemetry. */
async function startedStore(): Promise<FarmStore> {
  const store = new FarmStore(file);
  await store.start();
  await store.pollOnce();
  return store;
}

test("both interfaces read the SAME jobs in the SAME order (one source)", async () => {
  const store = await startedStore();
  store.addQueueJob({ title: "First", printer: "k2", file: "a.gcode" });
  store.addQueueJob({ title: "Second", printer: "k2", file: "b.gcode" });
  store.addQueueJob({ title: "Third", printer: "k2", file: "c.gcode" });

  const legacyIds = store.reads.getQueue().map((j) => j.id); // GET /api/queue
  const schedulerIds = store.printQueue.listOpenQueue().map((r) => r.task.id); // GET /api/print/scheduler/queue

  assert.deepEqual(legacyIds, schedulerIds, "same task ids, same order in both interfaces");
  assert.equal(legacyIds.length, 3);
  await store.stop();
});

test("a task added through the SCHEDULER surfaces in the legacy queue and the dashboard snapshot", async () => {
  const store = await startedStore();
  const detail = store.printQueue.addTask({ title: "Scheduled" }); // POST /api/print/scheduler/queue

  assert.ok(
    store.reads.getQueue().some((j) => j.id === detail.task.id),
    "legacy /api/queue sees the scheduler-added task"
  );
  assert.ok(
    store.reads.snapshot().queue.some((j) => j.id === detail.task.id),
    "the /api/dashboard snapshot sees it too"
  );
  await store.stop();
});

test("a task added through the LEGACY endpoint surfaces in the scheduler queue", async () => {
  const store = await startedStore();
  const job = store.addQueueJob({ title: "Quick", printer: "k2", file: "q.gcode" }); // POST /api/queue

  assert.ok(
    store.printQueue.listOpenQueue().some((r) => r.task.id === job.id),
    "the scheduler queue sees the legacy-added task"
  );
  await store.stop();
});

test("reordering through the scheduler changes the order BOTH interfaces see", async () => {
  const store = await startedStore();
  store.addQueueJob({ title: "A", printer: "k2", file: "a.gcode" });
  const b = store.addQueueJob({ title: "B", printer: "k2", file: "b.gcode" });

  const rows = store.printQueue.listOpenQueue();
  const bRow = rows.find((r) => r.task.id === b.id)!;
  const aRow = rows.find((r) => r.task.title === "A")!;
  // Move B above A — the same move the dashboard ↑ button makes.
  store.printQueue.reorderTask(bRow.task.id, aRow.entry.position - 1, bRow.entry.version); // POST reorder

  const legacyIds = store.reads.getQueue().map((j) => j.id);
  const schedulerIds = store.printQueue.listOpenQueue().map((r) => r.task.id);
  assert.deepEqual(legacyIds, schedulerIds, "order stays identical across interfaces");
  assert.equal(legacyIds[0], b.id, "B is now first in BOTH views");
  await store.stop();
});

test("removing through the legacy endpoint is reflected in the scheduler queue", async () => {
  const store = await startedStore();
  const a = store.addQueueJob({ title: "A", printer: "k2", file: "a.gcode" });
  store.addQueueJob({ title: "B", printer: "k2", file: "b.gcode" });

  store.removeQueueJob(a.id); // DELETE /api/queue/:id

  assert.ok(
    !store.printQueue.listOpenQueue().some((r) => r.task.id === a.id),
    "the scheduler no longer lists the removed task"
  );
  assert.equal(store.reads.getQueue().length, 1, "the legacy queue also dropped it");
  await store.stop();
});

test("holding through the legacy endpoint uses ONE lifecycle both interfaces agree on", async () => {
  const store = await startedStore();
  const a = store.addQueueJob({ title: "A", printer: "k2", file: "a.gcode" });

  store.reviewQueueJob(a.id, "проверить сопло"); // POST /api/queue/:id/review

  const legacy = store.reads.getQueue().find((j) => j.id === a.id)!;
  assert.equal(legacy.status, "review", "legacy shows it parked for review");

  const row = store.printQueue.listOpenQueue().find((r) => r.task.id === a.id)!;
  assert.equal(row.task.state, "NEEDS_REVIEW", "the scheduler sees the SAME canonical task state");
  assert.equal(row.entry.state, "HELD", "and the SAME queue-entry state");
  await store.stop();
});

test("a priority change through the scheduler does not fork the task", async () => {
  const store = await startedStore();
  const detail = store.printQueue.addTask({ title: "Prio" });
  store.printQueue.setTaskScheduling(detail.task.id, { priority: 50 }); // POST params

  const legacyIds = store.reads.getQueue().map((j) => j.id);
  const schedulerIds = store.printQueue.listOpenQueue().map((r) => r.task.id);
  assert.deepEqual(legacyIds, schedulerIds, "still one task, one id, both interfaces");
  assert.equal(
    store.printQueue.getTask(detail.task.id).priority,
    50,
    "the change landed on the single canonical task"
  );
  await store.stop();
});

test("night: the dashboard shows EXACTLY the blockers the night start enforces (one rule set)", async () => {
  const store = await startedStore();
  // Night-flagged but not actually startable: a bare on-printer file with no
  // registered artifact/hash/analysis and an unknown loaded-vs-job material.
  const job = store.addQueueJob({
    title: "Mystery",
    printer: "k2",
    night: true,
    material: "PLA",
    eta: "2ч",
    file: "mystery.gcode"
  });

  const night = store.reads.getNight(); // GET /api/queue/night  (== dashboard .night)
  const candidate = night.candidates.find((c) => c.taskId === job.id) ?? night.candidates[0];
  assert.ok(candidate, "the job appears as a night candidate");
  assert.ok(candidate.blockers.length > 0, "the dashboard shows it blocked, not startable");

  // The physical start refuses with those very reasons — display == enforcement.
  await assert.rejects(
    () => store.startNight({ taskId: candidate.taskId, artifactSha256: candidate.artifactSha256 }), // POST /api/queue/night/start
    (e: unknown) =>
      e instanceof JobError && candidate.blockers.every((b) => e.message.includes(b))
  );
  await store.stop();
});

test("an invalid operation is refused the same way through either interface", async () => {
  const store = await startedStore();

  // Empty title is a ValidationError whether added via the legacy quick-add or
  // the scheduler — one validation, one result.
  assert.throws(() => store.addQueueJob({ title: "   " }), (e: unknown) => e instanceof ValidationError);
  assert.throws(() => store.printQueue.addTask({ title: "   " }), (e: unknown) => e instanceof ValidationError);

  // An unknown id is a NotFoundError on the legacy mutation path.
  assert.throws(() => store.removeQueueJob("does-not-exist"), (e: unknown) => e instanceof NotFoundError);
  await store.stop();
});
