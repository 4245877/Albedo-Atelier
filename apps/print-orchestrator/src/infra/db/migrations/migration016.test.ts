import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";

import { openDatabase } from "../database";
import { MIGRATIONS, runMigrations } from "./index";

/*
 * Migration 016 reconciles `print_tasks.night` with `day_night_preference`.
 *
 * The two columns described one fact and were written independently for the
 * whole life of the schema, while the dispatch gate read only the boolean. When
 * the gate moved to the enum, every row where the two disagreed changed meaning
 * without anything touching it — and, worse, changed meaning *in one direction
 * only*: `buildNightPlan` and the night-start guard still read the boolean, so a
 * legacy night job was offered by the planner and refused by the dispatch.
 *
 * These tests pin both halves: the disagreement is repaired, and rows that never
 * disagreed are left exactly as they were.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-migration016-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every migration up to 015 — a database as it looked before this change. */
function openAtVersion015(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
  );
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
  );
  for (const migration of MIGRATIONS.filter((m) => m.version <= 15)) {
    migration.up(db);
    record.run(migration.version, migration.name, new Date().toISOString());
  }
  return db;
}

function insertTask(
  db: DatabaseSync,
  id: string,
  night: number,
  preference: string
): void {
  db.prepare(
    `INSERT INTO print_tasks
       (id, title, priority, state, night, day_night_preference,
        unattended_allowed, created_at, updated_at, version, metadata)
     VALUES (?, ?, 0, 'QUEUED', ?, ?, 0, '2026-01-01', '2026-01-01', 1, '{}')`
  ).run(id, `task ${id}`, night, preference);
}

/**
 * The pair, copied into a plain object. `DatabaseSync` hands back null-prototype
 * rows, which `deepEqual` reports as different from an object literal while
 * printing two identical-looking sides.
 */
function read(db: DatabaseSync, id: string): { night: number; pref: string } {
  const row = db
    .prepare("SELECT night, day_night_preference AS pref FROM print_tasks WHERE id = ?")
    .get(id) as { night: number; pref: string };
  return { night: Number(row.night), pref: String(row.pref) };
}

test("a legacy night job keeps its night eligibility after the reader moved to the enum", () => {
  const file = path.join(dir, "legacy.db");
  const old = openAtVersion015(file);
  // Exactly what `legacyImport` wrote, and what a `PATCH { night: true }`
  // through the scheduling API left behind: the boolean set, the enum default.
  insertTask(old, "task_legacy_night", 1, "any");
  // …and the mirror image: the operator chose «ночью» in the scheduler, which
  // wrote the enum and left the boolean alone.
  insertTask(old, "task_enum_night", 0, "night");
  old.close();

  const db = openDatabase(file);
  try {
    assert.deepEqual(
      read(db, "task_legacy_night"),
      { night: 1, pref: "night" },
      "the boolean's meaning is preserved in the field the gate now reads"
    );
    assert.deepEqual(
      read(db, "task_enum_night"),
      { night: 1, pref: "night" },
      "and the enum's meaning reaches the projection the night planner reads"
    );
  } finally {
    db.close();
  }
});

test("rows that already agreed are untouched — nothing becomes night-eligible by accident", () => {
  const file = path.join(dir, "agreeing.db");
  const old = openAtVersion015(file);
  insertTask(old, "task_day", 0, "any");
  insertTask(old, "task_day_explicit", 0, "day");
  insertTask(old, "task_night", 1, "night");
  old.close();

  const db = openDatabase(file);
  try {
    assert.deepEqual(read(db, "task_day"), { night: 0, pref: "any" });
    assert.deepEqual(
      read(db, "task_day_explicit"),
      { night: 0, pref: "day" },
      "an explicit daytime preference is not a night flag and must survive verbatim"
    );
    assert.deepEqual(read(db, "task_night"), { night: 1, pref: "night" });
  } finally {
    db.close();
  }
});

test("the reconciliation runs on a fresh install too, and is a no-op there", () => {
  const db = openDatabase(path.join(dir, "clean.db"));
  try {
    const recorded = (
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    assert.deepEqual(recorded, MIGRATIONS.map((m) => m.version), "016 is part of a fresh install");

    insertTask(db, "task_new", 0, "any");
    runMigrations(db);
    assert.deepEqual(read(db, "task_new"), { night: 0, pref: "any" });
  } finally {
    db.close();
  }
});
