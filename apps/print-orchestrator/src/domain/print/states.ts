import { StateTransitionError } from "../../core/errors";
import type {
  ArtifactAnalysisState,
  AssignmentState,
  BedCycleState,
  DispatchAttemptState,
  PlanState,
  PrintRunState,
  PrintTaskState,
  QueueEntryState
} from "./types";

/**
 * The state machines for every stateful entity in the print-queue model.
 *
 * Each machine is a plain `from → allowed[]` adjacency map. Keeping the rules as
 * data (not scattered `if`s) means the whole lifecycle is auditable in one
 * place, terminal states are simply the ones with no outgoing edges, and the
 * single {@link assertTransition} guard is the only thing every repository/
 * service update has to call. The maps are the source of truth the brief asks
 * for: "все переходы состояний должны проверяться доменными правилами".
 */

/** A transition table: each state maps to the states it may move to. */
export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

/**
 * PrintTask lifecycle. A launched task is never destroyed — the terminal
 * `COMPLETED`/`FAILED`/`CANCELLED` states have no outgoing edges and the row
 * stays as history. `NEEDS_REVIEW` is the parking state for a task that cannot
 * proceed (no printer, bad file, material clash) without blocking the queue.
 */
export const PRINT_TASK_TRANSITIONS: TransitionMap<PrintTaskState> = {
  DRAFT: ["QUEUED", "NEEDS_REVIEW", "CANCELLED"],
  QUEUED: ["PLANNED", "ASSIGNED", "NEEDS_REVIEW", "CANCELLED"],
  PLANNED: ["ASSIGNED", "QUEUED", "NEEDS_REVIEW", "CANCELLED"],
  ASSIGNED: ["DISPATCHING", "QUEUED", "NEEDS_REVIEW", "CANCELLED"],
  DISPATCHING: ["PRINTING", "ASSIGNED", "FAILED", "NEEDS_REVIEW", "CANCELLED"],
  PRINTING: ["COMPLETED", "FAILED", "CANCELLED"],
  NEEDS_REVIEW: ["QUEUED", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["QUEUED"], // a failed task may be retried by re-queuing it
  CANCELLED: []
};

/** QueueEntry lifecycle: waiting ⇄ held, then released (task leaves the queue). */
export const QUEUE_ENTRY_TRANSITIONS: TransitionMap<QueueEntryState> = {
  WAITING: ["HELD", "RELEASED"],
  HELD: ["WAITING", "RELEASED"],
  RELEASED: []
};

/** Plan lifecycle. */
export const PLAN_TRANSITIONS: TransitionMap<PlanState> = {
  DRAFT: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: []
};

/** Assignment lifecycle — the binding of a task to a printer/bed. */
export const ASSIGNMENT_TRANSITIONS: TransitionMap<AssignmentState> = {
  PROPOSED: ["RESERVED", "ACTIVE", "RELEASED", "CANCELLED"],
  RESERVED: ["ACTIVE", "RELEASED", "CANCELLED"],
  ACTIVE: ["RELEASED", "CANCELLED"],
  RELEASED: [],
  CANCELLED: []
};

/**
 * BedCycle lifecycle, per the brief:
 *   CLEAR → RESERVED → RUNNING → AWAITING_CLEARANCE → CLEAR
 * with UNKNOWN reachable from any live state (state lost) and recoverable back
 * to CLEAR or RESERVED once the operator confirms the real bed state.
 */
export const BED_CYCLE_TRANSITIONS: TransitionMap<BedCycleState> = {
  CLEAR: ["RESERVED", "UNKNOWN"],
  RESERVED: ["RUNNING", "CLEAR", "UNKNOWN"],
  RUNNING: ["AWAITING_CLEARANCE", "UNKNOWN"],
  AWAITING_CLEARANCE: ["CLEAR", "UNKNOWN"],
  UNKNOWN: ["CLEAR", "RESERVED"]
};

/** DispatchAttempt lifecycle — one launch attempt. */
export const DISPATCH_ATTEMPT_TRANSITIONS: TransitionMap<DispatchAttemptState> = {
  PENDING: ["SENT", "FAILED"],
  SENT: ["ACKED", "FAILED"],
  ACKED: [],
  FAILED: []
};

/** PrintRun lifecycle — the observed physical print. */
export const PRINT_RUN_TRANSITIONS: TransitionMap<PrintRunState> = {
  RUNNING: ["PAUSED", "SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"],
  PAUSED: ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"],
  UNKNOWN: ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: []
};

/** ArtifactAnalysis lifecycle — may re-run from a terminal state. */
export const ARTIFACT_ANALYSIS_TRANSITIONS: TransitionMap<ArtifactAnalysisState> = {
  pending: ["ready", "failed"],
  ready: ["pending"],
  failed: ["pending"]
};

/** True when a state has no outgoing transitions (a launched task stays put). */
export function isTerminal<S extends string>(map: TransitionMap<S>, state: S): boolean {
  return map[state].length === 0;
}

/** Whether `from → to` is a legal move (a no-op `from === to` is always legal). */
export function canTransition<S extends string>(
  map: TransitionMap<S>,
  from: S,
  to: S
): boolean {
  if (from === to) return true;
  return map[from].includes(to);
}

/**
 * Asserts a transition is legal, throwing {@link StateTransitionError} (a 409)
 * otherwise. The single choke point every state change goes through — the
 * `entity` label is used only for the error message. A self-transition
 * (`from === to`) is allowed so idempotent "set to X" calls never throw.
 */
export function assertTransition<S extends string>(
  entity: string,
  map: TransitionMap<S>,
  from: S,
  to: S
): void {
  if (!canTransition(map, from, to)) {
    throw new StateTransitionError(entity, from, to);
  }
}
