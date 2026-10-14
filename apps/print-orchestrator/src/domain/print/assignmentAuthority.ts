import type { Assignment, PlanState } from "./types";

/**
 * **What an assignment is allowed to claim.**
 *
 * One table of assignments holds three different kinds of thing, and they were
 * treated alike wherever "is this printer / this task already taken?" was asked:
 *
 *  - a **recommendation** — a `PROPOSED` placement on a *draft* plan. Nobody has
 *    agreed to it; it is the planner thinking out loud;
 *  - a **decision** — a `PROPOSED` placement an operator made by hand, or one
 *    under the confirmed (`ACTIVE`) plan. Something the farm has committed to;
 *  - a **physical hold** — `RESERVED` (a start command in flight) or `ACTIVE`
 *    (a print on the machine).
 *
 * Every live state used to block alike, so a draft plan's suggestion made a
 * printer «занят назначением» for a manual start, and a manual launch reused the
 * draft's proposal and then failed its own dispatch with «подтвердите план»
 * (HIGH-12). An invalidated placement — withdrawn by a queue edit, a re-slice or
 * an operator — kept its `PROPOSED` state and went on holding the printer and
 * the task just the same (HIGH-13).
 *
 * The rule here is the one every such question asks:
 *
 *  - a physical hold always counts, invalidated or not — the machine does not
 *    know about the ledger;
 *  - a decision counts while it is not invalidated;
 *  - a recommendation never holds anything.
 */
export function assignmentHolds(
  assignment: Pick<Assignment, "state" | "planId" | "source" | "invalidatedAt">,
  planState: PlanState | null
): boolean {
  if (assignment.state === "RESERVED" || assignment.state === "ACTIVE") return true;
  if (assignment.state !== "PROPOSED") return false;
  if (assignment.invalidatedAt !== null) return false;
  if (assignment.planId !== null) return planState === "ACTIVE";
  return assignment.source === "manual";
}

/** A `PROPOSED` placement on a plan nobody confirmed — advice, not a claim. */
export function isRecommendation(
  assignment: Pick<Assignment, "state" | "planId">,
  planState: PlanState | null
): boolean {
  return assignment.state === "PROPOSED" && assignment.planId !== null && planState !== "ACTIVE";
}
