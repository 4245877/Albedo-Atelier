import type { DatabaseSync } from "node:sqlite";

import type { SliceVariantRepository } from "../../../domain/slicing/repositories";
import type { SliceVariant, SliceVariantState } from "../../../domain/slicing/types";
import {
  asNumberOrNull,
  asString,
  asStringOrNull,
  BaseRepository,
  findingsToText,
  metadataToText,
  metadataToTextOrNull,
  parseFindings,
  parseMetadata,
  parseMetadataOrNull,
  type Row,
  type RowMapper,
  type SqlValue
} from "./shared";

const STATES: readonly SliceVariantState[] = ["pending", "running", "ready", "failed", "blocked"];

function toState(value: unknown): SliceVariantState {
  return STATES.includes(value as SliceVariantState) ? (value as SliceVariantState) : "pending";
}

const mapper: RowMapper<SliceVariant> = {
  table: "slice_variants",
  entity: "вариант слайсинга",
  columns: [
    "id",
    "task_id",
    "source_artifact_id",
    "profile_set_id",
    "target_printer_id",
    "target_printer_class",
    "state",
    "cache_key",
    "orca_version",
    "worker_version",
    "output_artifact_id",
    "output_analysis_id",
    "orca_eta_s",
    "filament_g",
    "filament_mm",
    "dimensions",
    "warnings",
    "blockers",
    "error",
    "started_at",
    "ended_at",
    "created_at",
    "updated_at",
    "version",
    "metadata"
  ],
  toRow(v): Record<string, SqlValue> {
    return {
      id: v.id,
      task_id: v.taskId,
      source_artifact_id: v.sourceArtifactId,
      profile_set_id: v.profileSetId,
      target_printer_id: v.targetPrinterId,
      target_printer_class: v.targetPrinterClass,
      state: v.state,
      cache_key: v.cacheKey,
      orca_version: v.orcaVersion,
      worker_version: v.workerVersion,
      output_artifact_id: v.outputArtifactId,
      output_analysis_id: v.outputAnalysisId,
      orca_eta_s: v.orcaEtaS,
      filament_g: v.filamentG,
      filament_mm: v.filamentMm,
      dimensions: metadataToTextOrNull(v.dimensions),
      warnings: findingsToText(v.warnings),
      blockers: findingsToText(v.blockers),
      error: v.error,
      started_at: v.startedAt,
      ended_at: v.endedAt,
      created_at: v.createdAt,
      updated_at: v.updatedAt,
      version: v.version,
      metadata: metadataToText(v.metadata)
    };
  },
  fromRow(row: Row): SliceVariant {
    return {
      id: asString(row.id),
      taskId: asString(row.task_id),
      sourceArtifactId: asString(row.source_artifact_id),
      profileSetId: asString(row.profile_set_id),
      targetPrinterId: asStringOrNull(row.target_printer_id),
      targetPrinterClass: asStringOrNull(row.target_printer_class),
      state: toState(row.state),
      cacheKey: asString(row.cache_key),
      orcaVersion: asStringOrNull(row.orca_version),
      workerVersion: asStringOrNull(row.worker_version),
      outputArtifactId: asStringOrNull(row.output_artifact_id),
      outputAnalysisId: asStringOrNull(row.output_analysis_id),
      orcaEtaS: asNumberOrNull(row.orca_eta_s),
      filamentG: asNumberOrNull(row.filament_g),
      filamentMm: asNumberOrNull(row.filament_mm),
      dimensions: parseMetadataOrNull(row.dimensions),
      warnings: parseFindings(row.warnings),
      blockers: parseFindings(row.blockers),
      error: asStringOrNull(row.error),
      startedAt: asStringOrNull(row.started_at),
      endedAt: asStringOrNull(row.ended_at),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteSliceVariantRepository
  extends BaseRepository<SliceVariant>
  implements SliceVariantRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  /**
   * A finished (`ready`) variant with this cache key that still has an output
   * artifact — the cache-hit lookup. A `ready` row whose output was pruned is
   * skipped so the caller re-slices rather than pointing at a missing blob.
   */
  findReadyByCacheKey(cacheKey: string): SliceVariant | null {
    return this.queryOne(
      `SELECT * FROM slice_variants
        WHERE cache_key = ? AND state = 'ready' AND output_artifact_id IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      cacheKey
    );
  }

  listByTask(taskId: string): SliceVariant[] {
    return this.query(
      "SELECT * FROM slice_variants WHERE task_id = ? ORDER BY created_at DESC, id DESC",
      taskId
    );
  }

  listUnfinished(): SliceVariant[] {
    return this.query(
      "SELECT * FROM slice_variants WHERE state IN ('pending','running') ORDER BY created_at, id"
    );
  }

  list(): SliceVariant[] {
    return this.query("SELECT * FROM slice_variants ORDER BY created_at DESC, id DESC");
  }
}
