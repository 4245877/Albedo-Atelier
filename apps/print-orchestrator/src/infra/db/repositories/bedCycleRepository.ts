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
   * The printer's **current** cycle — the newest row, whatever its state — or
   * null when the bed has never been tracked at all.
   *
   * "Never tracked" and "tracked and cleared" are different facts, and only the
   * second is evidence of a free plate. Reading only non-CLEAR rows (the old
   * query) collapsed the two into "nothing open", and every caller then had to
   * guess what an empty answer meant; the guess was "free".
   */
  latestByPrinter(printerId: string): BedCycle | null {
    // Insertion order, not `created_at`: cycles are appended in the order things
    // happened to the plate, and a wall clock that steps backwards (NTP, a host
    // resync) must not resurrect an older row as "the plate now".
    return this.queryOne(
      `SELECT * FROM bed_cycles WHERE printer_id = ?
       ORDER BY rowid DESC LIMIT 1`,
      printerId
    );
  }

  /**
   * The current cycle when it is **not** `CLEAR` (RESERVED/RUNNING/
   * AWAITING_CLEARANCE/UNKNOWN), else null.
   *
   * Defined over the newest row, not over "the newest non-CLEAR row": an external
   * print observed after a stale, never-cleared cycle opens a newer cycle, and
   * the older row must not resurface as the plate's state once that newer one is
   * cleared.
   */
  findOpenByPrinter(printerId: string): BedCycle | null {
    const latest = this.latestByPrinter(printerId);
    return latest && latest.state !== "CLEAR" ? latest : null;
  }

  listByPrinter(printerId: string): BedCycle[] {
    return this.query(
      "SELECT * FROM bed_cycles WHERE printer_id = ? ORDER BY created_at, id",
      printerId
    );
  }
}
