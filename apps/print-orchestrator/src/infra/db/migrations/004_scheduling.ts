import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./index";

/**
 * Adds the manual-scheduler fields to the existing print-queue model. Purely
 * additive (001–003 are left untouched): new nullable/defaulted columns on
 * `print_tasks` and `plans` so a deployed database migrates forward without a
 * rewrite, and every pre-existing row gets a sane default.
 *
 * `print_tasks` gains the operator scheduling intent the manual planner reads:
 *   - `not_before` / `deadline` — ISO windows the heuristic honours;
 *   - `day_night_preference` — 'any' | 'day' | 'night' (planning/theme hint,
 *     never an auto-start authorisation);
 *   - `pinned_printer_id` — a hard binding to one printer (empty = unpinned);
 *   - `unattended_allowed` — the explicit permission a night (bed-not-cleared)
 *     recommendation requires.
 *   (`priority` and `night` already exist from 001.)
 *
 * `plans` becomes a *revisioned, manually-confirmed* aggregate: a recompute
 * never edits a confirmed plan — it supersedes it with a fresh DRAFT whose
 * `revision` is one higher and whose `base_plan_id` points back. `confirmed_at`/
 * `confirmed_by` record the deliberate operator gate (DRAFT → ACTIVE).
 *
 * Assignment explanations (why a printer was chosen, the alternatives, the score
 * breakdown, warnings) ride in the existing `assignments.metadata` JSON — no new
 * column — under a stable `explanation` key the planner writes and the API reads.
 */
export const migration004: Migration = {
  version: 4,
  name: "004_scheduling",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE print_tasks ADD COLUMN not_before TEXT;
      ALTER TABLE print_tasks ADD COLUMN deadline TEXT;
      ALTER TABLE print_tasks ADD COLUMN day_night_preference TEXT NOT NULL DEFAULT 'any'
        CHECK (day_night_preference IN ('any','day','night'));
      ALTER TABLE print_tasks ADD COLUMN pinned_printer_id TEXT;
      ALTER TABLE print_tasks ADD COLUMN unattended_allowed INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE plans ADD COLUMN base_plan_id TEXT;
      ALTER TABLE plans ADD COLUMN confirmed_at TEXT;
      ALTER TABLE plans ADD COLUMN confirmed_by TEXT;

      CREATE INDEX idx_print_tasks_pinned ON print_tasks (pinned_printer_id);
      CREATE INDEX idx_plans_base ON plans (base_plan_id);
    `);
  }
};
