import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ValidationError, VersionConflictError } from "../../core/errors";
import { openPrintQueueStore } from "../../infra/db/store";
import { PrintQueueService } from "./printQueueService";

function service(): PrintQueueService {
  const store = openPrintQueueStore(":memory:");
  return new PrintQueueService(store, { now: () => new Date("2026-07-17T12:00:00.000Z") });
}

test("addTask puts a task into the new queue as QUEUED/WAITING with scheduling fields", () => {
  const svc = service();
  const detail = svc.addTask({
    title: "Bracket",
    material: "PETG",
    priority: 5,
    deadline: "2026-07-18T09:00:00.000Z",
    dayNightPreference: "night",
    unattendedAllowed: true
  });
  assert.equal(detail.task.state, "QUEUED");
  assert.equal(detail.task.priority, 5);
  assert.equal(detail.task.dayNightPreference, "night");
  assert.equal(detail.task.unattendedAllowed, true);
  assert.equal(detail.task.deadline, "2026-07-18T09:00:00.000Z");
  assert.ok(detail.queueEntry);
  assert.equal(detail.queueEntry?.state, "WAITING");
});

test("addTask rejects a bad deadline and an empty title", () => {
  const svc = service();
  assert.throws(() => svc.addTask({ title: "x", deadline: "not-a-date" }), ValidationError);
  assert.throws(() => svc.addTask({ title: "   " }), ValidationError);
});

test("reorderTask enforces the optimistic version (a stale write conflicts)", () => {
  const svc = service();
  const { task } = svc.addTask({ title: "A" });
  const entry = svc.getTaskDetail(task.id).queueEntry!;
  // A correct-version reorder succeeds and bumps the version.
  svc.reorderTask(task.id, 999, entry.version);
  // Reusing the now-stale version conflicts instead of silently clobbering.
  assert.throws(() => svc.reorderTask(task.id, 5, entry.version), VersionConflictError);
});

test("pinPrinter binds a printer and unpinPrinter clears it", () => {
  const svc = service();
  const { task } = svc.addTask({ title: "A" });
  const pinned = svc.pinPrinter(task.id, "k2");
  assert.equal(pinned.pinnedPrinterId, "k2");
  assert.equal(pinned.targetPrinter, "k2");
  const unpinned = svc.unpinPrinter(task.id);
  assert.equal(unpinned.pinnedPrinterId, null);
});

test("setTaskScheduling updates params but refuses on a terminal task", () => {
  const svc = service();
  const { task } = svc.addTask({ title: "A" });
  const updated = svc.setTaskScheduling(task.id, { priority: 9, notBefore: "2026-07-17T20:00:00.000Z" });
  assert.equal(updated.priority, 9);
  assert.equal(updated.notBefore, "2026-07-17T20:00:00.000Z");

  svc.cancelTask(task.id);
  assert.throws(() => svc.setTaskScheduling(task.id, { priority: 1 }), ValidationError);
});

test("the manual scheduler services never touch the legacy queue store or state.json", () => {
  // Structural guard for "не развивай legacy /api/queue и state.json": the
  // durable-model services must not import or write the legacy JSON queue.
  // The distinctive markers are imports of the legacy JSON modules — the
  // `QueueStore` (app/queueStore) and `StateStore` (infra/persistence/stateStore).
  // `PrintQueueStore` (the SQLite domain store) is deliberately *not* matched.
  const legacyImport = /from\s+["'][^"']*(queueStore|stateStore|snapshotStore)["']/;
  // Resolved from the package root (tests run with cwd = the package dir).
  const base = path.resolve("src/app/printQueue");
  for (const file of ["printQueueService.ts", "../scheduling/schedulerService.ts"]) {
    const src = readFileSync(path.resolve(base, file), "utf8");
    assert.doesNotMatch(src, legacyImport, `${file} must not import the legacy JSON queue/state`);
  }
});
