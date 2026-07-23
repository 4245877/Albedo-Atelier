import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * Canonical-dispatch hardening: the schema changes that let SQLite become the
 * single source of truth for physical print starts.
 *
 * 1. `print_runs` is rebuilt (SQLite cannot edit a CHECK in place) to:
 *    - allow the new `PENDING` state — a run *reserved inside the dispatch
 *      transaction before the physical command is sent*, so «нет транзакции —
 *      нет команды» is expressible in data;
 *    - carry the dispatch identity: the on-device `file` the start was for,
 *      the `artifact_id`/`artifact_sha256` the decision was based on, and an
 *      `idempotency_key` (a repeat of the same key returns the same run
 *      instead of minting a second physical start).
 * 2. Partial unique indexes make the safety invariants *engine-enforced*, not
 *    just service-checked:
 *    - at most one active (PENDING/RUNNING/PAUSED/UNKNOWN) run per task;
 *    - at most one active run per printer;
 *    - at most one live (RESERVED/ACTIVE) assignment per task;
 *    - at most one live assignment per printer.
 *    (`PROPOSED` is deliberately excluded: draft plans may propose the same
 *    printer across revisions — proposals hold no hardware.)
 * 3. `start_guards` gains `run_id`, linking the durable start guard to the
 *    canonical run it protects.
 *
 * Fail-closed: if existing data already violates an invariant (two active runs
 * on one printer, …), the pre-flight check below aborts the migration with an
 * operator-actionable message and the transaction rolls the rebuild back. The
 * operator must resolve the conflicting rows explicitly; the migration never
 * guesses which of two conflicting dispatches was real.
 */

const ACTIVE_RUN_STATES = "('PENDING','RUNNING','PAUSED','UNKNOWN')";
const LIVE_ASSIGNMENT_STATES = "('RESERVED','ACTIVE')";

function assertNoDuplicates(
  db: DatabaseSync,
  label: string,
  sql: string
): void {
  const rows = db.prepare(sql).all() as { key: string; n: number }[];
  if (rows.length > 0) {
    const detail = rows.map((r) => `${r.key} (${r.n})`).join(", ");
    throw new Error(
      `Миграция 008 остановлена (fail-closed): найдены конфликтующие данные — ${label}: ${detail}. ` +
        `Разрешите конфликт вручную (переведите лишние записи в терминальное состояние) и повторите запуск.`
    );
  }
}

export const migration008: Migration = {
  version: 8,
  name: "008_canonical_dispatch",
  up(db: DatabaseSync): void {
    // ── Fail-closed pre-flight: existing data must already satisfy the invariants.
    assertNoDuplicates(
      db,
      "несколько активных печатей на одном принтере",
      `SELECT printer_id AS key, COUNT(*) AS n FROM print_runs
        WHERE state IN ${ACTIVE_RUN_STATES} GROUP BY printer_id HAVING n > 1`
    );
    assertNoDuplicates(
      db,
      "несколько активных печатей одного задания",
      `SELECT task_id AS key, COUNT(*) AS n FROM print_runs
        WHERE state IN ${ACTIVE_RUN_STATES} GROUP BY task_id HAVING n > 1`
    );
    assertNoDuplicates(
      db,
      "несколько живых назначений одного задания",
      `SELECT task_id AS key, COUNT(*) AS n FROM assignments
        WHERE state IN ${LIVE_ASSIGNMENT_STATES} GROUP BY task_id HAVING n > 1`
    );
    assertNoDuplicates(
      db,
      "несколько живых назначений на одном принтере",
      `SELECT printer_id AS key, COUNT(*) AS n FROM assignments
        WHERE state IN ${LIVE_ASSIGNMENT_STATES} GROUP BY printer_id HAVING n > 1`
    );

    db.exec(`
      CREATE TABLE print_runs_new (
        id                  TEXT PRIMARY KEY,
        task_id             TEXT NOT NULL REFERENCES print_tasks(id) ON DELETE CASCADE,
        assignment_id       TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        dispatch_attempt_id TEXT REFERENCES dispatch_attempts(id) ON DELETE SET NULL,
        printer_id          TEXT NOT NULL,
        bed_cycle_id        TEXT,
        state               TEXT NOT NULL CHECK (state IN
                              ('PENDING','RUNNING','PAUSED','SUCCEEDED','FAILED','CANCELLED','UNKNOWN')),
        file                TEXT,
        artifact_id         TEXT,
        artifact_sha256     TEXT,
        idempotency_key     TEXT,
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

      INSERT INTO print_runs_new
        (id, task_id, assignment_id, dispatch_attempt_id, printer_id, bed_cycle_id,
         state, started_at, ended_at, progress, filament_used_g, duration_s,
         created_at, updated_at, version, legacy_ref, metadata)
      SELECT
         id, task_id, assignment_id, dispatch_attempt_id, printer_id, bed_cycle_id,
         state, started_at, ended_at, progress, filament_used_g, duration_s,
         created_at, updated_at, version, legacy_ref, metadata
      FROM print_runs;

      DROP TABLE print_runs;
      ALTER TABLE print_runs_new RENAME TO print_runs;

      CREATE INDEX idx_print_runs_task ON print_runs (task_id);
      CREATE UNIQUE INDEX idx_print_runs_legacy_ref
        ON print_runs (legacy_ref) WHERE legacy_ref IS NOT NULL;
      CREATE INDEX idx_print_runs_printer ON print_runs (printer_id, state);

      CREATE UNIQUE INDEX uq_print_runs_active_task
        ON print_runs (task_id) WHERE state IN ${ACTIVE_RUN_STATES};
      CREATE UNIQUE INDEX uq_print_runs_active_printer
        ON print_runs (printer_id) WHERE state IN ${ACTIVE_RUN_STATES};
      CREATE UNIQUE INDEX uq_print_runs_idempotency
        ON print_runs (idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE UNIQUE INDEX uq_assignments_live_task
        ON assignments (task_id) WHERE state IN ${LIVE_ASSIGNMENT_STATES};
      CREATE UNIQUE INDEX uq_assignments_live_printer
        ON assignments (printer_id) WHERE state IN ${LIVE_ASSIGNMENT_STATES};

      ALTER TABLE start_guards ADD COLUMN run_id TEXT;
    `);
  }
};
