import type { DatabaseSync } from "node:sqlite";

import type { ArtifactRepository } from "../../../domain/print/repositories";
import type { Artifact, ArtifactKind } from "../../../domain/print/types";
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

const ARTIFACT_KINDS: readonly ArtifactKind[] = ["gcode", "model", "unknown"];

function toKind(value: unknown): ArtifactKind {
  return ARTIFACT_KINDS.includes(value as ArtifactKind) ? (value as ArtifactKind) : "unknown";
}

const mapper: RowMapper<Artifact> = {
  table: "artifacts",
  entity: "артефакт",
  columns: [
    "id",
    "kind",
    "name",
    "source",
    "size_bytes",
    "sha256",
    "created_at",
    "updated_at",
    "version",
    "legacy_ref",
    "metadata"
  ],
  toRow(a): Record<string, SqlValue> {
    return {
      id: a.id,
      kind: a.kind,
      name: a.name,
      source: a.source,
      size_bytes: a.sizeBytes,
      sha256: a.sha256,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      version: a.version,
      legacy_ref: a.legacyRef,
      metadata: metadataToText(a.metadata)
    };
  },
  fromRow(row: Row): Artifact {
    return {
      id: asString(row.id),
      kind: toKind(row.kind),
      name: asString(row.name),
      source: asStringOrNull(row.source),
      sizeBytes: asNumberOrNull(row.size_bytes),
      sha256: asStringOrNull(row.sha256),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      legacyRef: asStringOrNull(row.legacy_ref),
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteArtifactRepository
  extends BaseRepository<Artifact>
  implements ArtifactRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  findByLegacyRef(legacyRef: string): Artifact | null {
    return this.queryOne("SELECT * FROM artifacts WHERE legacy_ref = ?", legacyRef);
  }

  findBySource(source: string): Artifact | null {
    return this.queryOne("SELECT * FROM artifacts WHERE source = ? LIMIT 1", source);
  }

  countBySource(source: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE source = ?")
      .get(source) as { n: number | bigint } | undefined;
    return Number(row?.n ?? 0);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
  }

  list(): Artifact[] {
    return this.query("SELECT * FROM artifacts ORDER BY created_at, id");
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number };
    return row.n;
  }

  totalStoredBytes(): number {
    // Dedup-aware: sum the size of each DISTINCT blob (storage key) once, so a
    // blob shared by several artifacts is not double-counted toward the quota.
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(size_bytes), 0) AS total
           FROM (SELECT size_bytes FROM artifacts WHERE source IS NOT NULL GROUP BY source)`
      )
      .get() as { total: number };
    return row.total;
  }
}
