import type { DatabaseSync } from "node:sqlite";

import type { PrintRunRepository } from "../../../domain/print/repositories";
import { ACTIVE_RUN_STATES, type PrintRun, type PrintRunState } from "../../../domain/print/types";
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

const RUN_STATES: readonly PrintRunState[] = [
  "PENDING",
  "RUNNING",
  "PAUSED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN"
];

/**
 * SQL fragment listing the states that hold a printer (see uq_* indexes in 008),
 * derived from the domain's authoritative {@link ACTIVE_RUN_STATES} so the live
 * `findActive*`/`listActive` queries can never drift from the domain rule. The
 * values are compile-time domain literals, so quoting them here is injection-safe.
 * (The 008 migration keeps its own frozen copy — a migration is a historical
 * snapshot and must not follow later changes to the constant.)
 */
const ACTIVE_STATES_SQL = `(${ACTIVE_RUN_STATES.map((s) => `'${s}'`).join(",")})`;

function toState(value: unknown): PrintRunState {
  return RUN_STATES.includes(value as PrintRunState) ? (value as PrintRunState) : "UNKNOWN";
}

const mapper: RowMapper<PrintRun> = {
  table: "print_runs",
  entity: "печать",
  columns: [
    "id",
    "task_id",
    "assignment_id",
    "dispatch_attempt_id",
    "printer_id",
    "bed_cycle_id",
    "state",
    "file",
    "artifact_id",
    "artifact_sha256",
    "idempotency_key",
    "started_at",
    "ended_at",
    "progress",
    "filament_used_g",
    "duration_s",
    "created_at",
    "updated_at",
    "version",
    "legacy_ref",
    "metadata"
  ],
  toRow(r): Record<string, SqlValue> {
    return {
      id: r.id,
      task_id: r.taskId,
      assignment_id: r.assignmentId,
      dispatch_attempt_id: r.dispatchAttemptId,
      printer_id: r.printerId,
      bed_cycle_id: r.bedCycleId,
      state: r.state,
      file: r.file,
      artifact_id: r.artifactId,
      artifact_sha256: r.artifactSha256,
      idempotency_key: r.idempotencyKey,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      progress: r.progress,
      filament_used_g: r.filamentUsedG,
      duration_s: r.durationS,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      version: r.version,
      legacy_ref: r.legacyRef,
      metadata: metadataToText(r.metadata)
    };
  },
  fromRow(row: Row): PrintRun {
    return {
      id: asString(row.id),
      taskId: asString(row.task_id),
      assignmentId: asString(row.assignment_id),
      dispatchAttemptId: asStringOrNull(row.dispatch_attempt_id),
      printerId: asString(row.printer_id),
      bedCycleId: asStringOrNull(row.bed_cycle_id),
      state: toState(row.state),
      file: asStringOrNull(row.file),
      artifactId: asStringOrNull(row.artifact_id),
      artifactSha256: asStringOrNull(row.artifact_sha256),
      idempotencyKey: asStringOrNull(row.idempotency_key),
      startedAt: asStringOrNull(row.started_at),
      endedAt: asStringOrNull(row.ended_at),
      progress: asNumberOrNull(row.progress),
      filamentUsedG: asNumberOrNull(row.filament_used_g),
      durationS: asNumberOrNull(row.duration_s),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      legacyRef: asStringOrNull(row.legacy_ref),
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqlitePrintRunRepository
  extends BaseRepository<PrintRun>
  implements PrintRunRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  listByTask(taskId: string): PrintRun[] {
    return this.query("SELECT * FROM print_runs WHERE task_id = ? ORDER BY created_at, id", taskId);
  }

  findByLegacyRef(legacyRef: string): PrintRun | null {
    return this.queryOne("SELECT * FROM print_runs WHERE legacy_ref = ?", legacyRef);
  }

  findActiveByPrinter(printerId: string): PrintRun | null {
    return this.queryOne(
      `SELECT * FROM print_runs WHERE printer_id = ? AND state IN ${ACTIVE_STATES_SQL}`,
      printerId
    );
  }

  findActiveByTask(taskId: string): PrintRun | null {
    return this.queryOne(
      `SELECT * FROM print_runs WHERE task_id = ? AND state IN ${ACTIVE_STATES_SQL}`,
      taskId
    );
  }

  findByIdempotencyKey(key: string): PrintRun | null {
    return this.queryOne("SELECT * FROM print_runs WHERE idempotency_key = ?", key);
  }

  listActive(): PrintRun[] {
    return this.query(
      `SELECT * FROM print_runs WHERE state IN ${ACTIVE_STATES_SQL} ORDER BY created_at, id`
    );
  }
}
