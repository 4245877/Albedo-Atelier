import type { DatabaseSync } from "node:sqlite";

import type { ManualOperationRepository } from "../../../domain/operations/repositories";
import {
  MANUAL_OPERATION_TYPES,
  type ManualOperation,
  type ManualOperationOrigin,
  type ManualOperationState,
  type ManualOperationType
} from "../../../domain/operations/types";
import {
  asBool,
  asNumberOrNull,
  asString,
  asStringOrNull,
  BaseRepository,
  boolToInt,
  metadataToText,
  parseMetadata,
  type Row,
  type RowMapper,
  type SqlValue
} from "./shared";

const STATES: readonly ManualOperationState[] = [
  "PENDING",
  "READY",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "CANCELLED"
];

const ORIGINS: readonly ManualOperationOrigin[] = [
  "print_finished",
  "assignment_requirement",
  "operator",
  "maintenance"
];

/**
 * An unrecognised stored state reads back as `PENDING`, not as a completed one:
 * a row this build cannot interpret must keep holding its printer rather than
 * quietly freeing it. Same fail-closed reasoning as the bed-cycle mapper's
 * `UNKNOWN` default.
 */
function toState(value: unknown): ManualOperationState {
  return STATES.includes(value as ManualOperationState)
    ? (value as ManualOperationState)
    : "PENDING";
}

function toType(value: unknown): ManualOperationType {
  return MANUAL_OPERATION_TYPES.includes(value as ManualOperationType)
    ? (value as ManualOperationType)
    : "VISUAL_INSPECTION";
}

function toOrigin(value: unknown): ManualOperationOrigin {
  return ORIGINS.includes(value as ManualOperationOrigin)
    ? (value as ManualOperationOrigin)
    : "operator";
}

const mapper: RowMapper<ManualOperation> = {
  table: "manual_operations",
  entity: "ручная операция",
  columns: [
    "id",
    "type",
    "state",
    "printer_id",
    "assignment_id",
    "task_id",
    "bed_cycle_id",
    "estimated_minutes",
    "window_start",
    "window_end",
    "blocking",
    "origin",
    "reason",
    "assigned_operator_id",
    "confirmed_by",
    "started_at",
    "completed_at",
    "actual_minutes",
    "ready_at",
    "note",
    "created_at",
    "updated_at",
    "version",
    "metadata"
  ],
  toRow(o): Record<string, SqlValue> {
    return {
      id: o.id,
      type: o.type,
      state: o.state,
      printer_id: o.printerId,
      assignment_id: o.assignmentId,
      task_id: o.taskId,
      bed_cycle_id: o.bedCycleId,
      estimated_minutes: o.estimatedMinutes,
      window_start: o.windowStart,
      window_end: o.windowEnd,
      blocking: boolToInt(o.blocking),
      origin: o.origin,
      reason: o.reason,
      assigned_operator_id: o.assignedOperatorId,
      confirmed_by: o.confirmedBy,
      started_at: o.startedAt,
      completed_at: o.completedAt,
      actual_minutes: o.actualMinutes,
      ready_at: o.readyAt,
      note: o.note,
      created_at: o.createdAt,
      updated_at: o.updatedAt,
      version: o.version,
      metadata: metadataToText(o.metadata)
    };
  },
  fromRow(row: Row): ManualOperation {
    return {
      id: asString(row.id),
      type: toType(row.type),
      state: toState(row.state),
      printerId: asString(row.printer_id),
      assignmentId: asStringOrNull(row.assignment_id),
      taskId: asStringOrNull(row.task_id),
      bedCycleId: asStringOrNull(row.bed_cycle_id),
      estimatedMinutes: asNumberOrNull(row.estimated_minutes),
      windowStart: asStringOrNull(row.window_start),
      windowEnd: asStringOrNull(row.window_end),
      blocking: asBool(row.blocking),
      origin: toOrigin(row.origin),
      reason: asStringOrNull(row.reason),
      assignedOperatorId: asStringOrNull(row.assigned_operator_id),
      confirmedBy: asStringOrNull(row.confirmed_by),
      startedAt: asStringOrNull(row.started_at),
      completedAt: asStringOrNull(row.completed_at),
      actualMinutes: asNumberOrNull(row.actual_minutes),
      readyAt: asStringOrNull(row.ready_at),
      note: asStringOrNull(row.note),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

const OPEN_STATES = "('PENDING','READY','IN_PROGRESS','FAILED')";

export class SqliteManualOperationRepository
  extends BaseRepository<ManualOperation>
  implements ManualOperationRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  listByPrinter(printerId: string, states?: readonly ManualOperationState[]): ManualOperation[] {
    if (!states || states.length === 0) {
      return this.query(
        "SELECT * FROM manual_operations WHERE printer_id = ? ORDER BY created_at, id",
        printerId
      );
    }
    const placeholders = states.map(() => "?").join(", ");
    return this.query(
      `SELECT * FROM manual_operations WHERE printer_id = ? AND state IN (${placeholders})
       ORDER BY created_at, id`,
      printerId,
      ...states
    );
  }

  listByAssignment(assignmentId: string): ManualOperation[] {
    return this.query(
      "SELECT * FROM manual_operations WHERE assignment_id = ? ORDER BY created_at, id",
      assignmentId
    );
  }

  listOpen(): ManualOperation[] {
    return this.query(
      `SELECT * FROM manual_operations WHERE state IN ${OPEN_STATES} ORDER BY created_at, id`
    );
  }

  listByStates(states: readonly ManualOperationState[]): ManualOperation[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    return this.query(
      `SELECT * FROM manual_operations WHERE state IN (${placeholders}) ORDER BY created_at, id`,
      ...states
    );
  }

  findInProgressByOperator(operatorId: string): ManualOperation | null {
    return this.queryOne(
      `SELECT * FROM manual_operations
       WHERE assigned_operator_id = ? AND state = 'IN_PROGRESS'
       ORDER BY started_at DESC, id LIMIT 1`,
      operatorId
    );
  }
}
