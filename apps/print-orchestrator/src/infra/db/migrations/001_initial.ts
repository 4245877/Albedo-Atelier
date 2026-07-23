import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * Initial schema for the persistent print-queue model.
 *
 * Design notes worth knowing when reading the DDL:
 *   - Timestamps are ISO-8601 TEXT (UTC); booleans are 0/1 INTEGER; `metadata`
 *     / `detail` / audit payloads are JSON TEXT defaulting to `'{}'`.
 *   - Every mutable table carries `version INTEGER NOT NULL` for optimistic
 *     concurrency (see the repository ports).
 *   - `state` columns carry CHECK constraints listing the legal values — a
 *     cheap belt-and-braces alongside the domain transition rules, so a bug that
 *     tries to persist an unknown state fails at the door instead of corrupting
 *     the machine.
 *   - `legacy_ref` gets a *partial* unique index (only when non-null), so the
 *     one-time JSON import can never insert the same old id twice, while native
 *     rows (null ref) are unconstrained.
 *   - `bed_cycles.assignment_id` and `print_runs.bed_cycle_id` / assignment's
 *     `bed_cycle_id` form a cycle (assignment ↔ bed cycle). SQLite requires a
 *     REFERENCES target to already exist at CREATE time, so the cycle is broken
 *     by making `bed_cycles.assignment_id` a plain indexed column (soft link the
 *     service keeps consistent) while the assignment→bed_cycle direction is a
 *     real FK. Table creation order below respects every remaining FK.
 */
export const migration001: Migration = {
  version: 1,
  name: "001_initial",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE artifacts (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('gcode','model','unknown')),
        name        TEXT NOT NULL,
        source      TEXT,
        size_bytes  INTEGER,
        sha256      TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        version     INTEGER NOT NULL,
        legacy_ref  TEXT,
        metadata    TEXT NOT NULL DEFAULT '{}'
      );
      CREATE UNIQUE INDEX idx_artifacts_legacy_ref
        ON artifacts (legacy_ref) WHERE legacy_ref IS NOT NULL;

      CREATE TABLE artifact_analyses (
        id                   TEXT PRIMARY KEY,
        artifact_id          TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        state                TEXT NOT NULL CHECK (state IN ('pending','ready','failed')),
        analyzer             TEXT,
        estimated_duration_s INTEGER,
        estimated_filament_g REAL,
        material             TEXT,
        nozzle_diameter_mm   REAL,
        layer_height_mm      REAL,
        error                TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        version              INTEGER NOT NULL,
        metadata             TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_artifact_analyses_artifact ON artifact_analyses (artifact_id);

      CREATE TABLE print_tasks (
        id             TEXT PRIMARY KEY,
        artifact_id    TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        title          TEXT NOT NULL,
        material       TEXT,
        target_printer TEXT,
        priority       INTEGER NOT NULL DEFAULT 0,
        state          TEXT NOT NULL CHECK (state IN
                         ('DRAFT','QUEUED','PLANNED','ASSIGNED','DISPATCHING',
                          'PRINTING','COMPLETED','FAILED','CANCELLED','NEEDS_REVIEW')),
        reason         TEXT,
        night          INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        version        INTEGER NOT NULL,
        legacy_ref     TEXT,
        metadata       TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_print_tasks_state ON print_tasks (state);
      CREATE UNIQUE INDEX idx_print_tasks_legacy_ref
        ON print_tasks (legacy_ref) WHERE legacy_ref IS NOT NULL;

      CREATE TABLE queue_entries (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL UNIQUE REFERENCES print_tasks(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        state       TEXT NOT NULL CHECK (state IN ('WAITING','HELD','RELEASED')),
        enqueued_at TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        version     INTEGER NOT NULL
      );
      CREATE INDEX idx_queue_entries_open ON queue_entries (state, position);

      CREATE TABLE plans (
        id         TEXT PRIMARY KEY,
        name       TEXT,
        window     TEXT,
        state      TEXT NOT NULL CHECK (state IN ('DRAFT','ACTIVE','COMPLETED','CANCELLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version    INTEGER NOT NULL,
        metadata   TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE bed_cycles (
        id            TEXT PRIMARY KEY,
        printer_id    TEXT NOT NULL,
        state         TEXT NOT NULL CHECK (state IN
                        ('CLEAR','RESERVED','RUNNING','AWAITING_CLEARANCE','UNKNOWN')),
        assignment_id TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        cleared_at    TEXT,
        version       INTEGER NOT NULL,
        metadata      TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_bed_cycles_printer ON bed_cycles (printer_id, state);

      CREATE TABLE assignments (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL REFERENCES print_tasks(id) ON DELETE CASCADE,
        printer_id    TEXT NOT NULL,
        plan_id       TEXT REFERENCES plans(id) ON DELETE SET NULL,
        bed_cycle_id  TEXT REFERENCES bed_cycles(id) ON DELETE SET NULL,
        state         TEXT NOT NULL CHECK (state IN
                        ('PROPOSED','RESERVED','ACTIVE','RELEASED','CANCELLED')),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        version       INTEGER NOT NULL,
        legacy_ref    TEXT,
        metadata      TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_assignments_task ON assignments (task_id);
      CREATE INDEX idx_assignments_printer ON assignments (printer_id, state);

      CREATE TABLE dispatch_attempts (
        id            TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        task_id       TEXT NOT NULL REFERENCES print_tasks(id) ON DELETE CASCADE,
        printer_id    TEXT NOT NULL,
        attempt_no    INTEGER NOT NULL,
        state         TEXT NOT NULL CHECK (state IN ('PENDING','SENT','ACKED','FAILED')),
        error         TEXT,
        requested_at  TEXT NOT NULL,
        completed_at  TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        version       INTEGER NOT NULL,
        metadata      TEXT NOT NULL DEFAULT '{}',
        UNIQUE (assignment_id, attempt_no)
      );
      CREATE INDEX idx_dispatch_attempts_assignment ON dispatch_attempts (assignment_id);

      CREATE TABLE print_runs (
        id                  TEXT PRIMARY KEY,
        task_id             TEXT NOT NULL REFERENCES print_tasks(id) ON DELETE CASCADE,
        assignment_id       TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        dispatch_attempt_id TEXT REFERENCES dispatch_attempts(id) ON DELETE SET NULL,
        printer_id          TEXT NOT NULL,
        bed_cycle_id        TEXT,
        state               TEXT NOT NULL CHECK (state IN
                              ('RUNNING','PAUSED','SUCCEEDED','FAILED','CANCELLED','UNKNOWN')),
        started_at          TEXT,
        ended_at            TEXT,
        progress            REAL,
        filament_used_g     REAL,
        duration_s          INTEGER,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        version             INTEGER NOT NULL,
        legacy_ref          TEXT,
        metadata            TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_print_runs_task ON print_runs (task_id);
      CREATE UNIQUE INDEX idx_print_runs_legacy_ref
        ON print_runs (legacy_ref) WHERE legacy_ref IS NOT NULL;

      CREATE TABLE audit_events (
        id          TEXT PRIMARY KEY,
        at          TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        action      TEXT NOT NULL,
        from_state  TEXT,
        to_state    TEXT,
        actor       TEXT,
        detail      TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_audit_events_entity ON audit_events (entity_type, entity_id);
      CREATE INDEX idx_audit_events_at ON audit_events (at);

      CREATE TABLE app_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }
};
