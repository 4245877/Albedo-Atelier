import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * The operator schedule and the typed manual operations — the human half of the
 * print model (see `domain/operations/types.ts`).
 *
 * Five additive tables, no changes to existing ones:
 *
 *  - `operators`                    — who can do the work, and in which IANA zone
 *    their wall-clock schedule is expressed. Nullable `time_zone` because an
 *    unknown zone must stay *unknown* (fail-closed) rather than default to the
 *    container's `TZ`.
 *  - `operator_schedule_rules`      — recurring weekly windows, split into an
 *    `available` and a `sleep` track. Stored as **local minutes since midnight**,
 *    never instants, so the schedule survives DST unchanged.
 *  - `operator_schedule_exceptions` — one-date overrides that *replace* the
 *    weekly rules for that local date (including a whole-day `off`).
 *  - `operator_absences`            — instant ranges (UTC) the operator is away.
 *  - `manual_operations`            — one typed physical intervention with its
 *    lifecycle, duration, allowed window, confirming actor and completion time.
 *
 * A single default operator is seeded (`FARM_TIMEZONE` is deliberately **not**
 * copied in — the env var is the night-window's zone, and silently reusing it as
 * a person's schedule zone would manufacture an availability answer nobody
 * asserted). The row starts with a null zone and no rules, which resolves to
 * `UNKNOWN` and therefore blocks automatic continuation until an operator fills
 * the schedule in. That is the intended initial state, not a gap.
 *
 * The partial unique index on `manual_operations` is the storage-level backstop
 * for "one operator cannot perform two operations at once": at most one row per
 * operator may be `IN_PROGRESS`.
 */
export const migration011: Migration = {
  version: 11,
  name: "011_operator_schedule",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE operators (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        time_zone  TEXT,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version    INTEGER NOT NULL DEFAULT 1,
        metadata   TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE operator_schedule_rules (
        id            TEXT PRIMARY KEY,
        operator_id   TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
        track         TEXT NOT NULL CHECK (track IN ('available','sleep')),
        weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
        start_minutes INTEGER NOT NULL CHECK (start_minutes BETWEEN 0 AND 1439),
        end_minutes   INTEGER NOT NULL CHECK (end_minutes BETWEEN 0 AND 1440),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        version       INTEGER NOT NULL DEFAULT 1,
        metadata      TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_schedule_rules_operator
        ON operator_schedule_rules (operator_id, track, weekday);

      CREATE TABLE operator_schedule_exceptions (
        id            TEXT PRIMARY KEY,
        operator_id   TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
        date          TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('available','sleep','off')),
        start_minutes INTEGER,
        end_minutes   INTEGER,
        note          TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        version       INTEGER NOT NULL DEFAULT 1,
        metadata      TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_schedule_exceptions_operator
        ON operator_schedule_exceptions (operator_id, date);

      CREATE TABLE operator_absences (
        id          TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
        starts_at   TEXT NOT NULL,
        ends_at     TEXT,
        reason      TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        version     INTEGER NOT NULL DEFAULT 1,
        metadata    TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_operator_absences_operator
        ON operator_absences (operator_id, starts_at);

      CREATE TABLE manual_operations (
        id                   TEXT PRIMARY KEY,
        type                 TEXT NOT NULL,
        state                TEXT NOT NULL,
        printer_id           TEXT NOT NULL,
        assignment_id        TEXT REFERENCES assignments(id),
        task_id              TEXT REFERENCES print_tasks(id),
        bed_cycle_id         TEXT REFERENCES bed_cycles(id),
        estimated_minutes    REAL,
        window_start         TEXT,
        window_end           TEXT,
        blocking             INTEGER NOT NULL DEFAULT 1,
        origin               TEXT NOT NULL,
        reason               TEXT,
        assigned_operator_id TEXT REFERENCES operators(id),
        confirmed_by         TEXT,
        started_at           TEXT,
        completed_at         TEXT,
        actual_minutes       REAL,
        ready_at             TEXT,
        note                 TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        version              INTEGER NOT NULL DEFAULT 1,
        metadata             TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_manual_operations_printer
        ON manual_operations (printer_id, state, created_at);
      CREATE INDEX idx_manual_operations_assignment
        ON manual_operations (assignment_id, created_at);
      CREATE INDEX idx_manual_operations_state
        ON manual_operations (state, created_at);

      -- One operator, one pair of hands: at most one IN_PROGRESS row per operator.
      CREATE UNIQUE INDEX idx_manual_operations_one_in_progress
        ON manual_operations (assigned_operator_id)
        WHERE state = 'IN_PROGRESS' AND assigned_operator_id IS NOT NULL;
    `);

    // The default operator: named, active, but with NO timezone and NO rules, so
    // availability resolves to UNKNOWN until a human fills the schedule in.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO operators (id, name, time_zone, active, created_at, updated_at, version, metadata)
       VALUES (?, ?, NULL, 1, ?, ?, 1, '{}')`
    ).run("op_default", "Оператор фермы", now, now);
  }
};
