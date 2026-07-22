import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueueJob } from "../../domain/dashboard/types";
import type { PrintQueueStore } from "../../domain/print/repositories";
import { importLegacyQueue, LEGACY_IMPORT_MARKER } from "./legacyImport";
import { openPrintQueueStore } from "./store";

function store(): PrintQueueStore {
  return openPrintQueueStore(":memory:");
}

const LEGACY: QueueJob[] = [
  { id: "q1", title: "Chalice", printer: "K2", material: "PLA", eta: "2ч", status: "ready", file: "chalice.gcode", night: true },
  { id: "q2", title: "Base", printer: "—", material: "—", eta: "—", status: "review", reason: "не задан принтер" }
];

test("import creates tasks/entries/artifacts, preserving legacy ids as legacyRef", () => {
  const s = store();
  const result = importLegacyQueue(s, LEGACY, { now: () => new Date("2026-07-17T00:00:00Z") });
  assert.deepEqual(result, { skipped: false, imported: 2 });

  const ready = s.repositories.tasks.findByLegacyRef("q1");
  assert.ok(ready);
  assert.equal(ready?.title, "Chalice");
  assert.equal(ready?.state, "QUEUED");
  assert.equal(ready?.targetPrinter, "K2");
  assert.equal(ready?.material, "PLA");
  assert.equal(ready?.night, true);
  assert.equal(ready?.metadata.eta, "2ч");
  // The file became an artifact linked to the task.
  const art = ready?.artifactId ? s.repositories.artifacts.getById(ready.artifactId) : null;
  assert.equal(art?.source, "chalice.gcode");

  const review = s.repositories.tasks.findByLegacyRef("q2");
  assert.equal(review?.state, "NEEDS_REVIEW");
  assert.equal(review?.targetPrinter, null, "the '—' placeholder maps to null");
  assert.equal(review?.reason, "не задан принтер");

  // The review job's queue entry is HELD, the ready one's is WAITING.
  assert.equal(s.repositories.queue.findByTaskId(review!.id)?.state, "HELD");
  assert.equal(s.repositories.queue.findByTaskId(ready!.id)?.state, "WAITING");

  // Each import writes an audit row.
  assert.equal(s.repositories.audit.listByEntity("print_task", ready!.id)[0]?.action, "imported");
  s.close();
});

test("import is one-time: a second call with the SAME jobs is a skipped no-op", () => {
  const s = store();
  importLegacyQueue(s, LEGACY);
  assert.equal(s.repositories.meta.get(LEGACY_IMPORT_MARKER) !== null, true);

  const second = importLegacyQueue(s, LEGACY);
  assert.deepEqual(second, { skipped: true, imported: 0 });
  assert.equal(s.repositories.tasks.list().length, 2, "no duplicates on restart");
  s.close();
});

test("a job that appears in legacy JSON AFTER the cutover is imported fail-closed (NEEDS_REVIEW), never runnable", () => {
  const s = store();
  importLegacyQueue(s, LEGACY);

  // An older binary (or a hand edit) wrote a new job into state.json after the
  // marker was set. It must neither vanish (data loss) nor become startable
  // from a second source of truth: it parks in review for the operator.
  const second = importLegacyQueue(s, [
    ...LEGACY,
    { id: "q9", title: "Late", printer: "K2", material: "PLA", eta: "1ч", status: "ready" }
  ]);
  assert.deepEqual(second, { skipped: false, imported: 1 });

  const late = s.repositories.tasks.findByLegacyRef("q9");
  assert.equal(late?.state, "NEEDS_REVIEW", "late job is parked, not runnable");
  assert.match(late?.reason ?? "", /после перехода/);
  assert.equal(s.repositories.queue.findByTaskId(late!.id)?.state, "HELD");

  // Idempotent: a third call imports nothing new.
  const third = importLegacyQueue(s, [
    ...LEGACY,
    { id: "q9", title: "Late", printer: "K2", material: "PLA", eta: "1ч", status: "ready" }
  ]);
  assert.deepEqual(third, { skipped: true, imported: 0 });
  s.close();
});

