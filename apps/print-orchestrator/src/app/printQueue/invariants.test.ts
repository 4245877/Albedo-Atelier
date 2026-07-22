import assert from "node:assert/strict";
import { test } from "node:test";

import { JobError } from "../../core/errors";
import { openPrintQueueStore } from "../../infra/db/store";
import { PrintQueueService } from "./printQueueService";
import { toLegacyQueueJob } from "./projection";

/*
 * Service-level invariants over a real (in-memory) SQLite store with the full
 * migration set. The 008 partial unique indexes are exercised separately in
 * dispatchService.test.ts — here the SERVICE must refuse first, with an honest
 * 409, before the engine ever has to.
 */

function makeQueue() {
  const store = openPrintQueueStore(":memory:");
  return { store, queue: new PrintQueueService(store) };
}

test("one task cannot be assigned to two printers in sequence", () => {
  const { queue } = makeQueue();
  const taskId = queue.createTask({ title: "T", printer: "p1", file: "t.gcode" }).task.id;

  queue.assignTask(taskId, "p1");
  assert.throws(
    () => queue.assignTask(taskId, "p2"),
    (e: unknown) => e instanceof JobError && /уже назначено/.test((e as JobError).message)
  );
});

test("one printer cannot hold two live assignments", () => {
  const { queue } = makeQueue();
  const t1 = queue.createTask({ title: "A", printer: "p1", file: "a.gcode" }).task.id;
  const t2 = queue.createTask({ title: "B", printer: "p1", file: "b.gcode" }).task.id;

  queue.assignTask(t1, "p1");
  assert.throws(
    () => queue.assignTask(t2, "p1"),
    (e: unknown) => e instanceof JobError
  );
});

// The "one active run per task / per printer" invariant and the
// no-run-off-a-closed-assignment guarantee are enforced by the canonical
// dispatch path (fresh assignment + run per dispatch); they are exercised in
// dispatch/dispatchService.test.ts against DispatchService and the 008 partial
// unique indexes.

test("projection NEVER guesses ready for contradictory data (cancelled task + open entry)", () => {
  const { queue, store } = makeQueue();
  const detail = queue.createTask({ title: "Ghost", printer: "p1", file: "g.gcode" });
  const repos = store.repositories;

  // Corrupt the pair directly (bypassing the service): the task is CANCELLED
  // while its queue entry is left WAITING — data that should be impossible.
  const task = repos.tasks.getById(detail.task.id)!;
  repos.tasks.update({ ...task, state: "CANCELLED", updatedAt: new Date().toISOString() });

  const row = {
    entry: repos.queue.findByTaskId(detail.task.id)!,
    task: repos.tasks.getById(detail.task.id)!,
    artifact: null
  };
  const job = toLegacyQueueJob(row);
  assert.equal(job.status, "review", "a diagnostic status, not a guessed ready");
  assert.match(job.reason ?? "", /несогласованное состояние/);
});

test("projection shows an in-flight task (DISPATCHING) as not-ready with an honest label", () => {
  const { queue, store } = makeQueue();
  const detail = queue.createTask({ title: "Mid-flight", printer: "p1", file: "m.gcode" });
  const repos = store.repositories;
  const task = repos.tasks.getById(detail.task.id)!;
  const assigned = repos.tasks.update({ ...task, state: "ASSIGNED", updatedAt: task.updatedAt });
  repos.tasks.update({ ...assigned, state: "DISPATCHING", updatedAt: task.updatedAt });

  const job = toLegacyQueueJob({
    entry: repos.queue.findByTaskId(detail.task.id)!,
    task: repos.tasks.getById(detail.task.id)!,
    artifact: null
  });
  assert.equal(job.status, "review");
  assert.match(job.reason ?? "", /запускается|печатается/);
});
