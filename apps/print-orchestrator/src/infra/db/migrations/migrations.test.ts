import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";

import { openDatabase } from "../database";
import { MIGRATIONS, runMigrations } from "./index";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-migrations-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("openDatabase applies every migration, enables WAL and foreign keys", () => {
  const db = openDatabase(path.join(dir, "q.db"));
  try {
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(journal.journal_mode, "wal");
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    assert.equal(fk.foreign_keys, 1);

    const recorded = (
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    assert.deepEqual(recorded, MIGRATIONS.map((m) => m.version));

    // Every declared table exists.
    for (const table of [
      "artifacts",
      "artifact_analyses",
      "print_tasks",
      "queue_entries",
      "plans",
      "assignments",
      "bed_cycles",
      "dispatch_attempts",
      "print_runs",
      "audit_events",
      "app_meta"
    ]) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table);
      assert.ok(row, `table ${table} exists`);
    }
  } finally {
    db.close();
  }
});

test("runMigrations is idempotent — a second run applies nothing", () => {
  const file = path.join(dir, "q.db");
  const db = openDatabase(file);
  try {
    assert.deepEqual(runMigrations(db), [], "already current after openDatabase");
  } finally {
    db.close();
  }

  // A brand-new connection to a fresh file applies the full set exactly once.
  const fresh = new DatabaseSync(path.join(dir, "fresh.db"));
  try {
    const first = runMigrations(fresh);
    assert.equal(first.length, MIGRATIONS.length);
    assert.deepEqual(runMigrations(fresh), []);
  } finally {
    fresh.close();
  }
});

test("foreign keys and state CHECK constraints are enforced at the storage layer", () => {
  const db = openDatabase(path.join(dir, "q.db"));
  try {
    // Bad artifact_id → FK violation.
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO print_tasks (id, artifact_id, title, state, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?)"
        )
        .run("t1", "missing", "x", "QUEUED", "now", "now", 1)
    );
    // Unknown state value → CHECK violation.
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO print_tasks (id, title, state, created_at, updated_at, version) VALUES (?,?,?,?,?,?)"
        )
        .run("t2", "x", "NONSENSE", "now", "now", 1)
    );
  } finally {
    db.close();
  }
});
