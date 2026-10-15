/* Read-only summary of a queue.db copy: integrity, schema, profiles, sets, tasks, runs, guards, beds, operations. */
const { DatabaseSync } = require("node:sqlite");
const snap = new DatabaseSync(process.argv[2], { readOnly: true });
const all = (sql) => snap.prepare(sql).all();
const one = (sql) => all(sql)[0];
console.log(JSON.stringify({
  integrity: all("PRAGMA integrity_check").map((r) => r.integrity_check).join(","),
  fkViolations: all("PRAGMA foreign_key_check").length,
  schema: one("SELECT COUNT(*) n, MAX(version) mx FROM schema_migrations"),
  revisions: one("SELECT COUNT(*) n, COUNT(DISTINCT raw_sha256) distinctRaw, SUM(status='active') active FROM profile_revisions"),
  revisionIndexes: all("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='profile_revisions'").map((r) => r.name),
  sets: all("SELECT id, name, approved, validation, printer_id FROM profile_sets"),
  tasks: all("SELECT state, COUNT(*) n FROM print_tasks GROUP BY state"),
  activeRuns: one("SELECT COUNT(*) n FROM print_runs WHERE state IN ('PENDING','RUNNING','PAUSED','UNKNOWN')"),
  guards: one("SELECT COUNT(*) n FROM start_guards"),
  openOps: all("SELECT type, state, printer_id FROM manual_operations WHERE state NOT IN ('COMPLETED','CANCELLED')"),
  liveAssignments: all("SELECT state, source, invalidated_at IS NOT NULL inv, COUNT(*) n FROM assignments WHERE state IN ('PROPOSED','RESERVED','ACTIVE') GROUP BY 1,2,3"),
  beds: all("SELECT printer_id, state, created_at FROM bed_cycles ORDER BY rowid DESC LIMIT 6"),
  analyses3mf: one("SELECT COUNT(*) n FROM artifact_analyses WHERE detected_format='3mf'"),
  analyzerVersions: all("SELECT analyzer_version v, detected_format f, COUNT(*) n FROM artifact_analyses GROUP BY 1,2")
}, null, 1));
snap.close();
