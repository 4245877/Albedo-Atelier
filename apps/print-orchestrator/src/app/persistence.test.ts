import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { FarmStore } from "./farmStore";

/*
 * End-to-end persistence: a FarmStore is created, mutated, flushed, then a fresh
 * FarmStore is built on the same file — standing in for a process restart. The
 * operator queue, its id sequence and the event feed must all come back.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-farm-"));
  file = path.join(dir, "state.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a fresh store with no file starts empty", () => {
  const store = new FarmStore(file);
  assert.deepEqual(store.reads.getQueue(), []);
  assert.deepEqual(store.reads.getFeed(), []);
});

test("the operator queue survives a restart (canonical SQLite, stable task ids)", async () => {
  const first = new FarmStore(file);
  const chalice = first.addQueueJob({ title: "Chalice", printer: "K2", material: "PLA" });
  const base = first.addQueueJob({ title: "Base" }); // no printer → review
  await first.flush();
  await first.stop();

  // A restarted store on the same paths reads the same SQLite queue — same
  // ids, same order, same statuses. No legacy JSON is consulted for this.
  const restarted = new FarmStore(file);
  const queue = restarted.reads.getQueue();
  assert.equal(queue.length, 2);
  assert.equal(queue[0].id, chalice.id);
  assert.equal(queue[0].title, "Chalice");
  assert.equal(queue[0].status, "ready");
  assert.equal(queue[1].id, base.id);
  assert.equal(queue[1].status, "review");
  assert.equal(queue[1].reason, "не задан принтер");

  // A restart must not duplicate anything (idempotent one-time import).
  const again = new FarmStore(file);
  assert.equal(again.reads.getQueue().length, 2, "no duplicates after another restart");
  const added = again.addQueueJob({ title: "Lid", printer: "K2" });
  assert.notEqual(added.id, chalice.id);
  assert.equal(again.reads.getQueue().length, 3);
});

test("the event feed survives a restart", async () => {
  const first = new FarmStore(file);
  first.addQueueJob({ title: "Chalice", printer: "K2" });
  await first.flush();

  const feed = new FarmStore(file).reads.getFeed();
  assert.ok(
    feed.some((event) => event.text.includes("Chalice")),
    "the add-to-queue event is restored"
  );
});

test("the persisted JSON keeps its non-queue shape, but no longer receives queue jobs", async () => {
  const first = new FarmStore(file);
  first.addQueueJob({ title: "Chalice", printer: "K2", material: "PLA", eta: "2ч" });
  await first.flush();

  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
  // New jobs land ONLY in SQLite. Once the one-time import has committed, the
  // JSON queue section is written empty — SQLite is the single source of truth.
  assert.ok(Array.isArray(raw.queue.jobs));
  assert.equal(raw.queue.jobs.length, 0, "the JSON queue no longer receives jobs");
  // The other durable-but-non-queue state is still persisted as before.
  assert.ok(Array.isArray(raw.feed));
  assert.ok(
    raw.feed.some((e: { text: string }) => e.text.includes("Chalice")),
    "the add event still lands in the feed"
  );
  assert.ok("today" in raw);
});

test("an old backup (legacy JSON queue) is imported into SQLite on boot, in order, without loss", async () => {
  // A backup taken before the SQLite cutover: state.json still carries the flat
  // operator queue. Restoring it must reproduce every job, in order, in SQLite.
  const legacy = {
    version: 1,
    queue: {
      seq: 3,
      jobs: [
        { id: "q1", title: "First", printer: "K2", material: "PLA", eta: "1ч", status: "ready", file: "first.gcode" },
        { id: "q2", title: "Second", printer: "K2", material: "PLA", eta: "2ч", status: "ready", file: "second.gcode" },
        { id: "q3", title: "Third", printer: "—", material: "—", eta: "—", status: "review", reason: "нет принтера" }
      ]
    }
  };
  fs.writeFileSync(file, JSON.stringify(legacy));

  const store = new FarmStore(file);
  const queue = store.reads.getQueue();
  assert.equal(queue.length, 3, "every legacy job imported");
  assert.deepEqual(
    queue.map((job) => job.title),
    ["First", "Second", "Third"],
    "legacy order preserved"
  );
  assert.equal(queue[0].status, "ready");
  assert.equal(queue[2].status, "review", "the printer-less job stays parked for review");
  await store.stop();
});

test("the legacy queue endpoints (read/review/remove) operate on the SQLite projection after import", async () => {
  // The operator queue the old `/api/queue` routes drive: GET / (reads.getQueue),
  // POST /:id/review (reviewQueueJob) and DELETE /:id (removeQueueJob) all run
  // against the SQLite model — here over jobs restored from a legacy backup.
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      queue: {
        seq: 2,
        jobs: [
          { id: "q1", title: "First", printer: "K2", material: "PLA", eta: "1ч", status: "ready" },
          { id: "q2", title: "Second", printer: "K2", material: "PLA", eta: "2ч", status: "ready" }
        ]
      }
    })
  );

  const store = new FarmStore(file);
  let queue = store.reads.getQueue(); // GET /api/queue
  assert.equal(queue.length, 2);
  const [first, second] = queue;

  // POST /api/queue/:id/review — parks the first job (still shown, now review).
  const reviewed = store.reviewQueueJob(first.id, "проверить сопло");
  assert.equal(reviewed.status, "review");
  queue = store.reads.getQueue();
  assert.equal(queue.find((job) => job.id === first.id)?.status, "review");

  // DELETE /api/queue/:id — cancels the second job; it leaves the open queue.
  store.removeQueueJob(second.id);
  const after = store.reads.getQueue();
  assert.equal(after.length, 1, "the removed job is gone from the open queue");
  assert.equal(after[0].id, first.id);
  await store.stop();
});

test("after migration the JSON queue is emptied, and a restart neither loses nor duplicates jobs", async () => {
  // Boot with two legacy jobs on disk, then add one through the live path.
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      queue: {
        seq: 2,
        jobs: [
          { id: "q1", title: "First", printer: "K2", material: "PLA", eta: "1ч", status: "ready" },
          { id: "q2", title: "Second", printer: "K2", material: "PLA", eta: "2ч", status: "ready" }
        ]
      }
    })
  );

  const first = new FarmStore(file);
  first.addQueueJob({ title: "Third", printer: "K2" }); // triggers import + a save
  await first.flush();
  await first.stop();

  // The migration marker is set, so the queue section is written empty.
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.queue.jobs.length, 0, "the queue is no longer serialized to JSON after migration");

  // A restart reads that emptied JSON queue but the jobs survive in SQLite —
  // the two imported plus the one added — with no re-import duplicates.
  const restarted = new FarmStore(file);
  const queue = restarted.reads.getQueue();
  assert.equal(queue.length, 3, "no jobs lost and none duplicated");
  assert.deepEqual(
    queue.map((job) => job.title),
    ["First", "Second", "Third"]
  );
  await restarted.stop();
});
