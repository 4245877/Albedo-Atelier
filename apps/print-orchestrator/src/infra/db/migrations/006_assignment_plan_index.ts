import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * Indexes `assignments.plan_id`.
 *
 * The scheduler reads "every assignment in this plan" on every plan view, confirm
 * revalidation, supersede, and free-time projection. Until now that had no index,
 * so the service fell back to scanning *all* tasks and filtering their assignments
 * by plan — an O(tasks × assignments) sweep that degrades as history accumulates
 * (tasks are never deleted). `assignments.plan_id` already carries a foreign key to
 * `plans(id)` (001), but a foreign key is not an index; this adds the covering
 * index so {@link AssignmentRepository.listByPlan} is a single indexed lookup.
 *
 * Purely additive — no data change, safe to run on a populated database.
 */
export const migration006: Migration = {
  version: 6,
  name: "006_assignment_plan_index",
  up(db: DatabaseSync): void {
    db.exec("CREATE INDEX idx_assignments_plan ON assignments (plan_id);");
  }
};
