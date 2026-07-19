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
    today: {
      key: "2026-07-03",
      done: 3,
      failed: 1,
      printingMs: 5_400_000,
      avgDurationMsTotal: 3_600_000,
      avgDurationCount: 2
    },
    automations: { states: { "night-lights": false, "night-queue": true }, lastRun: "12:30" },
    snapshots: [
      {
        id: "1720000000000-abcd1234",
        printerId: "creality-k2",
        capturedAt: "2026-07-03T10:00:00.000Z",
        mime: "image/jpeg",
        bytes: 2048,
        path: "creality-k2/2026-07-03/1720000000000-abcd1234.jpg",
        status: "printing · chalice.gcode",
        url: "/api/printers/creality-k2/snapshots/1720000000000-abcd1234"
      }
    ],
    pendingConsumes: [
      {
        input: {
          printerId: "bambu-a1-combo",
          grams: 120,
          amsTray: 0,
          material: "PLA",
          color: "#FF0000",
          printJobId: "run-9",
          idempotencyKey: "bambu-a1-combo:run-9:t0",
          note: "Печать «model.3mf»"
        },
        printerName: "Bambu Lab A1 Combo",
        attempts: 2,
        nextAttemptAtMs: 1_720_000_120_000,
        firstFailedAtMs: 1_720_000_000_000
      }
    ],
    filamentCarry: {
      "creality-k2:main": { lengthMm: 120.5 },
      "bambu-a1-combo:t0": { grams: 0.6 }
    }
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

test("a corrupt file loads empty defaults, records a warning and is backed up", () => {
  fs.writeFileSync(file, "{ this is not json", "utf8");
  const store = new StateStore(file);
  assert.deepEqual(store.load(), emptyState());
  assert.ok(store.loadWarning, "a warning is recorded for a corrupt file");

  // The unparseable file is moved aside (not left to be clobbered by save), and
  // its bytes are preserved in the backup for manual recovery.
  const backups = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  assert.equal(backups.length, 1, "the corrupt file is renamed to a .corrupt-* backup");
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), "{ this is not json");
  assert.equal(fs.existsSync(file), false, "the corrupt file no longer occupies the state path");
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
  assert.equal(loaded.today.avgDurationMsTotal, 0, "missing avgDurationMsTotal defaults to 0");
  assert.equal(loaded.today.avgDurationCount, 0, "missing avgDurationCount defaults to 0");
  assert.deepEqual(loaded.pendingConsumes, [], "missing pendingConsumes defaults to empty (pre-retry files)");
});

test("normalizes pending consume entries and drops undeliverable ones", () => {
  fs.writeFileSync(
    file,
    JSON.stringify({
      pendingConsumes: [
        // Deliverable: keeps its key, quantity and schedule.
        {
          input: { printerId: "k2", lengthMm: 500, printJobId: "run-1", idempotencyKey: "k2:run-1" },
          printerName: "Creality K2",
          attempts: 3,
          nextAttemptAtMs: 123,
          firstFailedAtMs: 456
        },
        // Missing quantity → could never be delivered → dropped.
        { input: { printerId: "k2", printJobId: "run-2", idempotencyKey: "k2:run-2" } },
        // Missing idempotency key → redelivery would not be dedupable → dropped.
        { input: { printerId: "k2", lengthMm: 10, printJobId: "run-3" } },
        // Junk shapes → dropped.
        "junk",
        { printerName: "no input" }
      ]
    }),
    "utf8"
  );

  const loaded = new StateStore(file).load();
  assert.equal(loaded.pendingConsumes.length, 1, "only the deliverable entry survives");
  const entry = loaded.pendingConsumes[0];
  assert.equal(entry.input.idempotencyKey, "k2:run-1");
  assert.equal(entry.input.lengthMm, 500);
  assert.equal(entry.attempts, 3);
  assert.equal(entry.nextAttemptAtMs, 123);
  assert.equal(entry.firstFailedAtMs, 456);
});

test("a pending consume without a first-failure stamp restarts its age clock", () => {
  fs.writeFileSync(
    file,
    JSON.stringify({
      pendingConsumes: [
        {
          input: { printerId: "k2", grams: 10, printJobId: "r", idempotencyKey: "k" }
        }
      ]
    }),
    "utf8"
  );

  const before = Date.now();
  const loaded = new StateStore(file).load();
  const entry = loaded.pendingConsumes[0];
  assert.equal(entry.attempts, 1, "attempts floor is 1");
  assert.equal(entry.nextAttemptAtMs, 0, "missing schedule means due immediately");
  assert.ok(
    entry.firstFailedAtMs >= before,
    "missing age anchor restarts now — never 0, which would expire it instantly"
  );
});

test("normalizes the filament carry and drops junk entries", () => {
  fs.writeFileSync(
    file,
    JSON.stringify({
      filamentCarry: {
        "k2:main": { lengthMm: 120.5 },
        "a1:t0": { grams: 0.6, lengthMm: -3 }, // negative part dropped, grams kept
        "a1:t1": { grams: 0 }, // nothing positive → dropped
        "junk": "not-an-object",
        "": { grams: 1 } // empty key → dropped
      }
    }),
    "utf8"
  );

  const loaded = new StateStore(file).load();
  assert.deepEqual(loaded.filamentCarry, {
    "k2:main": { lengthMm: 120.5 },
    "a1:t0": { grams: 0.6 }
  });
});

test("a file without filamentCarry loads an empty carry (pre-carry files)", () => {
  fs.writeFileSync(file, JSON.stringify({ version: 1 }), "utf8");
  assert.deepEqual(new StateStore(file).load().filamentCarry, {});
});

test("a legacy queue status \"error\" is normalized to review and survives a re-save", async () => {
  // Files written by older builds could carry status "error"; the current
  // contract has only ready/review. Loading must not crash, the job must land
  // in "review" (operator attention) with an explanatory reason, and a re-save
  // must produce a clean version-1 file.
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      queue: {
        seq: 3,
        jobs: [
          { id: "q1", title: "Broken", printer: "K2", material: "PLA", eta: "2ч", status: "error" },
          {
            id: "q2",
            title: "Also broken",
            printer: "A1",
            material: "PLA",
            eta: "1ч",
            status: "error",
            reason: "старое пояснение"
          },
          { id: "q3", title: "Fine", printer: "K2", material: "PLA", eta: "1ч", status: "ready" }
        ]
      }
    }),
    "utf8"
  );

  const store = new StateStore(file);
  const loaded = store.load();
  assert.equal(store.loadWarning, null, "a legacy status is not a load failure");
  assert.equal(loaded.queue.jobs[0].status, "review");
  assert.equal(loaded.queue.jobs[0].reason, "задание было помечено ошибкой — проверьте его");
  assert.equal(loaded.queue.jobs[1].status, "review");
  assert.equal(loaded.queue.jobs[1].reason, "старое пояснение", "an existing reason is kept");
  assert.equal(loaded.queue.jobs[2].status, "ready", "untouched statuses stay as-is");

  store.bind(() => loaded);
  store.save();
  await store.flush();
  const reloaded = new StateStore(file).load();
  assert.equal(reloaded.version, 1);
  assert.deepEqual(
    reloaded.queue.jobs.map((job) => job.status),
    ["review", "review", "ready"]
  );
});

test("save is a no-op until a snapshot provider is bound", async () => {
  const store = new StateStore(file);
  store.save();
  await store.flush();
  assert.equal(fs.existsSync(file), false, "nothing is written without a provider");
});
