import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * Reconciles the two columns that describe **when** a task may run.
 *
 * `print_tasks` carries both `night` (INTEGER, since 001) and
 * `day_night_preference` (TEXT, since 004). They were written independently for
 * the whole life of the schema — `POST /api/print/tasks` set both, the
 * scheduling PATCH set whichever field the caller happened to send, and the
 * legacy JSON import set `night` while hard-coding the preference to `'any'` —
 * and the dispatch gate read only `night`. The enum was therefore write-only,
 * which is exactly the bug the application layer has since fixed by making the
 * enum the single source of truth and `night` its projection
 * ({@link file://../../../app/printQueue/taskCommands.ts timePreference}).
 *
 * That fix is correct going forward and silently wrong for rows already on
 * disk: a task saved with `night = 1, day_night_preference = 'any'` was
 * night-startable before the change and is refused after it
 * (`NOT_NIGHT_FLAGGED`), while `buildNightPlan` and the night-start guard —
 * which read the boolean through the queue projection — still offer it. A job
 * the planner picks and the dispatch refuses is the contradiction this closes.
 *
 * Both directions converge on `night`, and neither invents permission:
 *
 *  - `night = 1` → `day_night_preference = 'night'` restores exactly the
 *    behaviour those rows had before the reader changed;
 *  - `day_night_preference = 'night'` → `night = 1` completes the intended fix
 *    for an operator who set the preference through the scheduler API and got a
 *    task the night gate refused.
 *
 * It does not make anything unattended: `unattended_allowed` is a separate
 * permission and a night dispatch still refuses without it. Rows where the two
 * already agree are untouched.
 */
export const migration016: Migration = {
  version: 16,
  name: "016_day_night_reconcile",
  up(db: DatabaseSync): void {
    db.exec(`
      UPDATE print_tasks
         SET day_night_preference = 'night'
       WHERE night = 1
         AND day_night_preference <> 'night';

      UPDATE print_tasks
         SET night = 1
       WHERE day_night_preference = 'night'
         AND night <> 1;
    `);
  }
};
