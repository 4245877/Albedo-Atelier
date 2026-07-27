import type { WritableRepository } from "../shared/repository";
import type {
  ManualOperation,
  ManualOperationState,
  Operator,
  OperatorAbsence,
  ScheduleException,
  ScheduleRule
} from "./types";

/**
 * Storage ports for the operator/operations domain — the same shape as
 * `domain/print/repositories`: interfaces only, optimistic `version` on every
 * mutable entity, and no `node:sqlite` anywhere near the domain.
 */

export interface OperatorRepository extends WritableRepository<Operator> {
  /** Every operator, active first, then by name — the roster order the UI shows. */
  list(): Operator[];
  /** Only operators eligible to perform work. */
  listActive(): Operator[];
}

export interface ScheduleRuleRepository extends WritableRepository<ScheduleRule> {
  listByOperator(operatorId: string): ScheduleRule[];
  delete(id: string): void;
  /** Drops every rule of an operator — the "replace my whole week" write. */
  deleteByOperator(operatorId: string): void;
}

export interface ScheduleExceptionRepository extends WritableRepository<ScheduleException> {
  listByOperator(operatorId: string): ScheduleException[];
  /** Exceptions on or after a local `YYYY-MM-DD`, for the upcoming-overrides view. */
  listUpcoming(operatorId: string, fromLocalDate: string): ScheduleException[];
  delete(id: string): void;
}

export interface OperatorAbsenceRepository extends WritableRepository<OperatorAbsence> {
  listByOperator(operatorId: string): OperatorAbsence[];
  /** Absences that have not ended before `nowIso` (open-ended ones always count). */
  listActiveOrFuture(operatorId: string, nowIso: string): OperatorAbsence[];
  delete(id: string): void;
}

export interface ManualOperationRepository extends WritableRepository<ManualOperation> {
  /** Operations on a printer in the given states, oldest first (execution order). */
  listByPrinter(printerId: string, states?: readonly ManualOperationState[]): ManualOperation[];
  /** Every operation opened for an assignment, oldest first. */
  listByAssignment(assignmentId: string): ManualOperation[];
  /** The still-open operations across the whole farm, oldest first. */
  listOpen(): ManualOperation[];
  /** Operations in the given states, oldest first — the readiness sweep reads this. */
  listByStates(states: readonly ManualOperationState[]): ManualOperation[];
  /** The operation an operator is currently performing, if any (the one-at-a-time rule). */
  findInProgressByOperator(operatorId: string): ManualOperation | null;
}

/** The operations-domain repositories, added to the shared store bundle. */
export interface OperationsRepositories {
  operators: OperatorRepository;
  scheduleRules: ScheduleRuleRepository;
  scheduleExceptions: ScheduleExceptionRepository;
  operatorAbsences: OperatorAbsenceRepository;
  manualOperations: ManualOperationRepository;
}
