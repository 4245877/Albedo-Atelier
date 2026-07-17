import assert from "node:assert/strict";
import { test } from "node:test";

import { JobError, StateTransitionError, VersionConflictError } from "../../core/errors";
import { openPrintQueueStore } from "../../infra/db/store";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { PrintQueueService } from "./printQueueService";

/** A service on an isolated in-memory DB with a deterministic increasing clock. */
function makeService(): { service: PrintQueueService; store: PrintQueueStore } {
  const store = openPrintQueueStore(":memory:");
  let tick = 0;
  const base = Date.UTC(2026, 6, 17, 0, 0, 0);
  const service = new PrintQueueService(store, {
    now: () => new Date(base + tick++ * 1000)
  });
  return { service, store };
}

test("createTask with a printer is QUEUED/WAITING; without one it parks in NEEDS_REVIEW/HELD", () => {
  const { service, store } = makeService();

  const ready = service.createTask({ title: "Chalice", printer: "K2", material: "PLA", file: "chalice.gcode", eta: "2ч" });
  assert.equal(ready.task.state, "QUEUED");
  assert.equal(ready.queueEntry?.state, "WAITING");
  assert.equal(ready.artifact?.source, "chalice.gcode");

  const review = service.createTask({ title: "Base" });
  assert.equal(review.task.state, "NEEDS_REVIEW");
  assert.equal(review.queueEntry?.state, "HELD");
  assert.equal(review.task.reason, "не задан принтер");

  // Legacy projection renders both in the old dashboard shape.
  const projected = service.projectLegacyQueue();
  assert.deepEqual(
    projected.map((j) => ({ title: j.title, status: j.status })),
    [
      { title: "Chalice", status: "ready" },
      { title: "Base", status: "review" }
    ]
  );
  assert.equal(projected[0].file, "chalice.gcode");
  store.close();
});

test("createTask rejects a blank title", () => {
  const { service, store } = makeService();
  assert.throws(() => service.createTask({ title: "   " }), /title/);
  store.close();
});

test("full chain: assign → dispatch → run → complete → clear, and the task is kept as history", () => {
  const { service, store } = makeService();
  const created = service.createTask({ title: "Chalice", printer: "K2", file: "chalice.gcode" });
  const taskId = created.task.id;

  const assignment = service.assignTask(taskId, "K2");
  assert.equal(assignment.state, "RESERVED");
  assert.equal(service.getTask(taskId).state, "ASSIGNED");

  // Bed cycle for K2 is now RESERVED.
  const bed = store.repositories.bedCycles.findOpenByPrinter("K2");
  assert.equal(bed?.state, "RESERVED");
  assert.equal(bed?.assignmentId, assignment.id, "bed back-links to its assignment");

  const attempt = service.recordDispatchAttempt(assignment.id, { state: "ACKED" });
  assert.equal(attempt.attemptNo, 1);
  assert.equal(service.getTask(taskId).state, "DISPATCHING");

  const run = service.startRun(assignment.id, { dispatchAttemptId: attempt.id });
  assert.equal(run.state, "RUNNING");
  assert.equal(service.getTask(taskId).state, "PRINTING");
  assert.equal(store.repositories.assignments.getById(assignment.id)?.state, "ACTIVE");
  assert.equal(store.repositories.bedCycles.findOpenByPrinter("K2")?.state, "RUNNING");

  service.completeRun(run.id, "SUCCEEDED", { durationS: 3600, filamentUsedG: 12.5 });
  assert.equal(service.getTask(taskId).state, "COMPLETED");
  assert.equal(store.repositories.assignments.getById(assignment.id)?.state, "RELEASED");
  assert.equal(store.repositories.bedCycles.findOpenByPrinter("K2")?.state, "AWAITING_CLEARANCE");

  const detail = service.getTaskDetail(taskId);
  assert.equal(detail.task.state, "COMPLETED", "task NOT deleted after launch");
  assert.equal(detail.assignments.length, 1);
  assert.equal(detail.dispatchAttempts.length, 1);
  assert.equal(detail.printRuns.length, 1);
  assert.equal(detail.printRuns[0].filamentUsedG, 12.5);

  // Clearing the bed closes the cycle → CLEAR, freeing the printer.
  const cleared = service.clearBed("K2");
  assert.equal(cleared.state, "CLEAR");
  assert.equal(store.repositories.bedCycles.findOpenByPrinter("K2"), null);
  store.close();
});

test("a reserved bed blocks a second assignment until it is cleared", () => {
  const { service, store } = makeService();
  const a = service.createTask({ title: "A", printer: "K2", file: "a.gcode" });
  const b = service.createTask({ title: "B", printer: "K2", file: "b.gcode" });

  service.assignTask(a.task.id, "K2");
  assert.throws(() => service.assignTask(b.task.id, "K2"), JobError);
  store.close();
});

test("hold parks a task; release returns it to the runnable queue", () => {
  const { service, store } = makeService();
  const created = service.createTask({ title: "Chalice", printer: "K2", file: "c.gcode" });
  const id = created.task.id;

  service.holdTask(id, "ждём материал");
  assert.equal(service.getTask(id).state, "NEEDS_REVIEW");
  assert.equal(store.repositories.queue.findByTaskId(id)?.state, "HELD");

  service.releaseTask(id);
  assert.equal(service.getTask(id).state, "QUEUED");
  assert.equal(store.repositories.queue.findByTaskId(id)?.state, "WAITING");
  store.close();
});

