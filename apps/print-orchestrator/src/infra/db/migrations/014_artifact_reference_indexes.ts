import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * Indexes for the "who still uses this file?" question.
 *
 * Deleting an artifact is only safe if we can enumerate every row that points at
 * it — tasks (through either binding column), assignments, tracked device files
 * and slice variants. Until now none of those reverse lookups had an index, so
 * each one was a full table scan; the retention safety check runs several of
 * them per artifact, and the dashboard asks for the whole list on every poll.
 *
 * Pure index additions: no column, constraint or row is touched, so the
 * migration is safe to apply to a live database and changes no behaviour beyond
 * the plan chosen for these lookups.
 */
export const migration014: Migration = {
  version: 14,
  name: "014_artifact_reference_indexes",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_print_tasks_artifact
        ON print_tasks (artifact_id);
      CREATE INDEX IF NOT EXISTS idx_print_tasks_source_artifact
        ON print_tasks (source_artifact_id);

      CREATE INDEX IF NOT EXISTS idx_assignments_artifact
        ON assignments (artifact_id);
      CREATE INDEX IF NOT EXISTS idx_assignments_slice_variant
        ON assignments (slice_variant_id);

      CREATE INDEX IF NOT EXISTS idx_device_artifacts_artifact
        ON device_artifacts (artifact_id);

      CREATE INDEX IF NOT EXISTS idx_slice_variants_source_artifact
        ON slice_variants (source_artifact_id);
      CREATE INDEX IF NOT EXISTS idx_slice_variants_output_artifact
        ON slice_variants (output_artifact_id);
    `);
  }
};
