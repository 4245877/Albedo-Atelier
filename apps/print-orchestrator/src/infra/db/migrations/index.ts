import type { DatabaseSync } from "node:sqlite";

import type { StoreLogger } from "../../../shared/logger";
import { migration001 } from "./001_initial";
import { migration002 } from "./002_artifact_analysis";
import { migration003 } from "./003_slicing";
import { migration004 } from "./004_scheduling";
import { migration005 } from "./005_material_overrides";
import { migration006 } from "./006_assignment_plan_index";

/**
 * One forward-only schema migration. `up` receives the open connection and runs
 * inside a transaction the runner opens for it, so a migration that throws
 * half-way leaves the schema untouched.
 */
export interface Migration {
  /** Strictly increasing, unique across the registry. */
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/**
 * The ordered migration registry — the single source of truth for the schema.
 * Append new migrations here with the next version number; never edit or
 * reorder an already-shipped one (a deployed database has recorded it as run).
 */
export const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006
];

const MIGRATIONS_TABLE = "schema_migrations";

/**
 * Brings `db` up to the latest schema and returns the names of the migrations
 * it actually applied (empty when already current).
 *
 * Idempotent: applied versions are recorded in `schema_migrations`, so re-running
 * against an up-to-date database is a no-op — which is exactly what lets two
 * connections to the same file (a restart, or two FarmStores in a test) both
 * call this safely. Each migration runs in its own transaction together with the
 * bookkeeping insert, so the recorded set can never drift from the real schema.
 */
export function runMigrations(db: DatabaseSync, logger: StoreLogger = {}): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`
  );

  const appliedVersions = new Set(
    (db.prepare(`SELECT version FROM ${MIGRATIONS_TABLE}`).all() as { version: number }[]).map(
      (row) => row.version
    )
  );

  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  assertUniqueVersions(ordered);

  const recordStmt = db.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`
  );

  const applied: string[] = [];
  for (const migration of ordered) {
    if (appliedVersions.has(migration.version)) continue;

    db.exec("BEGIN");
    try {
      migration.up(db);
      recordStmt.run(migration.version, migration.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      logger.error?.({ err: error, migration: migration.name }, "migration failed");
      throw error;
    }
    applied.push(migration.name);
  }

  return applied;
}

function assertUniqueVersions(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version} (${migration.name})`);
    }
    seen.add(migration.version);
  }
}
