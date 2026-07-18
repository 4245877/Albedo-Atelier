import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { MIGRATIONS } from "./index";
import { migration008 } from "./008_canonical_dispatch";

/*
 * Migration 008 must be fail-closed: when the existing data already violates a
 * safety invariant (two active runs on one printer — i.e. the history claims
 * two prints are physically running at once), the migration REFUSES with an
 * operator-actionable message instead of silently picking a survivor.
 */

function dbAtVersion7(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 7)) {
    migration.up(db);
  }
  return db;
}

function seedTaskChain(
  db: DatabaseSync,
  suffix: string,
  printerId = "k2"
): { taskId: string; assignmentId: string } {
  const iso = new Date().toISOString();
  const taskId = `task_${suffix}`;
  const assignmentId = `asg_${suffix}`;
  db.prepare(
    `INSERT INTO print_tasks (id, artifact_id, title, material, target_printer, priority, state,
       reason, night, created_at, updated_at, version, legacy_ref, metadata)
     VALUES (?, NULL, ?, NULL, ?, 0, 'PRINTING', NULL, 0, ?, ?, 1, NULL, '{}')`
  ).run(taskId, `Task ${suffix}`, printerId, iso, iso);
  db.prepare(
    `INSERT INTO assignments (id, task_id, printer_id, plan_id, bed_cycle_id, state,
       created_at, updated_at, version, legacy_ref, metadata)
     VALUES (?, ?, ?, NULL, NULL, 'ACTIVE', ?, ?, 1, NULL, '{}')`
  ).run(assignmentId, taskId, printerId, iso, iso);
  return { taskId, assignmentId };
}

function seedRun(db: DatabaseSync, suffix: string, chain: { taskId: string; assignmentId: string }): void {
  const iso = new Date().toISOString();
  db.prepare(
    `INSERT INTO print_runs (id, task_id, assignment_id, dispatch_attempt_id, printer_id,
       bed_cycle_id, state, started_at, ended_at, progress, filament_used_g, duration_s,
       created_at, updated_at, version, legacy_ref, metadata)
     VALUES (?, ?, ?, NULL, 'k2', NULL, 'RUNNING', ?, NULL, 0, NULL, NULL, ?, ?, 1, NULL, '{}')`
  ).run(`run_${suffix}`, chain.taskId, chain.assignmentId, iso, iso, iso);
}

test("008 refuses fail-closed when two active runs share one printer", () => {
  const db = dbAtVersion7();
  seedRun(db, "one", seedTaskChain(db, "one"));
  seedRun(db, "two", seedTaskChain(db, "two"));

  assert.throws(
    () => migration008.up(db),
    (e: unknown) => e instanceof Error && /конфликтующие данные/.test(e.message)
  );
  db.close();
});

test("008 applies cleanly on healthy data and carries every run over verbatim", () => {
  const db = dbAtVersion7();
  seedRun(db, "solo", seedTaskChain(db, "solo"));

  migration008.up(db);
  const rows = db.prepare("SELECT id, state, file, artifact_sha256 FROM print_runs").all() as {
    id: string;
    state: string;
    file: unknown;
    artifact_sha256: unknown;
  }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "run_solo");
  assert.equal(rows[0].state, "RUNNING");
  assert.equal(rows[0].file, null, "new columns default to NULL for migrated rows");

  // The new indexes are live: a second active run on k2 is refused by the
  // engine (the chain itself sits on another printer so only the run collides).
  const chain = seedTaskChain(db, "second", "other");
  assert.throws(() => seedRun(db, "second", chain), /UNIQUE constraint failed/);
  db.close();
});

test("008 refuses two live assignments for one task (pre-flight)", () => {
  const db = dbAtVersion7();
  const iso = new Date().toISOString();
  const { taskId } = seedTaskChain(db, "dup");
  db.prepare(
    `INSERT INTO assignments (id, task_id, printer_id, plan_id, bed_cycle_id, state,
       created_at, updated_at, version, legacy_ref, metadata)
     VALUES ('asg_dup2', ?, 'other', NULL, NULL, 'RESERVED', ?, ?, 1, NULL, '{}')`
  ).run(taskId, iso, iso);

  assert.throws(
    () => migration008.up(db),
    (e: unknown) => e instanceof Error && /конфликтующие данные/.test(e.message)
  );
  db.close();
});
