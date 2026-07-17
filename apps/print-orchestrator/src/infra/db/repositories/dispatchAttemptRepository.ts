import type { DatabaseSync } from "node:sqlite";

import type { DispatchAttemptRepository } from "../../../domain/print/repositories";
import type { DispatchAttempt, DispatchAttemptState } from "../../../domain/print/types";
import {
  asNumber,
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

const ATTEMPT_STATES: readonly DispatchAttemptState[] = ["PENDING", "SENT", "ACKED", "FAILED"];

function toState(value: unknown): DispatchAttemptState {
  return ATTEMPT_STATES.includes(value as DispatchAttemptState)
    ? (value as DispatchAttemptState)
    : "FAILED";
}

const mapper: RowMapper<DispatchAttempt> = {
  table: "dispatch_attempts",
  entity: "попытка запуска",
  columns: [
    "id",
    "assignment_id",
    "task_id",
    "printer_id",
    "attempt_no",
    "state",
    "error",
    "requested_at",
    "completed_at",
    "created_at",
    "updated_at",
    "version",
    "metadata"
  ],
  toRow(d): Record<string, SqlValue> {
    return {
      id: d.id,
      assignment_id: d.assignmentId,
      task_id: d.taskId,
      printer_id: d.printerId,
      attempt_no: d.attemptNo,
      state: d.state,
      error: d.error,
      requested_at: d.requestedAt,
      completed_at: d.completedAt,
      created_at: d.createdAt,
      updated_at: d.updatedAt,
      version: d.version,
      metadata: metadataToText(d.metadata)
    };
  },
  fromRow(row: Row): DispatchAttempt {
    return {
      id: asString(row.id),
      assignmentId: asString(row.assignment_id),
      taskId: asString(row.task_id),
      printerId: asString(row.printer_id),
      attemptNo: asNumber(row.attempt_no),
      state: toState(row.state),
      error: asStringOrNull(row.error),
      requestedAt: asString(row.requested_at),
      completedAt: asStringOrNull(row.completed_at),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteDispatchAttemptRepository
  extends BaseRepository<DispatchAttempt>
  implements DispatchAttemptRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  listByAssignment(assignmentId: string): DispatchAttempt[] {
    return this.query(
      "SELECT * FROM dispatch_attempts WHERE assignment_id = ? ORDER BY attempt_no, id",
      assignmentId
    );
  }

  maxAttemptNo(assignmentId: string): number {
    const row = this.db
      .prepare("SELECT MAX(attempt_no) AS maxNo FROM dispatch_attempts WHERE assignment_id = ?")
      .get(assignmentId) as { maxNo: number | null } | undefined;
    return row && row.maxNo !== null ? row.maxNo : 0;
  }
}
