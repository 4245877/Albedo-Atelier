import type { DatabaseSync } from "node:sqlite";

import type { ArtifactAnalysisRepository } from "../../../domain/print/repositories";
import type {
  AnalysisVerdict,
  ArtifactAnalysis,
  ArtifactAnalysisState,
  DetectedFormat
} from "../../../domain/print/types";
import {
  asNumberOrNull,
  asString,
  asStringOrNull,
  BaseRepository,
  findingsToText,
  metadataToText,
  parseFindings,
  parseMetadata,
  type Row,
  type RowMapper,
  type SqlValue
} from "./shared";

const ANALYSIS_STATES: readonly ArtifactAnalysisState[] = ["pending", "running", "ready", "failed"];
const VERDICTS: readonly AnalysisVerdict[] = [
  "needs_preparation",
  "schedulable",
  "needs_input",
  "review",
  "blocked"
];
const FORMATS: readonly DetectedFormat[] = ["stl", "3mf", "gcode", "unknown"];

function toState(value: unknown): ArtifactAnalysisState {
  return ANALYSIS_STATES.includes(value as ArtifactAnalysisState)
    ? (value as ArtifactAnalysisState)
    : "pending";
}

function toVerdict(value: unknown): AnalysisVerdict | null {
  return VERDICTS.includes(value as AnalysisVerdict) ? (value as AnalysisVerdict) : null;
}

function toFormat(value: unknown): DetectedFormat | null {
  return FORMATS.includes(value as DetectedFormat) ? (value as DetectedFormat) : null;
}

const mapper: RowMapper<ArtifactAnalysis> = {
  table: "artifact_analyses",
  entity: "анализ артефакта",
  columns: [
    "id",
    "artifact_id",
    "state",
    "verdict",
    "detected_format",
    "analyzer",
    "analyzer_version",
    "estimated_duration_s",
    "estimated_filament_g",
    "material",
    "nozzle_diameter_mm",
    "layer_height_mm",
    "warnings",
    "blockers",
    "data",
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
      verdict: a.verdict,
      detected_format: a.detectedFormat,
      analyzer: a.analyzer,
      analyzer_version: a.analyzerVersion,
      estimated_duration_s: a.estimatedDurationS,
      estimated_filament_g: a.estimatedFilamentG,
      material: a.material,
      nozzle_diameter_mm: a.nozzleDiameterMm,
      layer_height_mm: a.layerHeightMm,
      warnings: findingsToText(a.warnings),
      blockers: findingsToText(a.blockers),
      data: metadataToText(a.data),
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
      verdict: toVerdict(row.verdict),
      detectedFormat: toFormat(row.detected_format),
      analyzer: asStringOrNull(row.analyzer),
      analyzerVersion: asStringOrNull(row.analyzer_version),
      estimatedDurationS: asNumberOrNull(row.estimated_duration_s),
      estimatedFilamentG: asNumberOrNull(row.estimated_filament_g),
      material: asStringOrNull(row.material),
      nozzleDiameterMm: asNumberOrNull(row.nozzle_diameter_mm),
      layerHeightMm: asNumberOrNull(row.layer_height_mm),
      warnings: parseFindings(row.warnings),
      blockers: parseFindings(row.blockers),
      data: parseMetadata(row.data),
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

  /**
   * Every not-yet-finished analysis (`pending` or `running`), oldest first — the
   * work the analysis worker re-queues on startup so a crash mid-analysis is
   * recovered instead of leaving the row stuck forever.
   */
  listUnfinished(): ArtifactAnalysis[] {
    return this.query(
      "SELECT * FROM artifact_analyses WHERE state IN ('pending','running') ORDER BY created_at, id"
    );
  }
}
