import type { DatabaseSync } from "node:sqlite";

import type { PrintTaskRepository, TaskQuery } from "../../../domain/print/repositories";
import type { DayNightPreference, PrintTask, PrintTaskState } from "../../../domain/print/types";
import {
  asBool,
  asNumber,
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

const DAY_NIGHT: readonly DayNightPreference[] = ["any", "day", "night"];

function toDayNight(value: unknown): DayNightPreference {
  return DAY_NIGHT.includes(value as DayNightPreference) ? (value as DayNightPreference) : "any";
}

const TASK_STATES: readonly PrintTaskState[] = [
  "DRAFT",
  "QUEUED",
  "PLANNED",
  "ASSIGNED",
  "DISPATCHING",
  "PRINTING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "NEEDS_REVIEW"
];

function toState(value: unknown): PrintTaskState {
  return TASK_STATES.includes(value as PrintTaskState) ? (value as PrintTaskState) : "NEEDS_REVIEW";
}

const mapper: RowMapper<PrintTask> = {
  table: "print_tasks",
  entity: "задание",
  columns: [
    "id",
    "artifact_id",
    "title",
    "material",
    "target_printer",
    "priority",
    "state",
    "reason",
    "night",
    "not_before",
    "deadline",
    "day_night_preference",
    "pinned_printer_id",
    "unattended_allowed",
    "created_at",
    "updated_at",
    "version",
    "legacy_ref",
    "metadata"
  ],
  toRow(t): Record<string, SqlValue> {
    return {
      id: t.id,
      artifact_id: t.artifactId,
      title: t.title,
      material: t.material,
      target_printer: t.targetPrinter,
      priority: t.priority,
      state: t.state,
      reason: t.reason,
      night: boolToInt(t.night),
      not_before: t.notBefore,
      deadline: t.deadline,
      day_night_preference: t.dayNightPreference,
      pinned_printer_id: t.pinnedPrinterId,
      unattended_allowed: boolToInt(t.unattendedAllowed),
      created_at: t.createdAt,
      updated_at: t.updatedAt,
      version: t.version,
      legacy_ref: t.legacyRef,
      metadata: metadataToText(t.metadata)
    };
  },
  fromRow(row: Row): PrintTask {
    return {
      id: asString(row.id),
      artifactId: asStringOrNull(row.artifact_id),
      title: asString(row.title),
      material: asStringOrNull(row.material),
      targetPrinter: asStringOrNull(row.target_printer),
      priority: asNumber(row.priority),
      state: toState(row.state),
      reason: asStringOrNull(row.reason),
      night: asBool(row.night),
      notBefore: asStringOrNull(row.not_before),
      deadline: asStringOrNull(row.deadline),
      dayNightPreference: toDayNight(row.day_night_preference),
      pinnedPrinterId: asStringOrNull(row.pinned_printer_id),
      unattendedAllowed: asBool(row.unattended_allowed),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      legacyRef: asStringOrNull(row.legacy_ref),
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqlitePrintTaskRepository
  extends BaseRepository<PrintTask>
  implements PrintTaskRepository
{
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  findByLegacyRef(legacyRef: string): PrintTask | null {
    return this.queryOne("SELECT * FROM print_tasks WHERE legacy_ref = ?", legacyRef);
  }

  findByArtifactId(artifactId: string): PrintTask | null {
    return this.queryOne(
      "SELECT * FROM print_tasks WHERE artifact_id = ? ORDER BY created_at, id LIMIT 1",
      artifactId
    );
  }

  list(query?: TaskQuery): PrintTask[] {
    const states = query?.states;
    if (states && states.length > 0) {
      const placeholders = states.map(() => "?").join(", ");
      return this.query(
        `SELECT * FROM print_tasks WHERE state IN (${placeholders}) ORDER BY created_at, id`,
        ...states
      );
    }
    return this.query("SELECT * FROM print_tasks ORDER BY created_at, id");
  }
}
