import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * A profile revision is its raw bytes **and** what they resolve to.
 *
 * 003 made `raw_sha256` unique and kept `resolved_json`/`resolved_sha256`
 * mutable, re-derived on every import. That let the effective settings of an
 * APPROVED set change under the very revision id it pins: edit a parent preset
 * (or install a different vendor tree) and every child's resolved settings were
 * rewritten in place — the set stayed approved, the next slice used settings no
 * one had approved, and the record of what an earlier slice was cut with was
 * gone (HIGH-10).
 *
 * From here on a resolution, once a revision has one, never changes: the same
 * bytes resolving differently are a NEW revision row. So the identity becomes
 * the pair. `IFNULL` folds "not resolvable" into one value, so the same bytes
 * still have at most one unresolved row (SQLite treats NULLs in a unique index
 * as distinct). A plain index keeps the by-bytes lookup the importer starts from.
 *
 * Existing rows satisfy the new constraint trivially (`raw_sha256` was unique),
 * so nothing is rewritten — only the index changes.
 */
export const migration017: Migration = {
  version: 17,
  name: "017_profile_resolution_identity",
  up(db: DatabaseSync): void {
    db.exec(`
      DROP INDEX IF EXISTS idx_profile_revisions_raw_sha;
      CREATE INDEX idx_profile_revisions_raw_sha ON profile_revisions (raw_sha256);
      CREATE UNIQUE INDEX idx_profile_revisions_content
        ON profile_revisions (raw_sha256, IFNULL(resolved_sha256, ''));
    `);
  }
};
