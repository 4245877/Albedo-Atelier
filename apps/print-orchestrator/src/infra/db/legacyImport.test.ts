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

test("import is one-time: the marker makes a second call a skipped no-op", () => {
  const s = store();
  importLegacyQueue(s, LEGACY);
  assert.equal(s.repositories.meta.get(LEGACY_IMPORT_MARKER) !== null, true);

  const second = importLegacyQueue(s, [{ id: "q9", title: "Late", printer: "K2", material: "PLA", eta: "1ч", status: "ready" }]);
  assert.deepEqual(second, { skipped: true, imported: 0 });
  assert.equal(s.repositories.tasks.findByLegacyRef("q9"), null, "no late import — not dual-write");
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
