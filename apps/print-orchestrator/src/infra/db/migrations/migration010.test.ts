import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";

import { openDatabase } from "../database";
import { MIGRATIONS, runMigrations } from "./index";

/*
 * Migration 010 rebuilds `device_artifacts` to widen its state CHECK from one
 * failure state to three (FAILED / INVALID / STALE). A rebuild is the one kind
 * of migration that can lose data, so these tests run it against a database
 * populated the way a live one is — and assert every row survives verbatim.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-migration010-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs every migration except 010 — a database as it looked before this change. */
function openAtVersion009(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  const before = MIGRATIONS.filter((m) => m.version <= 9);
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
  );
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
  );
  for (const migration of before) {
    migration.up(db);
    record.run(migration.version, migration.name, new Date().toISOString());
  }
  return db;
}

const ROW = {
  id: "dva_1",
  printer_id: "k2",
  assignment_id: "asg_1",
  slice_variant_id: "slc_1",
  artifact_id: "art_1",
  artifact_sha256: "a".repeat(64),
  remote_path: "cube-aabbccdd.gcode",
  size_bytes: 4242,
  state: "VERIFIED",
  transfer_mode: "adapter_upload",
  verification: "name_and_size",
  uploaded_at: "2026-07-20T10:00:00.000Z",
  verified_at: "2026-07-20T10:00:05.000Z",
  confirmed_by: null as string | null,
  last_error: null as string | null,
  created_at: "2026-07-20T09:59:00.000Z",
  updated_at: "2026-07-20T10:00:05.000Z",
  version: 3,
  metadata: '{"profileRevisionIds":["prv_1"]}'
};

test("a clean database gets device_artifacts with all seven states allowed", () => {
  const db = openDatabase(path.join(dir, "clean.db"));
  try {
    const recorded = (
      db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    assert.deepEqual(recorded, MIGRATIONS.map((m) => m.version), "010 is part of a fresh install");

    for (const state of [
      "NOT_PRESENT",
      "UPLOADING",
      "PRESENT_UNVERIFIED",
      "VERIFIED",
      "INVALID",
      "FAILED",
      "STALE"
    ]) {
      db.prepare(
        `INSERT INTO device_artifacts
           (id, printer_id, remote_path, state, transfer_mode, created_at, updated_at, version, metadata)
         VALUES (?, 'k2', ?, ?, 'adapter_upload', '2026-01-01', '2026-01-01', 1, '{}')`
      ).run(`dva_${state}`, `${state}.gcode`, state);
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM device_artifacts").get() as { n: number };
    assert.equal(count.n, 7);

    // …and nothing outside the vocabulary.
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO device_artifacts
             (id, printer_id, remote_path, state, transfer_mode, created_at, updated_at, version, metadata)
           VALUES ('dva_x', 'k2', 'x.gcode', 'PROBABLY_FINE', 'adapter_upload', '2026-01-01', '2026-01-01', 1, '{}')`
        )
        .run()
    );
  } finally {
    db.close();
  }
});

test("an existing 009 database keeps every device-artifact row through the rebuild", () => {
  const file = path.join(dir, "existing.db");
  const old = openAtVersion009(file);
  const columns = Object.keys(ROW);
  old
    .prepare(
      `INSERT INTO device_artifacts (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`
    )
    .run(...(Object.values(ROW) as (string | number | null)[]));
  // A pre-existing INVALID row must NOT be reclassified by the migration.
  old
    .prepare(
      `INSERT INTO device_artifacts
         (id, printer_id, remote_path, state, transfer_mode, last_error, created_at, updated_at, version, metadata)
       VALUES ('dva_2', 'k2', 'old.gcode', 'INVALID', 'manual_file_transfer', 'что-то пошло не так',
               '2026-07-01', '2026-07-01', 1, '{}')`
    )
    .run();
  old.close();

  const applied = (() => {
    const db = new DatabaseSync(file);
    try {
      return runMigrations(db);
    } finally {
      db.close();
    }
  })();
  assert.deepEqual(applied, ["010_device_artifact_states"], "only the pending migration ran");

  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("SELECT * FROM device_artifacts WHERE id = 'dva_1'").get() as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(ROW)) {
      assert.equal(row[key], value, key);
    }

    const legacy = db.prepare("SELECT state, last_error FROM device_artifacts WHERE id = 'dva_2'").get() as {
      state: string;
      last_error: string;
    };
    assert.equal(legacy.state, "INVALID", "history is not rewritten into the new vocabulary");
    assert.equal(legacy.last_error, "что-то пошло не так");

    // The indexes were recreated, including the slot uniqueness the whole
    // idempotency story rests on.
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'device_artifacts'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(indexes.includes("uq_device_artifacts_slot"));
    assert.ok(indexes.includes("idx_device_artifacts_variant"));
    assert.ok(indexes.includes("idx_device_artifacts_assignment"));

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO device_artifacts
               (id, printer_id, remote_path, state, transfer_mode, created_at, updated_at, version, metadata)
             VALUES ('dva_dup', 'k2', 'cube-aabbccdd.gcode', 'VERIFIED', 'adapter_upload',
                     '2026-01-01', '2026-01-01', 1, '{}')`
          )
          .run(),
      "two records for one device slot stay impossible"
    );

    // The new states are now writable on the migrated database.
    for (const state of ["FAILED", "STALE"]) {
      db.prepare(
        `INSERT INTO device_artifacts
           (id, printer_id, remote_path, state, transfer_mode, created_at, updated_at, version, metadata)
         VALUES (?, 'k2', ?, ?, 'adapter_upload', '2026-01-01', '2026-01-01', 1, '{}')`
      ).run(`dva_${state}`, `${state}.gcode`, state);
    }
  } finally {
    db.close();
  }
});

test("re-running the migrations on an up-to-date database is a no-op", () => {
  const file = path.join(dir, "twice.db");
  openDatabase(file).close();
  const db = new DatabaseSync(file);
  try {
    assert.deepEqual(runMigrations(db), [], "nothing re-applied, no table rebuilt twice");
  } finally {
    db.close();
  }
});
