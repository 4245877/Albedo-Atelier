import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { openDatabase } from "../database";

/*
 * The indexes that make "who still uses this file?" and "does anyone still hold
 * these bytes?" answerable without reading every row.
 *
 * These are not cosmetic. Every one of them backs a query on the artifact
 * DELETION path — the reverse lookups the safety check walks (migration 014) and
 * the dedup refcount that decides whether the blob may be unlinked (migration
 * 015). The refcount one is the sharp case: the orphan sweep asks it once per
 * blob on disk, so an unindexed `artifacts.source` made reconciliation quadratic
 * in the size of the store it exists to keep tidy.
 *
 * Asserting the query PLAN rather than the index name: an index nothing chooses
 * is not protection, and renaming one should not silently remove the guarantee.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-ref-indexes-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The plan SQLite chooses for `sql`, as one string. */
function plan(db: ReturnType<typeof openDatabase>, sql: string): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
  return rows.map((r) => r.detail).join(" | ");
}

test("every deletion-safety lookup is an index search, never a table scan", () => {
  const db = openDatabase(path.join(dir, "q.db"));
  try {
    const lookups: [string, string][] = [
      [
        "tasks by either binding column",
        "SELECT * FROM print_tasks WHERE artifact_id = ? OR source_artifact_id = ? ORDER BY created_at, id"
      ],
      [
        "assignments by artifact",
        "SELECT * FROM assignments WHERE artifact_id = ? ORDER BY created_at DESC, id DESC"
      ],
      [
        "assignments by slice variant",
        "SELECT * FROM assignments WHERE slice_variant_id = ? ORDER BY created_at DESC, id DESC"
      ],
      [
        "tracked device files by artifact",
        "SELECT * FROM device_artifacts WHERE artifact_id = ? ORDER BY created_at DESC, id DESC"
      ],
      [
        "slice variants by source or output",
        "SELECT * FROM slice_variants WHERE source_artifact_id = ? OR output_artifact_id = ? ORDER BY created_at DESC, id DESC"
      ]
    ];
    for (const [what, sql] of lookups) {
      const chosen = plan(db, sql);
      assert.doesNotMatch(chosen, /\bSCAN\b/, `${what} must not scan a whole table — plan: ${chosen}`);
      assert.match(chosen, /SEARCH .* USING INDEX/, `${what} must use an index — plan: ${chosen}`);
    }
  } finally {
    db.close();
  }
});

test("the dedup refcount — the check that gates every blob unlink — uses an index", () => {
  const db = openDatabase(path.join(dir, "q.db"));
  try {
    for (const sql of [
      "SELECT COUNT(*) AS n FROM artifacts WHERE source = ?",
      "SELECT * FROM artifacts WHERE source = ? LIMIT 1"
    ]) {
      const chosen = plan(db, sql);
      assert.doesNotMatch(chosen, /SCAN artifacts/, `the orphan sweep asks this per blob — plan: ${chosen}`);
      assert.match(chosen, /USING (COVERING )?INDEX idx_artifacts_source/, `plan: ${chosen}`);
    }
  } finally {
    db.close();
  }
});

test("the source index is partial — legacy name-only artifacts are never looked up by key", () => {
  const db = openDatabase(path.join(dir, "q.db"));
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_artifacts_source'")
      .get() as { sql: string } | undefined;
    assert.ok(row, "idx_artifacts_source exists");
    assert.match(row.sql, /WHERE\s+source\s+IS\s+NOT\s+NULL/i);
  } finally {
    db.close();
  }
});
