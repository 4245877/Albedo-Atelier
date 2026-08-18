/**
 * Verify one backup set. Runs on the HOST (plain node, no container): a backup
 * that can only be checked by the system it is supposed to survive is not a
 * backup.
 *
 * argv[2] = set directory. Exits non-zero with a reason on any failure.
 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const setDir = process.argv[2];
if (!setDir) { console.error("usage: verify-set.js <set-dir>"); process.exit(2); }

const problems = [];
const notes = [];
const req = (p) => path.join(setDir, p);

// -- required files ---------------------------------------------------------
for (const f of ["manifest.json", "queue.db"]) {
  if (!fs.existsSync(req(f))) problems.push(`missing required file: ${f}`);
  else if (fs.statSync(req(f)).size === 0) problems.push(`empty file: ${f}`);
}
if (problems.length) { problems.forEach((p) => console.error("FAIL " + p)); process.exit(1); }

const manifest = JSON.parse(fs.readFileSync(req("manifest.json"), "utf8"));
notes.push(`mode=${manifest.mode} tier=${manifest.tier} createdAt=${manifest.createdAt}`);

// -- the database itself, opened from the backup ----------------------------
const db = new DatabaseSync(req("queue.db"), { readOnly: true });
const all = (sql) => db.prepare(sql).all();

const integrity = all("PRAGMA integrity_check").map((r) => r.integrity_check).join(",");
if (integrity !== "ok") problems.push(`integrity_check: ${integrity}`);
else notes.push("integrity_check=ok");

const fk = all("PRAGMA foreign_key_check");
if (fk.length) problems.push(`foreign_key_check: ${fk.length} violation(s)`);
else notes.push("foreign_key_check=clean");

const mig = all("SELECT COUNT(*) n, MAX(version) mx FROM schema_migrations")[0];
notes.push(`schema_version=${mig.mx} migrations=${mig.n}`);
if (manifest.database && manifest.database.schemaVersion !== mig.mx) {
  problems.push(`manifest schema_version ${manifest.database.schemaVersion} != db ${mig.mx}`);
}

// counts must match what the manifest recorded at snapshot time
if (manifest.database && manifest.database.counts) {
  for (const [table, expected] of Object.entries(manifest.database.counts)) {
    let actual;
    try { actual = all(`SELECT COUNT(*) n FROM "${table}"`)[0].n; }
    catch (e) { problems.push(`table ${table} unreadable: ${e.message}`); continue; }
    if (actual !== expected) problems.push(`count drift in ${table}: manifest ${expected}, backup ${actual}`);
  }
  notes.push(`counts verified for ${Object.keys(manifest.database.counts).length} tables`);
}

// -- THE consistency invariant ----------------------------------------------
// Every blob this database references must be present in this set. A full set
// carries artifacts/; a db-only set deliberately does not, and defers the blob
// guarantee to the full line rather than pretending to provide it.
const refs = all("SELECT id, source, sha256 FROM artifacts WHERE source IS NOT NULL AND source <> ''");
if (manifest.mode === "full") {
  const missing = [];
  for (const r of refs) {
    if (!fs.existsSync(path.join(setDir, "artifacts", r.source))) missing.push(`${r.id} -> ${r.source}`);
  }
  if (missing.length) {
    problems.push(`${missing.length} referenced artifact blob(s) absent from the set: ${missing.slice(0, 5).join(", ")}`);
  } else {
    notes.push(`artifact references: ${refs.length}/${refs.length} blobs present`);
  }
} else {
  notes.push(`artifact references: ${refs.length} (db-only set — blobs live in the full line)`);
}
db.close();

// -- secrets must not be world-readable -------------------------------------
const secret = req("secrets/atelier.env");
if (fs.existsSync(secret)) {
  const mode = fs.statSync(secret).mode & 0o777;
  if (mode & 0o077) problems.push(`secrets/atelier.env is mode ${mode.toString(8)}, must be 0600`);
  else notes.push("secrets permissions=0600");
}

notes.forEach((n) => console.log("  " + n));
if (problems.length) { problems.forEach((p) => console.error("FAIL " + p)); process.exit(1); }
console.log("  VERIFIED");
