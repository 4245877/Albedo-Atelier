import type { DatabaseSync } from "node:sqlite";

import type { QueueEntryRepository } from "../../../domain/print/repositories";
import type { QueueEntry, QueueEntryState } from "../../../domain/print/types";
import {
  asNumber,
  asNumberOrNull,
  asString,
  BaseRepository,
  type Row,
  type RowMapper,
  type SqlValue
} from "./shared";

const QUEUE_STATES: readonly QueueEntryState[] = ["WAITING", "HELD", "RELEASED"];

function toState(value: unknown): QueueEntryState {
  return QUEUE_STATES.includes(value as QueueEntryState)
    ? (value as QueueEntryState)
    : "RELEASED";
}

const mapper: RowMapper<QueueEntry> = {
  table: "queue_entries",
  entity: "запись очереди",
  columns: ["id", "task_id", "position", "state", "enqueued_at", "updated_at", "version"],
  toRow(e): Record<string, SqlValue> {
    return {
      id: e.id,
      task_id: e.taskId,
      position: e.position,
      state: e.state,
      enqueued_at: e.enqueuedAt,
      updated_at: e.updatedAt,
      version: e.version
    };
  },
  fromRow(row: Row): QueueEntry {
    return {
      id: asString(row.id),
      taskId: asString(row.task_id),
      position: asNumber(row.position),
      state: toState(row.state),
      enqueuedAt: asString(row.enqueued_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1
    };
  }
};

export class SqliteQueueEntryRepository
  extends BaseRepository<QueueEntry>
  implements QueueEntryRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  findByTaskId(taskId: string): QueueEntry | null {
    return this.queryOne("SELECT * FROM queue_entries WHERE task_id = ?", taskId);
  }

  listOpen(): QueueEntry[] {
    return this.query(
      "SELECT * FROM queue_entries WHERE state IN ('WAITING','HELD') ORDER BY position, enqueued_at, id"
    );
  }

  maxPosition(): number | null {
    const row = this.db
      .prepare("SELECT MAX(position) AS maxPos FROM queue_entries WHERE state IN ('WAITING','HELD')")
      .get() as { maxPos: number | null } | undefined;
    return row && row.maxPos !== null ? row.maxPos : null;
  }
}
