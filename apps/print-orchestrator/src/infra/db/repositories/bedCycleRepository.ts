import type { DatabaseSync } from "node:sqlite";

import type { BedCycleRepository } from "../../../domain/print/repositories";
import type { BedCycle, BedCycleState } from "../../../domain/print/types";
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

const BED_CYCLE_STATES: readonly BedCycleState[] = [
  "CLEAR",
  "RESERVED",
  "RUNNING",
  "AWAITING_CLEARANCE",
  "UNKNOWN"
];

function toState(value: unknown): BedCycleState {
  return BED_CYCLE_STATES.includes(value as BedCycleState)
    ? (value as BedCycleState)
    : "UNKNOWN";
}

const mapper: RowMapper<BedCycle> = {
  table: "bed_cycles",
  entity: "цикл стола",
  columns: [
    "id",
    "printer_id",
    "state",
    "assignment_id",
    "created_at",
    "updated_at",
    "cleared_at",
    "version",
    "metadata"
  ],
  toRow(b): Record<string, SqlValue> {
    return {
      id: b.id,
      printer_id: b.printerId,
      state: b.state,
      assignment_id: b.assignmentId,
      created_at: b.createdAt,
      updated_at: b.updatedAt,
      cleared_at: b.clearedAt,
      version: b.version,
      metadata: metadataToText(b.metadata)
    };
  },
  fromRow(row: Row): BedCycle {
    return {
      id: asString(row.id),
      printerId: asString(row.printer_id),
      state: toState(row.state),
      assignmentId: asStringOrNull(row.assignment_id),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      clearedAt: asStringOrNull(row.cleared_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteBedCycleRepository
  extends BaseRepository<BedCycle>
  implements BedCycleRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  /**
   * The current live cycle for a printer: the most recent one not in `CLEAR`
   * (i.e. RESERVED/RUNNING/AWAITING_CLEARANCE/UNKNOWN). A printer has at most one
   * of these by construction — the service only opens a new cycle from CLEAR.
   */
  findOpenByPrinter(printerId: string): BedCycle | null {
    return this.queryOne(
      `SELECT * FROM bed_cycles WHERE printer_id = ? AND state <> 'CLEAR'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      printerId
    );
  }

  listByPrinter(printerId: string): BedCycle[] {
    return this.query(
      "SELECT * FROM bed_cycles WHERE printer_id = ? ORDER BY created_at, id",
      printerId
    );
  }
}
