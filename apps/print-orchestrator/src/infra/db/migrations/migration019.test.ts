import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";

import { openDatabase } from "../database";
import { KNOWN_MAX_SCHEMA_VERSION, MIGRATIONS } from "./index";

/*
 * Migration 019 adds `printers.tls_fingerprint`. Pinned here: a plain column
 * addition that leaves every existing value, the discovery rows and the
 * constraints alone, and that reads "nothing confirmed" for every printer —
 * which is what keeps every other protocol exactly as it was.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-migration019-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every migration up to 018. */
function openAtVersion018(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
  );
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 18)) {
    migration.up(db);
    record.run(migration.version, migration.name, new Date().toISOString());
  }
  return db;
}

function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return (db.prepare(sql).all() as Record<string, unknown>[]).map((row) => ({ ...row }));
}

test("019 adds an empty tls_fingerprint to every printer and touches nothing else", () => {
  const file = path.join(dir, "farm.db");
  const old = openAtVersion018(file);
  const insert = old.prepare(
    "INSERT INTO printers (id, name, protocol, host, allow_insecure_tls, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'now', 'now')"
  );
  insert.run("bambu-a1", "Bambu A1", "bambu", "192.168.1.187", 1);
  insert.run("kobra-x", "Kobra X", "anycubic-lan", "192.168.1.60", 1);
  old
    .prepare("INSERT INTO printer_discovery (id, protocol, facts, probed_at, succeeded) VALUES ('bambu-a1', 'bambu', '{}', 'now', 1)")
    .run();
  const before = rows(old, "SELECT * FROM printers ORDER BY id");
  const discoveryBefore = rows(old, "SELECT * FROM printer_discovery ORDER BY id");
  old.close();

  const db = openDatabase(file);
  try {
    assert.deepEqual(
      rows(db, "SELECT * FROM printers ORDER BY id"),
      before.map((row) => ({ ...row, tls_fingerprint: "" })),
      "nothing is confirmed for anyone — not even a printer that had the TLS opt-in"
    );
    assert.deepEqual(rows(db, "SELECT * FROM printer_discovery ORDER BY id"), discoveryBefore);
    const versions = rows(db, "SELECT version FROM schema_migrations ORDER BY version").map((r) => r.version);
    assert.equal(versions.at(-1), 19);
    assert.equal(KNOWN_MAX_SCHEMA_VERSION, 19);
    assert.deepEqual(rows(db, "PRAGMA foreign_key_check"), []);
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    assert.equal(integrity.integrity_check, "ok");
  } finally {
    db.close();
  }
});

test("a printer inserted without the column reads as unconfirmed; the protocol CHECK is intact", () => {
  const db = openDatabase(path.join(dir, "fresh.db"));
  try {
    db.prepare(
      "INSERT INTO printers (id, name, protocol, host, created_at, updated_at) VALUES ('kobra-x', 'Kobra X', 'anycubic-lan', '192.168.1.60', 'now', 'now')"
    ).run();
    assert.equal(
      (db.prepare("SELECT tls_fingerprint FROM printers WHERE id = 'kobra-x'").get() as { tls_fingerprint: string })
        .tls_fingerprint,
      ""
    );
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO printers (id, name, protocol, host, created_at, updated_at) VALUES ('x', 'x', 'anycubic', 'h', 'now', 'now')"
          )
          .run(),
      /CHECK constraint failed/
    );
  } finally {
    db.close();
  }
});
