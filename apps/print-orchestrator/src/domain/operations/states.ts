import { assertTransition, type TransitionMap } from "../print/states";
import type { ManualOperationState, ManualOperationType } from "./types";

/**
 * The {@link ManualOperation} state machine, in the same `from → allowed[]` data
 * shape every other entity in this model uses, so the single
 * {@link assertTransition} guard covers it too.
 *
 *   PENDING → READY → IN_PROGRESS → COMPLETED
 *                        ↘ FAILED | CANCELLED
 *
 * Three edges are deliberate and worth stating, because each one is a rule
 * somebody will otherwise "fix":
 *
 *  - `READY → PENDING` exists. Readiness is derived from the operator's
 *    availability, and availability goes *backwards*: an operator who was
 *    available at 22:00 is asleep at 23:00, and the operation must fall back to
 *    `PENDING` rather than claim to be performable by nobody.
 *  - `FAILED → PENDING`/`READY` exist. A failed intervention (nozzle still
 *    clogged) is retried, not archived — and while it is failed it *keeps
 *    blocking*, so the printer is never handed a job it cannot run.
 *  - `COMPLETED` is terminal with **no** outgoing edges. Confirmation is the
 *    one-way door the whole bed-clearance guarantee rests on; "un-completing"
 *    an operation would mean the bed silently un-clears under a running job.
 */
export const MANUAL_OPERATION_TRANSITIONS: TransitionMap<ManualOperationState> = {
  PENDING: ["READY", "IN_PROGRESS", "COMPLETED", "CANCELLED"],
  READY: ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "FAILED", "CANCELLED", "READY"],
  FAILED: ["PENDING", "READY", "IN_PROGRESS", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: []
};

/** Asserts a manual-operation move is legal, throwing `StateTransitionError` (409) otherwise. */
export function assertOperationTransition(
  from: ManualOperationState,
  to: ManualOperationState
): void {
  assertTransition("ручная операция", MANUAL_OPERATION_TRANSITIONS, from, to);
}

/**
 * Default hands-on duration per type, in minutes.
 *
 * These are **farm-tuned estimates, not measurements**, and they are separate
 * numbers on purpose: a spool change and a nozzle change are not the same
 * intervention, and collapsing them into one "operator does a thing ≈ 10 min"
 * constant is what makes a morning plan wrong by an hour. Each is overridable
 * per operation (`estimatedMinutes`), and the *actual* time an operator reports
 * is recorded alongside, so these can be replaced by observed medians later.
 */
export const DEFAULT_OPERATION_MINUTES: Readonly<Record<ManualOperationType, number>> = {
  PART_REMOVAL: 5,
  PLATE_SERVICE: 10,
  MATERIAL_CHANGE: 15,
  SPOOL_CHANGE: 8,
  NOZZLE_CHANGE: 25,
  CALIBRATION: 20,
  VISUAL_INSPECTION: 3,
  FILE_TRANSFER_CONFIRM: 5
};

/**
 * Whether a type holds its printer by default.
 *
 * Everything that touches the plate or the hot end blocks: the machine cannot
 * physically run its next job until it is done. A visual inspection does not —
 * it is a quality check whose absence is a warning, not a collision risk. The
 * flag is stored per operation, so a specific inspection can still be marked
 * blocking (a first-layer check on an expensive print) without changing the type.
 */
export const BLOCKING_BY_DEFAULT: Readonly<Record<ManualOperationType, boolean>> = {
  PART_REMOVAL: true,
  PLATE_SERVICE: true,
  MATERIAL_CHANGE: true,
  SPOOL_CHANGE: true,
  NOZZLE_CHANGE: true,
  CALIBRATION: true,
  VISUAL_INSPECTION: false,
  FILE_TRANSFER_CONFIRM: true
};

/**
 * The types whose confirmation *is* a bed clearance: the operator physically
 * removed the part or swapped the plate. Completing one of these is the only
 * automatic route from `AWAITING_CLEARANCE` to `CLEAR` — and it is not automatic
 * at all, it is a named human confirmation with a recorded time.
 */
export const BED_CLEARING_TYPES: ReadonlySet<ManualOperationType> = new Set<ManualOperationType>([
  "PART_REMOVAL",
  "PLATE_SERVICE"
]);

/** Operator-facing Russian labels — the one place the type vocabulary is spelled out. */
export const OPERATION_LABELS: Readonly<Record<ManualOperationType, string>> = {
  PART_REMOVAL: "снятие готовой модели",
  PLATE_SERVICE: "очистка или замена пластины",
  MATERIAL_CHANGE: "замена материала",
  SPOOL_CHANGE: "замена катушки",
  NOZZLE_CHANGE: "замена сопла",
  CALIBRATION: "калибровка",
  VISUAL_INSPECTION: "визуальная проверка",
  FILE_TRANSFER_CONFIRM: "подтверждение ручной загрузки файла"
};
