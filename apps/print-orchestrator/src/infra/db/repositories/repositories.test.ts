import assert from "node:assert/strict";
import { test } from "node:test";

import { NotFoundError, VersionConflictError } from "../../../core/errors";
import type { PrintQueueStore } from "../../../domain/print/repositories";
import type { Artifact, PrintTask, QueueEntry } from "../../../domain/print/types";
import { openPrintQueueStore } from "../store";

function freshStore(): PrintQueueStore {
  // In-memory: each test gets an isolated database, migrations already applied.
  return openPrintQueueStore(":memory:");
}

const ISO = "2026-07-17T00:00:00.000Z";

function artifact(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id,
    kind: "gcode",
    name: `${id}.gcode`,
    source: `${id}.gcode`,
    sizeBytes: null,
    sha256: null,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {},
    ...over
  };
}

function task(id: string, over: Partial<PrintTask> = {}): PrintTask {
  return {
    id,
    artifactId: null,
    title: id,
    material: null,
    targetPrinter: null,
    priority: 0,
    state: "QUEUED",
    reason: null,
    night: false,
    createdAt: ISO,
    updatedAt: ISO,
    version: 1,
    legacyRef: null,
    metadata: {},
    ...over
  };
}

function entry(id: string, taskId: string, over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id,
    taskId,
    position: 10,
    state: "WAITING",
    enqueuedAt: ISO,
    updatedAt: ISO,
    version: 1,
    ...over
  };
}

test("insert / getById round-trips an entity including its JSON metadata and booleans", () => {
  const store = freshStore();
  store.repositories.artifacts.insert(artifact("art1"));
  const saved = store.repositories.tasks.insert(
    task("t1", { artifactId: "art1", night: true, metadata: { eta: "2ч" }, material: "PLA" })
  );
  const read = store.repositories.tasks.getById("t1");
  assert.deepEqual(read, saved);
  assert.equal(read?.night, true);
  assert.equal(read?.metadata.eta, "2ч");
  store.close();
});

test("update enforces optimistic version and NotFound", () => {
  const store = freshStore();
  const t = store.repositories.tasks.insert(task("t1"));

  const v2 = store.repositories.tasks.update({ ...t, state: "ASSIGNED" });
  assert.equal(v2.version, 2);
  assert.equal(store.repositories.tasks.getById("t1")?.state, "ASSIGNED");

  // Writing back the stale (v1) object conflicts.
  assert.throws(
    () => store.repositories.tasks.update({ ...t, state: "CANCELLED" }),
    VersionConflictError
  );
  // Updating a missing row is a NotFound, not a conflict.
  assert.throws(() => store.repositories.tasks.update(task("ghost")), NotFoundError);
  store.close();
});

test("a throwing transaction rolls back every write in it", () => {
  const store = freshStore();
  store.repositories.tasks.insert(task("t1"));
  assert.throws(() =>
    store.transaction(() => {
      store.repositories.tasks.update({ ...store.repositories.tasks.getById("t1")!, state: "ASSIGNED" });
      store.repositories.tasks.insert(task("t2"));
      throw new Error("boom");
    })
  );
  assert.equal(store.repositories.tasks.getById("t1")?.state, "QUEUED", "update rolled back");
  assert.equal(store.repositories.tasks.getById("t2"), null, "insert rolled back");
  store.close();
});

test("findByLegacyRef looks up an imported id; the partial unique index blocks duplicates", () => {
  const store = freshStore();
  store.repositories.tasks.insert(task("t1", { legacyRef: "q7" }));
  assert.equal(store.repositories.tasks.findByLegacyRef("q7")?.id, "t1");
  assert.equal(store.repositories.tasks.findByLegacyRef("nope"), null);
  assert.throws(() => store.repositories.tasks.insert(task("t2", { legacyRef: "q7" })));
  store.close();
});

test("queue listOpen orders by position and excludes released; maxPosition tracks the tail", () => {
  const store = freshStore();
  const q = store.repositories.queue;
  store.repositories.tasks.insert(task("t1"));
  store.repositories.tasks.insert(task("t2"));
  store.repositories.tasks.insert(task("t3"));
  q.insert(entry("e1", "t1", { position: 30 }));
  q.insert(entry("e2", "t2", { position: 10 }));
  q.insert(entry("e3", "t3", { position: 20, state: "RELEASED" }));

  assert.deepEqual(
    q.listOpen().map((e) => e.id),
    ["e2", "e1"],
    "sorted by position, released excluded"
  );
  assert.equal(q.maxPosition(), 30);
  store.close();
});

test("bed cycle findOpenByPrinter returns the live (non-CLEAR) cycle only", () => {
  const store = freshStore();
  const beds = store.repositories.bedCycles;
  beds.insert({
    id: "b1",
    printerId: "K2",
    state: "CLEAR",
    assignmentId: null,
    createdAt: ISO,
    updatedAt: ISO,
    clearedAt: ISO,
    version: 1,
    metadata: {}
  });
  assert.equal(beds.findOpenByPrinter("K2"), null, "a cleared bed is not 'open'");
  beds.insert({
    id: "b2",
    printerId: "K2",
    state: "RESERVED",
    assignmentId: null,
    createdAt: ISO,
    updatedAt: ISO,
    clearedAt: null,
    version: 1,
    metadata: {}
  });
  assert.equal(beds.findOpenByPrinter("K2")?.id, "b2");
  store.close();
});

test("audit log is append-only and newest-first", () => {
  const store = freshStore();
  store.repositories.tasks.insert(task("t1"));
  store.repositories.audit.insert({
    id: "a1",
    at: "2026-07-17T00:00:01.000Z",
    entityType: "print_task",
    entityId: "t1",
    action: "created",
    fromState: null,
    toState: "QUEUED",
    actor: "operator",
    detail: {}
  });
  store.repositories.audit.insert({
    id: "a2",
    at: "2026-07-17T00:00:02.000Z",
    entityType: "print_task",
    entityId: "t1",
    action: "assigned",
    fromState: "QUEUED",
    toState: "ASSIGNED",
    actor: "operator",
    detail: { printerId: "K2" }
  });
  assert.deepEqual(
    store.repositories.audit.list().map((e) => e.id),
    ["a2", "a1"]
  );
  assert.deepEqual(
    store.repositories.audit.listByEntity("print_task", "t1").map((e) => e.action),
    ["created", "assigned"]
  );
  store.close();
});
