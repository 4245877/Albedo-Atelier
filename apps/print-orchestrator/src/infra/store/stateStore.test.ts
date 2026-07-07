import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { emptyState, StateStore, type PersistedState } from "./stateStore";

/*
 * The durable JSON store. Saving is atomic (temp file + rename) and serialized;
 * loading is synchronous and tolerant, so a missing, corrupt or hand-edited file
 * degrades to empty defaults instead of crashing startup.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-state-"));
  file = path.join(dir, "state.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sampleState(): PersistedState {
  return {
    version: 1,
    queue: {
      seq: 2,
      jobs: [
        {
          id: "q1",
          title: "Vase",
          printer: "K2",
          material: "PLA",
          eta: "2ч",
          status: "ready",
          at: "22:00",
          night: true
        },
        {
          id: "q2",
          title: "Bracket",
          printer: "—",
          material: "—",
          eta: "—",
          status: "review",
          reason: "не задан принтер"
        }
      ]
    },
    feed: [
      { icon: "＋", text: "Задание добавлено", time: "10:00", kind: "info" },
      { icon: "✔", text: "K2 завершил печать", time: "11:00", kind: "ok" }
    ],
    today: { key: "2026-07-03", done: 3, failed: 1, printingMs: 5_400_000 },
    automations: { states: { "night-lights": false, "night-queue": true }, lastRun: "12:30" }
  };
}

test("round-trips the full persisted state through save + load", async () => {
  const store = new StateStore(file);
  const state = sampleState();
  store.bind(() => state);
  store.save();
  await store.flush();

  const reloaded = new StateStore(file).load();
  assert.deepEqual(reloaded, state);
});

test("a missing file loads empty defaults without a warning", () => {
  const store = new StateStore(file);
  assert.deepEqual(store.load(), emptyState());
  assert.equal(store.loadWarning, null);
});

test("a corrupt file loads empty defaults and records a warning", () => {
  fs.writeFileSync(file, "{ this is not json", "utf8");
  const store = new StateStore(file);
  assert.deepEqual(store.load(), emptyState());
  assert.ok(store.loadWarning, "a warning is recorded for a corrupt file");
});

test("atomic write leaves no temp file behind", async () => {
  const store = new StateStore(file);
  store.bind(sampleState);
  store.save();
  await store.flush();

  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes(".tmp")),
    []
  );
  assert.ok(fs.existsSync(file));
});

test("normalizes partial / malformed persisted data instead of trusting it", () => {
  fs.writeFileSync(
    file,
    JSON.stringify({
      queue: { seq: -3, jobs: [{ id: "q1", title: "X", status: "bogus" }, "junk"] },
      feed: "not-an-array",
      today: { done: 5 }
    }),
    "utf8"
  );

  const loaded = new StateStore(file).load();
  assert.equal(loaded.queue.seq, 0, "negative seq is clamped");
  assert.equal(loaded.queue.jobs.length, 1, "non-object job entries are dropped");
  assert.equal(loaded.queue.jobs[0].status, "ready", "unknown status defaults to ready");
  assert.deepEqual(loaded.feed, [], "a non-array feed becomes empty");
  assert.equal(loaded.today.done, 5);
  assert.equal(loaded.today.failed, 0, "missing counter defaults to 0");
  assert.equal(loaded.today.printingMs, 0, "missing printingMs defaults to 0 (pre-tracking files)");
});

test("save is a no-op until a snapshot provider is bound", async () => {
  const store = new StateStore(file);
  store.save();
  await store.flush();
  assert.equal(fs.existsSync(file), false, "nothing is written without a provider");
});
