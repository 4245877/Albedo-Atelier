import type { DatabaseSync } from "node:sqlite";

import type { StoreLogger } from "../../../shared/logger";
import type { Migration } from "./types";
import { migration001 } from "./001_initial";
import { migration002 } from "./002_artifact_analysis";
import { migration003 } from "./003_slicing";
import { migration004 } from "./004_scheduling";
import { migration005 } from "./005_material_overrides";
import { migration006 } from "./006_assignment_plan_index";
import { migration007 } from "./007_start_guards";
import { migration008 } from "./008_canonical_dispatch";
import { migration009 } from "./009_executable_chain";
import { migration010 } from "./010_device_artifact_states";
import { migration011 } from "./011_operator_schedule";
import { migration012 } from "./012_printers";
import { migration013 } from "./013_printer_discovery";

/** Re-exported from `./types` so existing importers keep working. */
export type { Migration } from "./types";

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
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013
];

const MIGRATIONS_TABLE = "schema_migrations";

/**
 * The newest schema version this build of the image knows how to speak.
 *
 * Derived from the registry rather than hand-maintained, so it cannot drift.
 */
export const KNOWN_MAX_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => (migration.version > max ? migration.version : max),
  0
);

/**
 * Raised when the database has been migrated by a NEWER image than this one.
 *
 * Migrations are forward-only, so this situation is not recoverable by starting
 * anyway: the running code would be reading and writing a schema it was never
 * compiled against.
 */
export class SchemaTooNewError extends Error {
  readonly databaseVersion: number;
  readonly knownVersion: number;

  constructor(databaseVersion: number, knownVersion: number) {
    super(
      `database schema is newer than this application image: queue.db is at ` +
        `migration ${databaseVersion}, but this build only knows up to ` +
        `${knownVersion}. Migrations are forward-only, so this image cannot ` +
        `safely read or write this database. Deploy the newer image again, or ` +
        `restore a backup taken before the migration ` +
        `(ops/backup/restore.sh --set <set> --to-production --i-mean-it).`
    );
    this.name = "SchemaTooNewError";
    this.databaseVersion = databaseVersion;
    this.knownVersion = knownVersion;
  }
}

/**
 * Refuse to run against a schema from the future.
 *
 * Without this, `runMigrations` simply skipped every recorded version it did not
 * recognise (`if (appliedVersions.has(...)) continue` never looks the other
 * way), so rolling back to an older image after a migration started CLEANLY and
 * then misbehaved at runtime — inserting without a column that is now NOT NULL,
 * or writing to a table the newer schema had renamed. Silent divergence is the
 * worst possible outcome for a database with no backup; an honest refusal to
 * start is visible to `wait_for_health`, which already treats a crash-loop as a
 * failed deploy.
 */
export function assertSchemaNotNewerThanImage(db: DatabaseSync, logger: StoreLogger = {}): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(MIGRATIONS_TABLE);
  // A fresh database has no migration bookkeeping yet — nothing to compare.
  if (!tableExists) return;

  const row = db.prepare(`SELECT MAX(version) AS max FROM ${MIGRATIONS_TABLE}`).get() as
    | { max: number | null }
    | undefined;
  const databaseVersion = row?.max ?? 0;

  if (databaseVersion > KNOWN_MAX_SCHEMA_VERSION) {
    logger.error?.(
      { databaseVersion, knownVersion: KNOWN_MAX_SCHEMA_VERSION },
      "database schema is newer than this application image — refusing to start"
    );
    throw new SchemaTooNewError(databaseVersion, KNOWN_MAX_SCHEMA_VERSION);
  }
}

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

  // Before touching anything: is this database from the future?
  assertSchemaNotNewerThanImage(db, logger);

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
