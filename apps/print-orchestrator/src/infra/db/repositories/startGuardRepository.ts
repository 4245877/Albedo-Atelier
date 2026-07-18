import type { DatabaseSync } from "node:sqlite";

import type { StartGuardRepository } from "../../../domain/print/repositories";
import type { StartGuard, StartGuardState } from "../../../domain/print/types";
import { asString, asStringOrNull, type Row } from "./shared";

const GUARD_STATES: readonly StartGuardState[] = ["SENT", "ACKED", "UNKNOWN"];

function toState(value: unknown): StartGuardState {
  // An unrecognised persisted state degrades to the fail-closed `UNKNOWN`, never
  // to a value that would let a start proceed unreconciled.
  return GUARD_STATES.includes(value as StartGuardState) ? (value as StartGuardState) : "UNKNOWN";
}

function fromRow(row: Row): StartGuard {
  return {
    printerId: asString(row.printer_id),
    file: asString(row.file),
    state: toState(row.state),
    jobRef: asStringOrNull(row.job_ref),
    requestedAt: asString(row.requested_at),
    updatedAt: asString(row.updated_at)
  };
}

/**
 * SQLite-backed {@link StartGuardRepository}. A plain upsert keyed by printer;
 * writes are synchronous (`node:sqlite`), so a failed persist throws to the
 * caller instead of being silently dropped — the guard the double-start
 * protection depends on is never "best effort".
 */
export class SqliteStartGuardRepository implements StartGuardRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(printerId: string): StartGuard | null {
    const row = this.db
      .prepare("SELECT * FROM start_guards WHERE printer_id = ?")
      .get(printerId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  upsert(guard: StartGuard): void {
    this.db
      .prepare(
        `INSERT INTO start_guards (printer_id, file, state, job_ref, requested_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(printer_id) DO UPDATE SET
           file = excluded.file,
           state = excluded.state,
           job_ref = excluded.job_ref,
           requested_at = excluded.requested_at,
           updated_at = excluded.updated_at`
      )
      .run(
        guard.printerId,
        guard.file,
        guard.state,
        guard.jobRef,
        guard.requestedAt,
        guard.updatedAt
      );
  }

  delete(printerId: string): void {
    this.db.prepare("DELETE FROM start_guards WHERE printer_id = ?").run(printerId);
  }

  list(): StartGuard[] {
    const rows = this.db
      .prepare("SELECT * FROM start_guards ORDER BY printer_id")
      .all() as Row[];
    return rows.map(fromRow);
  }
}
