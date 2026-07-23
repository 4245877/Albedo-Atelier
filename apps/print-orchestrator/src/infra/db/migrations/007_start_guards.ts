import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * `start_guards` — the durable idempotency ledger for physical start-of-print.
 *
 * At most one row per printer (the primary key), recording an in-flight or
 * not-yet-reconciled start intent. It is written **before** the start command
 * leaves the orchestrator and only cleared once the outcome is reconciled with
 * the real device state, so a lost Moonraker response, a retry or a process
 * restart can never turn one operator/queue command into two physical prints.
 *
 * Deliberately outside the versioned `PrintTask → Assignment → DispatchAttempt`
 * chain: it is a tiny operational side-table (like `app_meta`), not part of the
 * task history, and its writes must be synchronous and fail-loud.
 */
export const migration007: Migration = {
  version: 7,
  name: "007_start_guards",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE start_guards (
        printer_id   TEXT PRIMARY KEY,
        file         TEXT NOT NULL,
        state        TEXT NOT NULL,
        job_ref      TEXT,
        requested_at TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
    `);
  }
};
