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

test("the persisted JSON keeps its shape, but the queue section is frozen (SQLite is canonical)", async () => {
  const first = new FarmStore(file);
  first.addQueueJob({ title: "Chalice", printer: "K2", material: "PLA", eta: "2ч" });
  await first.flush();

  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
  // New jobs land ONLY in SQLite — the legacy queue section stays as it was
  // (empty here), preserved verbatim for rollback, never written to.
  assert.ok(Array.isArray(raw.queue.jobs));
  assert.equal(raw.queue.jobs.length, 0, "the JSON queue no longer receives new jobs");
  assert.ok(Array.isArray(raw.feed));
  assert.ok(
    raw.feed.some((e: { text: string }) => e.text.includes("Chalice")),
    "the add event still lands in the feed"
  );
  assert.ok("today" in raw);
});
