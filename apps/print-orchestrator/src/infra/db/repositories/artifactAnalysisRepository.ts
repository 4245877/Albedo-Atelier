import type { DatabaseSync } from "node:sqlite";

import type { ArtifactAnalysisRepository } from "../../../domain/print/repositories";
import type { ArtifactAnalysis, ArtifactAnalysisState } from "../../../domain/print/types";
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

const ANALYSIS_STATES: readonly ArtifactAnalysisState[] = ["pending", "ready", "failed"];

function toState(value: unknown): ArtifactAnalysisState {
  return ANALYSIS_STATES.includes(value as ArtifactAnalysisState)
    ? (value as ArtifactAnalysisState)
    : "pending";
}

const mapper: RowMapper<ArtifactAnalysis> = {
  table: "artifact_analyses",
  entity: "анализ артефакта",
  columns: [
    "id",
    "artifact_id",
    "state",
    "analyzer",
    "estimated_duration_s",
    "estimated_filament_g",
    "material",
    "nozzle_diameter_mm",
    "layer_height_mm",
    "error",
    "created_at",
    "updated_at",
    "version",
    "metadata"
  ],
  toRow(a): Record<string, SqlValue> {
    return {
      id: a.id,
      artifact_id: a.artifactId,
      state: a.state,
      analyzer: a.analyzer,
      estimated_duration_s: a.estimatedDurationS,
      estimated_filament_g: a.estimatedFilamentG,
      material: a.material,
      nozzle_diameter_mm: a.nozzleDiameterMm,
      layer_height_mm: a.layerHeightMm,
      error: a.error,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      version: a.version,
      metadata: metadataToText(a.metadata)
    };
  },
  fromRow(row: Row): ArtifactAnalysis {
    return {
      id: asString(row.id),
      artifactId: asString(row.artifact_id),
      state: toState(row.state),
      analyzer: asStringOrNull(row.analyzer),
      estimatedDurationS: asNumberOrNull(row.estimated_duration_s),
      estimatedFilamentG: asNumberOrNull(row.estimated_filament_g),
      material: asStringOrNull(row.material),
      nozzleDiameterMm: asNumberOrNull(row.nozzle_diameter_mm),
      layerHeightMm: asNumberOrNull(row.layer_height_mm),
      error: asStringOrNull(row.error),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteArtifactAnalysisRepository
  extends BaseRepository<ArtifactAnalysis>
  implements ArtifactAnalysisRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  listByArtifact(artifactId: string): ArtifactAnalysis[] {
    return this.query(
      "SELECT * FROM artifact_analyses WHERE artifact_id = ? ORDER BY created_at, id",
      artifactId
    );
  }

  latestForArtifact(artifactId: string): ArtifactAnalysis | null {
    return this.queryOne(
      "SELECT * FROM artifact_analyses WHERE artifact_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      artifactId
    );
  }
}
