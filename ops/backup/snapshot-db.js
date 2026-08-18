/**
 * Consistent point-in-time snapshot of queue.db, run INSIDE a container that can
 * see /app/data.
 *
 * `VACUUM INTO` is the correct primitive on a live WAL database: it takes a read
 * transaction and writes a fresh, fully-checkpointed copy, so the result never
 * depends on the -wal/-shm sidecars the way `cp queue.db` does. The source
 * connection is opened READ-ONLY, so this cannot mutate production even if the
 * script is wrong.
 *
 * Emits one line of JSON on stdout, prefixed with SNAPSHOT_JSON: so the shell
 * can pick it out of any incidental output.
 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dataDir = process.env.ATELIER_DATA_DIR || "/app/data";
const stagingDir = path.join(dataDir, ".backup-staging");
const sourcePath = path.join(dataDir, "queue.db");
const outPath = path.join(stagingDir, "queue.db");

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

const src = new DatabaseSync(sourcePath, { readOnly: true });
// VACUUM INTO refuses to overwrite, and we just removed the directory.
src.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
src.close();

// Everything below inspects the SNAPSHOT, not production: what we report is a
// property of the artifact we just produced.
const snap = new DatabaseSync(outPath, { readOnly: true });
const all = (sql) => snap.prepare(sql).all();
const one = (sql) => all(sql)[0];

const integrity = all("PRAGMA integrity_check").map((r) => r.integrity_check).join(",");
const foreignKeys = all("PRAGMA foreign_key_check");
const migrations = one("SELECT COUNT(*) n, MAX(version) mx FROM schema_migrations");

const tables = all(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).map((r) => r.name);
const counts = {};
for (const t of tables) counts[t] = one(`SELECT COUNT(*) n FROM "${t}"`).n;

// The blob keys this snapshot depends on. The backup is only consistent if every
// one of these exists in the artifacts copy taken AFTER this snapshot — verified
// explicitly rather than assumed.
const artifactKeys = all(
  "SELECT source, sha256 FROM artifacts WHERE source IS NOT NULL AND source <> ''"
).map((r) => ({ source: r.source, sha256: r.sha256 }));

snap.close();

process.stdout.write(
  "SNAPSHOT_JSON:" +
    JSON.stringify({
      sizeBytes: fs.statSync(outPath).size,
      integrityCheck: integrity,
      foreignKeyViolations: foreignKeys.length,
      schemaVersion: migrations.mx,
      migrationCount: migrations.n,
      tableCount: tables.length,
      counts,
      artifactKeys
    }) +
    "\n"
);
