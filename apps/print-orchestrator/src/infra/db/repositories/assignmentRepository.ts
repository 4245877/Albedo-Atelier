import type { DatabaseSync } from "node:sqlite";

import type { AssignmentRepository } from "../../../domain/print/repositories";
import type { Assignment, AssignmentState } from "../../../domain/print/types";
import {
  asNumberOrNull,
  asString,
  asStringOrNull,
  BaseRepository,
  metadataToText,
  parseMetadata,
  type Row,
  type RowMapper,
  type SqlValue
} from "./shared";

const ASSIGNMENT_STATES: readonly AssignmentState[] = [
  "PROPOSED",
  "RESERVED",
  "ACTIVE",
  "RELEASED",
  "CANCELLED"
];

function toState(value: unknown): AssignmentState {
  return ASSIGNMENT_STATES.includes(value as AssignmentState)
    ? (value as AssignmentState)
    : "CANCELLED";
}

const mapper: RowMapper<Assignment> = {
  table: "assignments",
  entity: "назначение",
  columns: [
    "id",
    "task_id",
    "printer_id",
    "plan_id",
    "bed_cycle_id",
    "state",
    "created_at",
    "updated_at",
    "version",
    "legacy_ref",
    "metadata"
  ],
  toRow(a): Record<string, SqlValue> {
    return {
      id: a.id,
      task_id: a.taskId,
      printer_id: a.printerId,
      plan_id: a.planId,
      bed_cycle_id: a.bedCycleId,
      state: a.state,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      version: a.version,
      legacy_ref: a.legacyRef,
      metadata: metadataToText(a.metadata)
    };
  },
  fromRow(row: Row): Assignment {
    return {
      id: asString(row.id),
      taskId: asString(row.task_id),
      printerId: asString(row.printer_id),
      planId: asStringOrNull(row.plan_id),
      bedCycleId: asStringOrNull(row.bed_cycle_id),
      state: toState(row.state),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      legacyRef: asStringOrNull(row.legacy_ref),
      metadata: parseMetadata(row.metadata)
    };
  }
};

/** An assignment still holding its printer: anything not yet released/cancelled. */
const OPEN_STATES = "('PROPOSED','RESERVED','ACTIVE')";

export class SqliteAssignmentRepository
  extends BaseRepository<Assignment>
  implements AssignmentRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  listByTask(taskId: string): Assignment[] {
    return this.query(
      "SELECT * FROM assignments WHERE task_id = ? ORDER BY created_at, id",
      taskId
    );
  }

  findOpenByPrinter(printerId: string): Assignment | null {
    return this.queryOne(
      `SELECT * FROM assignments WHERE printer_id = ? AND state IN ${OPEN_STATES}
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      printerId
    );
  }
}
