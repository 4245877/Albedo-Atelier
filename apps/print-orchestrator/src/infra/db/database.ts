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

  return db;
}
