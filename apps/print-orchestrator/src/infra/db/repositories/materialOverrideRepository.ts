import type { DatabaseSync } from "node:sqlite";

import type { MaterialOverrideRepository } from "../../../domain/print/repositories";
import type { MaterialOverride } from "../../../domain/print/types";
import {
  asBool,
  asNumberOrNull,
  asString,
  asStringOrNull,
  BaseRepository,
  boolToInt,
  metadataToText,
  parseMetadata,
  type Row,
  type RowMapper,
  type SqlValue
} from "./shared";

const mapper: RowMapper<MaterialOverride> = {
  table: "material_overrides",
  entity: "остаток материала",
  columns: [
    "id",
    "printer_id",
    "sufficient",
    "coverage_hours",
    "note",
    "author",
    "created_at",
    "expires_at",
    "version",
    "metadata"
  ],
  toRow(o): Record<string, SqlValue> {
    return {
      id: o.id,
      printer_id: o.printerId,
      sufficient: boolToInt(o.sufficient),
      coverage_hours: o.coverageHours,
      note: o.note,
      author: o.author,
      created_at: o.createdAt,
      expires_at: o.expiresAt,
      version: o.version,
      metadata: metadataToText(o.metadata)
    };
  },
  fromRow(row: Row): MaterialOverride {
    return {
      id: asString(row.id),
      printerId: asString(row.printer_id),
      sufficient: asBool(row.sufficient),
      coverageHours: asNumberOrNull(row.coverage_hours),
      note: asStringOrNull(row.note),
      author: asStringOrNull(row.author),
      createdAt: asString(row.created_at),
      expiresAt: asStringOrNull(row.expires_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteMaterialOverrideRepository
  extends BaseRepository<MaterialOverride>
  implements MaterialOverrideRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  listByPrinter(printerId: string): MaterialOverride[] {
    return this.query(
      "SELECT * FROM material_overrides WHERE printer_id = ? ORDER BY created_at DESC, id DESC",
      printerId
    );
  }

  list(): MaterialOverride[] {
    return this.query("SELECT * FROM material_overrides ORDER BY created_at DESC, id DESC");
  }
}
