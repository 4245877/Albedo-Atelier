import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";

import { openDatabase } from "../database";
import {
  assertSchemaNotNewerThanImage,
  KNOWN_MAX_SCHEMA_VERSION,
  MIGRATIONS,
  runMigrations,
  SchemaTooNewError
} from "./index";

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

// ── Schema compatibility guard (AT-013) ─────────────────────────────────────
// A database migrated by a NEWER image must not be opened by an older one.
// Before the guard existed, runMigrations() silently ignored unknown recorded
// versions and started normally, leaving the old code to read and write a
// schema it was never compiled against.
test("refuses to start when the database schema is newer than the image", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);

  // Simulate a future image having applied one more migration than we know.
  const future = KNOWN_MAX_SCHEMA_VERSION + 1;
  db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
    future,
    `${future}_from_a_newer_image`,
    new Date().toISOString()
  );

  assert.throws(
    () => runMigrations(db),
    (error: unknown) => {
      assert.ok(error instanceof SchemaTooNewError, "expected SchemaTooNewError");
      assert.equal(error.databaseVersion, future);
      assert.equal(error.knownVersion, KNOWN_MAX_SCHEMA_VERSION);
      // The message has to name the actual problem: an operator reading only
      // this line must understand that the IMAGE is old, not the database bad.
      assert.match(error.message, /schema is newer than this application image/i);
      return true;
    }
  );
  db.close();
});

test("the guard does not fire on an equal or older schema", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  // Same version: fine (this is the ordinary restart case).
  assert.doesNotThrow(() => runMigrations(db));
  // Older recorded max than the image knows: also fine — that is just a
  // database that has yet to receive the newest migrations.
  db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(KNOWN_MAX_SCHEMA_VERSION);
  assert.doesNotThrow(() => assertSchemaNotNewerThanImage(db));
  db.close();
});

test("a database with no migration bookkeeping is not rejected", () => {
  const db = new DatabaseSync(":memory:");
  assert.doesNotThrow(() => assertSchemaNotNewerThanImage(db));
  db.close();
});
