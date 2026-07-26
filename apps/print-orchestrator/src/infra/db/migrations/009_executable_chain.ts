import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * The **executable chain**: makes the slice → queue → plan → assignment →
 * device → dispatch path carry typed, verifiable data instead of free-form
 * `metadata` blobs.
 *
 * Three changes, each closing a concrete gap found in the audit:
 *
 * 1. `print_tasks` gains `slice_variant_id` / `source_artifact_id` /
 *    `on_device_file`. Before this, the slice→queue handoff recorded the exact
 *    executable variant only in `metadata.file` / `metadata.sliceVariantId` —
 *    an untyped blob nothing could join on, so the queue was bound to a *file
 *    name*, not to a slice. The legacy metadata keys are backfilled into the
 *    columns and kept (readers migrate, nothing breaks).
 *
 * 2. `assignments` gains the full **binding**: the slice variant, artifact +
 *    its content hash, the three profile revision ids, the expected on-device
 *    path, the material/nozzle/flavor/ETA the placement was computed for, the
 *    plan revision and provenance (`source`, `reason`, `created_by`), plus an
 *    invalidation marker. `DispatchReservation` already *read* several of these
 *    from `assignment.metadata` — nothing ever wrote them, so every reservation
 *    check (slice mismatch, hash mismatch, expected path) was dormant. They are
 *    now real columns written by plan confirmation and manual assignment.
 *
 * 3. `device_artifacts` — the previously missing link between "a slice is
 *    ready" and "the exact bytes are on that printer". One row per (printer,
 *    remote path) recording how the file got there and how strongly it was
 *    verified (`name_and_size` for Moonraker, `operator_confirmed` for adapters
 *    with no file API — never a fabricated SHA-256).
 *
 * Additive only: every new column is nullable, so an existing database keeps
 * reading and nothing needs rewriting.
 */
export const migration009: Migration = {
  version: 9,
  name: "009_executable_chain",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE print_tasks ADD COLUMN slice_variant_id   TEXT;
      ALTER TABLE print_tasks ADD COLUMN source_artifact_id TEXT;
      ALTER TABLE print_tasks ADD COLUMN on_device_file     TEXT;

      ALTER TABLE assignments ADD COLUMN slice_variant_id     TEXT;
      ALTER TABLE assignments ADD COLUMN artifact_id          TEXT;
      ALTER TABLE assignments ADD COLUMN artifact_sha256      TEXT;
      ALTER TABLE assignments ADD COLUMN machine_revision_id  TEXT;
      ALTER TABLE assignments ADD COLUMN process_revision_id  TEXT;
      ALTER TABLE assignments ADD COLUMN filament_revision_id TEXT;
      ALTER TABLE assignments ADD COLUMN expected_remote_path TEXT;
      ALTER TABLE assignments ADD COLUMN gcode_flavor         TEXT;
      ALTER TABLE assignments ADD COLUMN nozzle_mm            REAL;
      ALTER TABLE assignments ADD COLUMN material             TEXT;
      ALTER TABLE assignments ADD COLUMN eta_s                INTEGER;
      ALTER TABLE assignments ADD COLUMN planned_start_at     TEXT;
      ALTER TABLE assignments ADD COLUMN plan_revision        INTEGER;
      ALTER TABLE assignments ADD COLUMN source               TEXT;
      ALTER TABLE assignments ADD COLUMN reason               TEXT;
      ALTER TABLE assignments ADD COLUMN created_by           TEXT;
      ALTER TABLE assignments ADD COLUMN invalidated_at       TEXT;
      ALTER TABLE assignments ADD COLUMN invalidated_reason   TEXT;

      CREATE TABLE device_artifacts (
        id               TEXT PRIMARY KEY,
        printer_id       TEXT NOT NULL,
        assignment_id    TEXT,
        slice_variant_id TEXT,
        artifact_id      TEXT,
        artifact_sha256  TEXT,
        remote_path      TEXT NOT NULL,
        size_bytes       INTEGER,
        state            TEXT NOT NULL CHECK (state IN
                           ('NOT_PRESENT','UPLOADING','PRESENT_UNVERIFIED','VERIFIED','INVALID')),
        transfer_mode    TEXT NOT NULL CHECK (transfer_mode IN ('adapter_upload','manual_file_transfer')),
        verification     TEXT CHECK (verification IN ('name_and_size','name_only','operator_confirmed')),
        uploaded_at      TEXT,
        verified_at      TEXT,
        confirmed_by     TEXT,
        last_error       TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        version          INTEGER NOT NULL,
        metadata         TEXT NOT NULL DEFAULT '{}'
      );

      CREATE UNIQUE INDEX uq_device_artifacts_slot
        ON device_artifacts (printer_id, remote_path);
      CREATE INDEX idx_device_artifacts_variant
        ON device_artifacts (slice_variant_id);
      CREATE INDEX idx_device_artifacts_assignment
        ON device_artifacts (assignment_id);
    `);

    // Backfill the task columns from the legacy metadata blob the handoff wrote,
    // so a database that already promoted slices keeps its exact bindings.
    db.exec(`
      UPDATE print_tasks
         SET on_device_file     = json_extract(metadata, '$.file'),
             slice_variant_id   = json_extract(metadata, '$.sliceVariantId'),
             source_artifact_id = json_extract(metadata, '$.sourceArtifactId')
       WHERE json_valid(metadata);
    `);

    // Same for the handful of reservation fields the eligibility check already
    // read out of assignment.metadata (written by nothing, but a hand-patched or
    // future row may carry them — never lose data that IS there).
    db.exec(`
      UPDATE assignments
         SET slice_variant_id     = json_extract(metadata, '$.sliceVariantId'),
             artifact_sha256      = json_extract(metadata, '$.artifactSha256'),
             expected_remote_path = json_extract(metadata, '$.expectedRemotePath')
       WHERE json_valid(metadata);
    `);
  }
};
