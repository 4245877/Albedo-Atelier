import type { DatabaseSync } from "node:sqlite";

import type { AssignmentRepository } from "../../../domain/print/repositories";
import type { Assignment, AssignmentSource, AssignmentState } from "../../../domain/print/types";
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

const ASSIGNMENT_SOURCES: readonly AssignmentSource[] = ["plan", "manual", "dispatch"];

/**
 * Rows written before migration 009 have no `source`. They were all produced by
 * the dispatch path or the planner and are read back as `dispatch` — the most
 * conservative label (it grants no plan authority and no manual provenance).
 */
function toSource(value: unknown): AssignmentSource {
  return ASSIGNMENT_SOURCES.includes(value as AssignmentSource)
    ? (value as AssignmentSource)
    : "dispatch";
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
    "source",
    "reason",
    "created_by",
    "slice_variant_id",
    "artifact_id",
    "artifact_sha256",
    "machine_revision_id",
    "process_revision_id",
    "filament_revision_id",
    "expected_remote_path",
    "gcode_flavor",
    "nozzle_mm",
    "material",
    "eta_s",
    "planned_start_at",
    "plan_revision",
    "invalidated_at",
    "invalidated_reason",
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
      source: a.source,
      reason: a.reason,
      created_by: a.createdBy,
      slice_variant_id: a.binding.sliceVariantId,
      artifact_id: a.binding.artifactId,
      artifact_sha256: a.binding.artifactSha256,
      machine_revision_id: a.binding.machineRevisionId,
      process_revision_id: a.binding.processRevisionId,
      filament_revision_id: a.binding.filamentRevisionId,
      expected_remote_path: a.binding.expectedRemotePath,
      gcode_flavor: a.binding.gcodeFlavor,
      nozzle_mm: a.binding.nozzleMm,
      material: a.binding.material,
      eta_s: a.binding.etaS,
      planned_start_at: a.binding.plannedStartAt,
      plan_revision: a.binding.planRevision,
      invalidated_at: a.invalidatedAt,
      invalidated_reason: a.invalidatedReason,
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
      source: toSource(row.source),
      reason: asStringOrNull(row.reason),
      createdBy: asStringOrNull(row.created_by),
      binding: {
        sliceVariantId: asStringOrNull(row.slice_variant_id),
        artifactId: asStringOrNull(row.artifact_id),
        artifactSha256: asStringOrNull(row.artifact_sha256),
        machineRevisionId: asStringOrNull(row.machine_revision_id),
        processRevisionId: asStringOrNull(row.process_revision_id),
        filamentRevisionId: asStringOrNull(row.filament_revision_id),
        expectedRemotePath: asStringOrNull(row.expected_remote_path),
        gcodeFlavor: asStringOrNull(row.gcode_flavor),
        nozzleMm: asNumberOrNull(row.nozzle_mm),
        material: asStringOrNull(row.material),
        etaS: asNumberOrNull(row.eta_s),
        plannedStartAt: asStringOrNull(row.planned_start_at),
        planRevision: asNumberOrNull(row.plan_revision)
      },
      invalidatedAt: asStringOrNull(row.invalidated_at),
      invalidatedReason: asStringOrNull(row.invalidated_reason),
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

  listByPlan(planId: string): Assignment[] {
    return this.query(
      "SELECT * FROM assignments WHERE plan_id = ? ORDER BY created_at, id",
      planId
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