test("cancelTask mid-run keeps the task, cancels the run, and leaves the bed awaiting clearance", () => {
  const { service, store } = makeService();
  const created = service.createTask({ title: "Chalice", printer: "K2", file: "c.gcode" });
  const id = created.task.id;
  const assignment = service.assignTask(id, "K2");
  const run = service.startRun(assignment.id);

  service.cancelTask(id, "оператор отменил");
  assert.equal(service.getTask(id).state, "CANCELLED", "task kept, not deleted");
  assert.equal(store.repositories.printRuns.getById(run.id)?.state, "CANCELLED");
  assert.equal(store.repositories.assignments.getById(assignment.id)?.state, "CANCELLED");
  assert.equal(store.repositories.bedCycles.findOpenByPrinter("K2")?.state, "AWAITING_CLEARANCE");
  assert.equal(store.repositories.queue.findByTaskId(id)?.state, "RELEASED");
  store.close();
});

test("an illegal transition is refused (completing an already-completed run)", () => {
  const { service, store } = makeService();
  const created = service.createTask({ title: "X", printer: "K2", file: "x.gcode" });
  const assignment = service.assignTask(created.task.id, "K2");
  const run = service.startRun(assignment.id);
  service.completeRun(run.id, "SUCCEEDED");
  assert.throws(() => service.completeRun(run.id, "FAILED"), StateTransitionError);
  store.close();
});

test("reorderTask uses optimistic concurrency on the queue entry", () => {
  const { service, store } = makeService();
  const created = service.createTask({ title: "X", printer: "K2", file: "x.gcode" });
  const entry = store.repositories.queue.findByTaskId(created.task.id)!;

  const moved = service.reorderTask(created.task.id, 99, entry.version);
  assert.equal(moved.position, 99);
  assert.equal(moved.version, entry.version + 1);

  // Replaying the same (now stale) expected version conflicts.
  assert.throws(
    () => service.reorderTask(created.task.id, 5, entry.version),
    VersionConflictError
  );
  store.close();
});

test("every mutation is journalled in the audit log", () => {
  const { service, store } = makeService();
  const created = service.createTask({ title: "X", printer: "K2", file: "x.gcode" });
  const assignment = service.assignTask(created.task.id, "K2");
  service.startRun(assignment.id);

  const taskAudit = store.repositories.audit.listByEntity("print_task", created.task.id);
  const actions = taskAudit.map((e) => e.action);
  assert.ok(actions.includes("created"));
  assert.ok(actions.includes("assigned"));
  assert.ok(actions.includes("printing"));
  // Bed and assignment transitions are journalled too.
  assert.ok(store.repositories.audit.list().some((e) => e.entityType === "bed_cycle"));
  assert.ok(store.repositories.audit.list().some((e) => e.entityType === "assignment"));
  store.close();
});

// ── #7 priority band ─────────────────────────────────────────────────────────

test("addTask rejects an out-of-range priority instead of poisoning the score", () => {
  const { service, store } = makeService();
  assert.throws(() => service.addTask({ title: "huge", priority: 1e308 }), /Приоритет/);
  assert.throws(() => service.addTask({ title: "neg", priority: -1000 }), /Приоритет/);
  // A value inside the band is accepted.
  assert.equal(service.addTask({ title: "ok", priority: 50 }).task.priority, 50);
  store.close();
});

test("setTaskScheduling rejects an out-of-range priority", () => {
  const { service, store } = makeService();
  const t = service.addTask({ title: "t" }).task;
  assert.throws(() => service.setTaskScheduling(t.id, { priority: 1e308 }), /Приоритет/);
  store.close();
});

// ── #8 notBefore/deadline order ──────────────────────────────────────────────

test("addTask rejects a notBefore after the deadline (unsatisfiable window)", () => {
  const { service, store } = makeService();
  assert.throws(
    () =>
      service.addTask({
        title: "impossible",
        notBefore: "2026-07-20T00:00:00.000Z",
        deadline: "2026-07-18T00:00:00.000Z"
      }),
    /notBefore/
  );
  store.close();
});

test("setTaskScheduling validates the effective window when only one side is patched", () => {
  const { service, store } = makeService();
  const t = service.addTask({ title: "t", deadline: "2026-07-18T00:00:00.000Z" }).task;
  // Patch only notBefore to sit after the existing deadline → rejected.
  assert.throws(
    () => service.setTaskScheduling(t.id, { notBefore: "2026-07-20T00:00:00.000Z" }),
    /notBefore/
  );
  store.close();
});

// ── #9 pin validation against the farm config ────────────────────────────────

test("pinPrinter and addTask refuse a printer the farm does not know (when a config check is wired)", () => {
  const store = openPrintQueueStore(":memory:");
  const service = new PrintQueueService(store, {
    now: () => new Date(Date.UTC(2026, 6, 17)),
    isPrinterConfigured: (id) => id === "k2"
  });
  const t = service.addTask({ title: "t" }).task;
  assert.throws(() => service.pinPrinter(t.id, "ghost-9000"), /конфигурации фермы/);
  // A known printer pins fine.
  assert.equal(service.pinPrinter(t.id, "k2").pinnedPrinterId, "k2");
  // Creating a task pinned to an unknown printer is refused up front.
  assert.throws(() => service.addTask({ title: "u", pinnedPrinterId: "ghost-9000" }), /конфигурации фермы/);
  store.close();
});
