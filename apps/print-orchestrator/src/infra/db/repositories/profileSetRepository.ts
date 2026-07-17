import type { DatabaseSync } from "node:sqlite";

import type { ProfileSetRepository } from "../../../domain/slicing/repositories";
import type { ProfileSet, ProfileSetValidation } from "../../../domain/slicing/types";
import {
  asBool,
  asNumberOrNull,
  asString,
  asStringOrNull,
  BaseRepository,
  boolToInt,
  findingsToText,
  metadataToText,
  parseFindings,
  parseMetadata,
  type Row,
  type RowMapper,
  type SqlValue
} from "./shared";

const VALIDATIONS: readonly ProfileSetValidation[] = ["valid", "warnings", "blocked"];

function toValidation(value: unknown): ProfileSetValidation {
  return VALIDATIONS.includes(value as ProfileSetValidation)
    ? (value as ProfileSetValidation)
    : "blocked";
}

const mapper: RowMapper<ProfileSet> = {
  table: "profile_sets",
  entity: "набор профилей",
  columns: [
    "id",
    "name",
    "machine_revision_id",
    "process_revision_id",
    "filament_revision_id",
    "printer_id",
    "printer_class",
    "validation",
    "approved",
    "approved_by",
    "approved_at",
    "warnings",
    "blockers",
    "created_at",
    "updated_at",
    "version",
    "metadata"
  ],
  toRow(s): Record<string, SqlValue> {
    return {
      id: s.id,
      name: s.name,
      machine_revision_id: s.machineRevisionId,
      process_revision_id: s.processRevisionId,
      filament_revision_id: s.filamentRevisionId,
      printer_id: s.printerId,
      printer_class: s.printerClass,
      validation: s.validation,
      approved: boolToInt(s.approved),
      approved_by: s.approvedBy,
      approved_at: s.approvedAt,
      warnings: findingsToText(s.warnings),
      blockers: findingsToText(s.blockers),
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      version: s.version,
      metadata: metadataToText(s.metadata)
    };
  },
  fromRow(row: Row): ProfileSet {
    return {
      id: asString(row.id),
      name: asString(row.name),
      machineRevisionId: asString(row.machine_revision_id),
      processRevisionId: asString(row.process_revision_id),
      filamentRevisionId: asString(row.filament_revision_id),
      printerId: asStringOrNull(row.printer_id),
      printerClass: asStringOrNull(row.printer_class),
      validation: toValidation(row.validation),
      approved: asBool(row.approved),
      approvedBy: asStringOrNull(row.approved_by),
      approvedAt: asStringOrNull(row.approved_at),
      warnings: parseFindings(row.warnings),
      blockers: parseFindings(row.blockers),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteProfileSetRepository
  extends BaseRepository<ProfileSet>
  implements ProfileSetRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  list(): ProfileSet[] {
    return this.query("SELECT * FROM profile_sets ORDER BY created_at DESC, id DESC");
  }
}
