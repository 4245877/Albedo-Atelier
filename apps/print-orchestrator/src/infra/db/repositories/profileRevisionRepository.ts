import type { DatabaseSync } from "node:sqlite";

import type { ProfileRevisionRepository } from "../../../domain/slicing/repositories";
import type {
  ProfileRevision,
  ProfileRevisionStatus,
  ProfileType
} from "../../../domain/slicing/types";
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

const TYPES: readonly ProfileType[] = ["machine", "process", "filament"];
const STATUSES: readonly ProfileRevisionStatus[] = ["active", "quarantined", "invalid"];

function toType(value: unknown): ProfileType {
  return TYPES.includes(value as ProfileType) ? (value as ProfileType) : "process";
}

function toStatus(value: unknown): ProfileRevisionStatus {
  return STATUSES.includes(value as ProfileRevisionStatus)
    ? (value as ProfileRevisionStatus)
    : "invalid";
}

const mapper: RowMapper<ProfileRevision> = {
  table: "profile_revisions",
  entity: "ревизия профиля",
  columns: [
    "id",
    "logical_id",
    "type",
    "name",
    "inherits",
    "status",
    "raw_json",
    "raw_sha256",
    "resolved_json",
    "resolved_sha256",
    "orca_version",
    "source",
    "warnings",
    "blockers",
    "created_at",
    "updated_at",
    "version",
    "metadata"
  ],
  toRow(r): Record<string, SqlValue> {
    return {
      id: r.id,
      logical_id: r.logicalId,
      type: r.type,
      name: r.name,
      inherits: r.inherits,
      status: r.status,
      raw_json: r.rawJson,
      raw_sha256: r.rawSha256,
      resolved_json: r.resolvedJson,
      resolved_sha256: r.resolvedSha256,
      orca_version: r.orcaVersion,
      source: r.source,
      warnings: findingsToText(r.warnings),
      blockers: findingsToText(r.blockers),
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      version: r.version,
      metadata: metadataToText(r.metadata)
    };
  },
  fromRow(row: Row): ProfileRevision {
    return {
      id: asString(row.id),
      logicalId: asString(row.logical_id),
      type: toType(row.type),
      name: asString(row.name),
      inherits: asStringOrNull(row.inherits),
      status: toStatus(row.status),
      rawJson: asString(row.raw_json),
      rawSha256: asString(row.raw_sha256),
      resolvedJson: asStringOrNull(row.resolved_json),
      resolvedSha256: asStringOrNull(row.resolved_sha256),
      orcaVersion: asStringOrNull(row.orca_version),
      source: asStringOrNull(row.source),
      warnings: parseFindings(row.warnings),
      blockers: parseFindings(row.blockers),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteProfileRevisionRepository
  extends BaseRepository<ProfileRevision>
  implements ProfileRevisionRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  findByRawSha256(rawSha256: string): ProfileRevision | null {
    return this.queryOne("SELECT * FROM profile_revisions WHERE raw_sha256 = ?", rawSha256);
  }

  findActiveByLogicalId(logicalId: string): ProfileRevision | null {
    return this.queryOne(
      "SELECT * FROM profile_revisions WHERE logical_id = ? AND status = 'active' LIMIT 1",
      logicalId
    );
  }

  latestByLogicalId(logicalId: string): ProfileRevision | null {
    return this.queryOne(
      "SELECT * FROM profile_revisions WHERE logical_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      logicalId
    );
  }

  list(type?: ProfileType): ProfileRevision[] {
    if (type) {
      return this.query(
        "SELECT * FROM profile_revisions WHERE type = ? ORDER BY name COLLATE NOCASE, created_at",
        type
      );
    }
    return this.query(
      "SELECT * FROM profile_revisions ORDER BY type, name COLLATE NOCASE, created_at"
    );
  }
}
