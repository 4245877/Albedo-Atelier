import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * Splits the device-file failure states so a retry can be decided from the row
 * instead of from prose in `last_error`.
 *
 * `device_artifacts` (migration 009) had one failure state, `INVALID`, doing
 * three unrelated jobs: "the transfer died", "the bytes on the device are not
 * the artifact's", and "this record describes a job we would no longer print".
 * Collapsed like that, a re-prepare could not tell a network failure (re-upload
 * is right) from a superseded slice (re-upload is wrong until the binding is
 * refreshed) — and nothing ever *marked* a superseded record at all, so a
 * `VERIFIED` row could authorise a start of yesterday's file.
 *
 * After this migration:
 *   - `FAILED` — the upload itself did not complete;
 *   - `INVALID` — the file is absent/mismatched on the device;
 *   - `STALE`  — slice variant, artifact hash, printer, path, size, profile set
 *     or assignment changed under a previously verified record.
 *
 * SQLite cannot edit a CHECK constraint in place, so the table is rebuilt.
 * Existing rows keep their state verbatim (`INVALID` stays `INVALID`): this
 * migration reclassifies nothing retroactively — it only makes the finer states
 * expressible going forward. Additive and lossless.
 */
export const migration010: Migration = {
  version: 10,
  name: "010_device_artifact_states",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE device_artifacts_new (
        id               TEXT PRIMARY KEY,
        printer_id       TEXT NOT NULL,
        assignment_id    TEXT,
        slice_variant_id TEXT,
        artifact_id      TEXT,
        artifact_sha256  TEXT,
        remote_path      TEXT NOT NULL,
        size_bytes       INTEGER,
        state            TEXT NOT NULL CHECK (state IN
                           ('NOT_PRESENT','UPLOADING','PRESENT_UNVERIFIED','VERIFIED',
                            'INVALID','FAILED','STALE')),
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

      INSERT INTO device_artifacts_new
        (id, printer_id, assignment_id, slice_variant_id, artifact_id, artifact_sha256,
         remote_path, size_bytes, state, transfer_mode, verification, uploaded_at,
         verified_at, confirmed_by, last_error, created_at, updated_at, version, metadata)
        SELECT
         id, printer_id, assignment_id, slice_variant_id, artifact_id, artifact_sha256,
         remote_path, size_bytes, state, transfer_mode, verification, uploaded_at,
         verified_at, confirmed_by, last_error, created_at, updated_at, version, metadata
        FROM device_artifacts;

      DROP TABLE device_artifacts;
      ALTER TABLE device_artifacts_new RENAME TO device_artifacts;

      CREATE UNIQUE INDEX uq_device_artifacts_slot
        ON device_artifacts (printer_id, remote_path);
      CREATE INDEX idx_device_artifacts_variant
        ON device_artifacts (slice_variant_id);
      CREATE INDEX idx_device_artifacts_assignment
        ON device_artifacts (assignment_id);
      CREATE INDEX idx_device_artifacts_state
        ON device_artifacts (state);
    `);
  }
};
