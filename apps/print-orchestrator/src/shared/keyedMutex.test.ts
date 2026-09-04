import assert from "node:assert/strict";
import test from "node:test";

import { KeyedMutex } from "./keyedMutex";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("tasks on one key run strictly one after another", async () => {
  const mutex = new KeyedMutex();
  const order: string[] = [];
  const first = mutex.run("k", async () => {
    order.push("a:start");
    await tick();
    order.push("a:end");
  });
  const second = mutex.run("k", async () => {
    order.push("b:start");
    order.push("b:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("different keys do not block each other", async () => {
  const mutex = new KeyedMutex();
  let released!: () => void;
  const gate = new Promise<void>((resolve) => (released = resolve));
  const held = mutex.run("a", () => gate);
  const other = await mutex.run("b", async () => "done");
  assert.equal(other, "done");
  released();
  await held;
});

test("a failing task does not break the chain, and the rejection reaches its caller", async () => {
  const mutex = new KeyedMutex();
  const failed = mutex.run("k", async () => {
    throw new Error("boom");
  });
  await assert.rejects(failed, /boom/);
  assert.equal(await mutex.run("k", async () => "after"), "after");
});

/*
 * The blob-lock case: the artifact orphan sweep locks every stored key in turn.
 * A chain that never forgot a drained key made the map grow to the size of the
 * whole store and stay there for the life of the process.
 */
test("drained chains are forgotten — the map does not grow with the key space", async () => {
  const mutex = new KeyedMutex();
  for (let i = 0; i < 100; i++) {
    await mutex.run(`sha256/aa/${i}`, async () => i);
  }
  assert.equal(mutex.size, 0, "every finished key is dropped");
});

test("a key with work still queued is kept — cleanup never releases the lock early", async () => {
  const mutex = new KeyedMutex();
  let released!: () => void;
  const gate = new Promise<void>((resolve) => (released = resolve));
  const running: string[] = [];

  const first = mutex.run("k", async () => {
    running.push("first");
    await gate;
  });
  const second = mutex.run("k", async () => {
    running.push("second");
  });
  assert.equal(mutex.size, 1);

  await tick();
  assert.deepEqual(running, ["first"], "the second task waits");
  released();
  await Promise.all([first, second]);
  assert.deepEqual(running, ["first", "second"]);
  assert.equal(mutex.size, 0);
});
