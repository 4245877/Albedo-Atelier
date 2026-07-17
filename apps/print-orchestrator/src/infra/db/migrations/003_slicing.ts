import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./index";

/**
 * Adds the slicing domain (`domain/slicing`): immutable profile revisions, vetted
 * profile sets, and slice jobs. Purely additive — 001 and 002 are left exactly as
 * shipped (a deployed database has recorded them as applied), and nothing here
 * touches the existing tables, so this is a clean forward migration per the brief.
 *
 * Design notes, consistent with 001:
 *   - timestamps are ISO-8601 TEXT; `warnings`/`blockers` are JSON TEXT `'[]'`;
 *     `metadata`/`dimensions` are JSON TEXT; every mutable table carries `version`.
 *   - `profile_revisions.raw_sha256` is UNIQUE: a revision is its raw content, so
 *     re-importing identical bytes is a no-op and an edited profile is a new row.
 *     `status`/`resolved_*`/`warnings`/`blockers` are *derived* and re-evaluated on
 *     every import (adding a vendor parent can un-quarantine a revision), so they
 *     stay mutable while the raw content never changes.
 *   - profile sets pin the three revisions by FK with ON DELETE RESTRICT (revisions
 *     are immutable and never deleted, but this makes the intent explicit); a slice
 *     variant's source/output artifacts and output analysis are FKs into the
 *     existing tables so the whole chain is enforced by the engine.
 */
export const migration003: Migration = {
  version: 3,
  name: "003_slicing",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE profile_revisions (
        id               TEXT PRIMARY KEY,
        logical_id       TEXT NOT NULL,
        type             TEXT NOT NULL CHECK (type IN ('machine','process','filament')),
        name             TEXT NOT NULL,
        inherits         TEXT,
        status           TEXT NOT NULL CHECK (status IN ('active','quarantined','invalid')),
        raw_json         TEXT NOT NULL,
        raw_sha256       TEXT NOT NULL,
        resolved_json    TEXT,
        resolved_sha256  TEXT,
        orca_version     TEXT,
        source           TEXT,
        warnings         TEXT NOT NULL DEFAULT '[]',
        blockers         TEXT NOT NULL DEFAULT '[]',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        version          INTEGER NOT NULL,
        metadata         TEXT NOT NULL DEFAULT '{}'
      );
      CREATE UNIQUE INDEX idx_profile_revisions_raw_sha ON profile_revisions (raw_sha256);
      CREATE INDEX idx_profile_revisions_logical ON profile_revisions (logical_id);
      CREATE INDEX idx_profile_revisions_type ON profile_revisions (type, status);

      CREATE TABLE profile_sets (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        machine_revision_id  TEXT NOT NULL REFERENCES profile_revisions(id) ON DELETE RESTRICT,
        process_revision_id  TEXT NOT NULL REFERENCES profile_revisions(id) ON DELETE RESTRICT,
        filament_revision_id TEXT NOT NULL REFERENCES profile_revisions(id) ON DELETE RESTRICT,
        printer_id           TEXT,
        printer_class        TEXT,
        validation           TEXT NOT NULL CHECK (validation IN ('valid','warnings','blocked')),
        approved             INTEGER NOT NULL DEFAULT 0,
        approved_by          TEXT,
        approved_at          TEXT,
        warnings             TEXT NOT NULL DEFAULT '[]',
        blockers             TEXT NOT NULL DEFAULT '[]',
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        version              INTEGER NOT NULL,
        metadata             TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_profile_sets_printer ON profile_sets (printer_id);

      CREATE TABLE slice_variants (
        id                   TEXT PRIMARY KEY,
        task_id              TEXT NOT NULL REFERENCES print_tasks(id) ON DELETE CASCADE,
        source_artifact_id   TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        profile_set_id       TEXT NOT NULL REFERENCES profile_sets(id) ON DELETE RESTRICT,
        target_printer_id    TEXT,
        target_printer_class TEXT,
        state                TEXT NOT NULL CHECK (state IN
                               ('pending','running','ready','failed','blocked')),
        cache_key            TEXT NOT NULL,
        orca_version         TEXT,
        worker_version       TEXT,
        output_artifact_id   TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        output_analysis_id   TEXT REFERENCES artifact_analyses(id) ON DELETE SET NULL,
        orca_eta_s           INTEGER,
        filament_g           REAL,
        filament_mm          REAL,
        dimensions           TEXT,
        warnings             TEXT NOT NULL DEFAULT '[]',
        blockers             TEXT NOT NULL DEFAULT '[]',
        error                TEXT,
        started_at           TEXT,
        ended_at             TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        version              INTEGER NOT NULL,
        metadata             TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_slice_variants_task ON slice_variants (task_id);
      CREATE INDEX idx_slice_variants_cache ON slice_variants (cache_key, state);
      CREATE INDEX idx_slice_variants_state ON slice_variants (state);
    `);
  }
};
