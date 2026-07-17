import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./index";

/**
 * Grows {@link file://../001_initial.ts artifact_analyses} for real file
 * analysis (STL / 3MF / G-code upload). Two things change and both need a table
 * rebuild rather than plain `ALTER TABLE ADD COLUMN`:
 *
 *   1. The technical-state CHECK gains `running` — a worker now marks a row
 *      `running` while it analyses, and 001's CHECK only allowed
 *      `pending`/`ready`/`failed`. SQLite cannot alter a CHECK in place.
 *   2. New typed columns separate the *result* (`verdict`, `detected_format`,
 *      structured `warnings`/`blockers`, analyzer `data`, `analyzer_version`)
 *      from the technical state — the split the brief insists on.
 *
 * The rebuild is the standard SQLite 12-step table redefinition, safe here
 * because nothing references `artifact_analyses` by foreign key (it is the child
 * of `artifacts`, never a parent). Existing rows are carried over verbatim; the
 * new columns take their defaults (empty findings, null verdict/format) so a row
 * imported before this migration simply reads as "not yet analysed in the new
 * shape" and can be re-analysed.
 *
 * 001 is left exactly as shipped — a deployed database has already recorded it
 * as applied, so this is a new, additive migration, per the brief.
 */
export const migration002: Migration = {
  version: 2,
  name: "002_artifact_analysis",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE artifact_analyses_new (
        id                   TEXT PRIMARY KEY,
        artifact_id          TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        state                TEXT NOT NULL CHECK (state IN ('pending','running','ready','failed')),
        verdict              TEXT CHECK (verdict IS NULL OR verdict IN
                               ('needs_preparation','schedulable','needs_input','review','blocked')),
        detected_format      TEXT CHECK (detected_format IS NULL OR detected_format IN
                               ('stl','3mf','gcode','unknown')),
        analyzer             TEXT,
        analyzer_version     TEXT,
        estimated_duration_s INTEGER,
        estimated_filament_g REAL,
        material             TEXT,
        nozzle_diameter_mm   REAL,
        layer_height_mm      REAL,
        warnings             TEXT NOT NULL DEFAULT '[]',
        blockers             TEXT NOT NULL DEFAULT '[]',
        data                 TEXT NOT NULL DEFAULT '{}',
        error                TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        version              INTEGER NOT NULL,
        metadata             TEXT NOT NULL DEFAULT '{}'
      );

      INSERT INTO artifact_analyses_new
        (id, artifact_id, state, analyzer, estimated_duration_s, estimated_filament_g,
         material, nozzle_diameter_mm, layer_height_mm, error,
         created_at, updated_at, version, metadata)
      SELECT
         id, artifact_id, state, analyzer, estimated_duration_s, estimated_filament_g,
         material, nozzle_diameter_mm, layer_height_mm, error,
         created_at, updated_at, version, metadata
      FROM artifact_analyses;

      DROP TABLE artifact_analyses;
      ALTER TABLE artifact_analyses_new RENAME TO artifact_analyses;

      CREATE INDEX idx_artifact_analyses_artifact ON artifact_analyses (artifact_id);
      CREATE INDEX idx_artifact_analyses_state ON artifact_analyses (state);
    `);
  }
};