test("even with the marker cleared, legacyRef dedup prevents duplicates on a forced re-run", () => {
  const s = store();
  importLegacyQueue(s, LEGACY);
  // Simulate a forced re-run by clearing the marker.
  s.repositories.meta.set(LEGACY_IMPORT_MARKER, "");
  // meta.get returns "" (falsy) so the guard lets it proceed; the per-task
  // findByLegacyRef check then skips the already-imported jobs.
  const rerun = importLegacyQueue(s, LEGACY);
  assert.equal(rerun.imported, 0, "both jobs already present by legacyRef");
  assert.equal(s.repositories.tasks.list().length, 2, "still exactly two tasks");
  s.close();
});

test("an empty legacy queue still marks the import done", () => {
  const s = store();
  const result = importLegacyQueue(s, []);
  assert.deepEqual(result, { skipped: false, imported: 0 });
  assert.ok(s.repositories.meta.get(LEGACY_IMPORT_MARKER));
  s.close();
});

test("a single-job legacy queue imports that one job", () => {
  const s = store();
  const result = importLegacyQueue(s, [
    { id: "q1", title: "Only", printer: "K2", material: "PLA", eta: "1ч", status: "ready" }
  ]);
  assert.deepEqual(result, { skipped: false, imported: 1 });
  assert.equal(s.repositories.tasks.list().length, 1);
  assert.equal(s.repositories.tasks.findByLegacyRef("q1")?.title, "Only");
  s.close();
});

test("multiple jobs are imported in their legacy order", () => {
  const s = store();
  const jobs: QueueJob[] = [
    { id: "q1", title: "First", printer: "K2", material: "PLA", eta: "1ч", status: "ready" },
    { id: "q2", title: "Second", printer: "K2", material: "PLA", eta: "2ч", status: "ready" },
    { id: "q3", title: "Third", printer: "K2", material: "PLA", eta: "3ч", status: "ready" }
  ];
  const result = importLegacyQueue(s, jobs);
  assert.equal(result.imported, 3);

  // The open-queue order (by position) mirrors the legacy array order.
  const order = s.repositories.queue
    .listOpen()
    .map((entry) => s.repositories.tasks.getById(entry.taskId)?.title);
  assert.deepEqual(order, ["First", "Second", "Third"]);
  s.close();
});

test("a failure mid-import rolls back completely and writes NO marker", () => {
  const s = store();
  const jobs: QueueJob[] = [
    { id: "q1", title: "First", printer: "K2", material: "PLA", eta: "1ч", status: "ready" },
    { id: "q2", title: "Second", printer: "K2", material: "PLA", eta: "2ч", status: "ready" },
    { id: "q3", title: "Third", printer: "K2", material: "PLA", eta: "3ч", status: "ready" }
  ];

  // Make the SECOND job's audit insert throw, so the transaction fails partway.
  const audit = s.repositories.audit;
  const realInsert = audit.insert.bind(audit);
  let calls = 0;
  audit.insert = (event) => {
    calls += 1;
    if (calls === 2) throw new Error("disk full");
    return realInsert(event);
  };

  assert.throws(() => importLegacyQueue(s, jobs), /disk full/);

  // The whole import is one transaction: nothing landed, and — crucially — the
  // marker was NOT written, so the migration is safe to retry.
  assert.equal(s.repositories.meta.get(LEGACY_IMPORT_MARKER), null, "no marker after a failed import");
  assert.equal(s.repositories.tasks.list().length, 0, "every write rolled back");

  // Repair the fault and retry: the import now completes and marks done.
  audit.insert = realInsert;
  const retry = importLegacyQueue(s, jobs);
  assert.deepEqual(retry, { skipped: false, imported: 3 });
  assert.ok(s.repositories.meta.get(LEGACY_IMPORT_MARKER), "marker set after the successful retry");
  const order = s.repositories.queue
    .listOpen()
    .map((entry) => s.repositories.tasks.getById(entry.taskId)?.title);
  assert.deepEqual(order, ["First", "Second", "Third"], "order preserved on retry");
  s.close();
});
