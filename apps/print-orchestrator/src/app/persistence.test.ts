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

test("the operator queue and its id sequence survive a restart", async () => {
  const first = new FarmStore(file);
  first.addQueueJob({ title: "Chalice", printer: "K2", material: "PLA" });
  first.addQueueJob({ title: "Base" }); // no printer → review
  await first.flush();

  const restarted = new FarmStore(file);
  const queue = restarted.reads.getQueue();
  assert.equal(queue.length, 2);
  assert.equal(queue[0].id, "q1");
  assert.equal(queue[0].title, "Chalice");
  assert.equal(queue[0].status, "ready");
  assert.equal(queue[1].id, "q2");
  assert.equal(queue[1].status, "review");
  assert.equal(queue[1].reason, "не задан принтер");

  // The id sequence continues from the restored value — no collision with q2.
  const added = restarted.addQueueJob({ title: "Lid", printer: "K2" });
  assert.equal(added.id, "q3");
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

test("the persisted file is the JSON contract the dashboard shapes rely on", async () => {
  const first = new FarmStore(file);
  first.addQueueJob({ title: "Chalice", printer: "K2", material: "PLA", eta: "2ч" });
  await first.flush();

  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.queue.seq, 1);
  assert.equal(raw.queue.jobs[0].title, "Chalice");
  assert.ok(Array.isArray(raw.feed));
  assert.ok("today" in raw);
});
