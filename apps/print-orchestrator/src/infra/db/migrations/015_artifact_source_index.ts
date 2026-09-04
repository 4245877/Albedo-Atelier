import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * The index for the dedup refcount — "does any other artifact still hold these
 * bytes?".
 *
 * `artifacts.source` is the content-addressed storage key, and it is the ONE
 * question that stands between a deletion and an unlink: `countBySource(key)`
 * decides whether the blob may go, and `findBySource(key)` decides whether a
 * failed upload may take its own bytes back. Both ran as full scans of
 * `artifacts` — migration 014 indexed every table that points AT an artifact
 * and left the artifact table's own key column unindexed.
 *
 * The cost is not per delete (one scan) but per sweep: `orphanSweep` asks the
 * question once for every blob on disk, so reconciliation was O(blobs ×
 * artifacts) — quadratic in the size of the store it exists to keep tidy.
 *
 * Partial (`WHERE source IS NOT NULL`): legacy name-only artifacts have no blob
 * and are never looked up this way, so they stay out of the index.
 *
 * Pure index addition: no column, constraint or row is touched.
 */
export const migration015: Migration = {
  version: 15,
  name: "015_artifact_source_index",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_source
        ON artifacts (source) WHERE source IS NOT NULL;
    `);
  }
};
