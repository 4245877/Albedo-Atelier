import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { StoreLogger } from "../../shared/logger";
import { runMigrations } from "./migrations";

/**
 * Opens the SQLite database that backs the print-queue model and brings its
 * schema up to date.
 *
 * The connection is configured for a long-lived single-process service that
 * shares one file across a mounted volume:
 *   - **WAL** journal — concurrent readers never block the writer, and a crash
 *     mid-write cannot corrupt the file (same durability goal the JSON store
 *     met with temp-file+rename, done properly here).
 *   - **foreign_keys ON** — the `PrintTask → Assignment → DispatchAttempt →
 *     PrintRun` chain is enforced by the engine, not by hope.
 *   - **busy_timeout** — a second connection (e.g. two FarmStores in one test,
 *     or a future reader) waits briefly for a lock instead of failing at once.
 *
 * `:memory:` is honoured for tests (no directory work, WAL is a harmless no-op).
 * Migrations run before the handle is returned, so callers always get a
 * ready-to-use, current-schema database.
 */
export function openDatabase(dbPath: string, logger: StoreLogger = {}): DatabaseSync {
  if (dbPath !== ":memory:") {
    // DatabaseSync creates the file but not its parent directory. In the
    // container this is /app/data (a mounted volume) which already exists, but
    // on a fresh dev checkout or a test tmpdir it may not.
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  // WAL persists in the file header, but setting it every open is cheap and
  // makes an in-memory or freshly-copied file behave the same.
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL"); // WAL-safe durability at far lower fsync cost
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const applied = runMigrations(db, logger);
  if (applied.length > 0) {
    logger.info?.({ applied, path: dbPath }, "queue database migrations applied");
  }

  // One integrity check at open, never per request. On a file this size it costs
  // single-digit milliseconds, and it is the only thing that distinguishes "the
  // database opened" from "the database is intact" — a corrupted page deep in a
  // table is invisible until the query that touches it runs, potentially days
  // later. Loud on failure, silent-but-recorded on success.
  runStartupIntegrityCheck(db, dbPath, logger);

  return db;
}

/**
 * `PRAGMA integrity_check` at startup. Deliberately NOT fatal: a corrupted
 * database that still serves most reads is more useful to an operator than a
 * container that refuses to boot, and the loud log plus the `db_ok` metric make
 * the condition impossible to miss. (Contrast with a schema from the future,
 * which IS fatal — that one silently corrupts data if allowed to proceed.)
 */
function runStartupIntegrityCheck(db: DatabaseSync, dbPath: string, logger: StoreLogger): void {
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    const result = rows.map((row) => row.integrity_check).join("; ");
    if (result === "ok") {
      logger.info?.({ path: dbPath }, "queue database integrity check passed");
    } else {
      logger.error?.(
        { path: dbPath, result },
        "QUEUE DATABASE INTEGRITY CHECK FAILED — restore a backup (ops/backup/restore.sh)"
      );
    }
  } catch (error) {
    logger.error?.({ err: error, path: dbPath }, "queue database integrity check could not run");
  }
}

/**
 * The cheap per-request database probe behind `/ready` and the `db_ok` metric.
 *
 * Intentionally trivial — one prepared statement against the migration
 * bookkeeping table. It answers "can this process still talk to its database",
 * which is what readiness needs; it is NOT an integrity check and must never
 * become one, because `/ready` is polled by the Docker healthcheck every few
 * seconds.
 */
export function probeDatabase(db: DatabaseSync): { ok: boolean; error?: string } {
  try {
    db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
