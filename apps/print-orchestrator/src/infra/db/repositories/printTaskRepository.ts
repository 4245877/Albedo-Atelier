import type { DatabaseSync } from "node:sqlite";

import type {
  FinishedTaskQuery,
  PrintTaskRepository,
  TaskQuery
} from "../../../domain/print/repositories";
import type { DayNightPreference, PrintTask, PrintTaskState } from "../../../domain/print/types";
import { PREPARABLE_TASK_STATES } from "../../../domain/print/draftTask";
import { FINISHED_TASK_STATES } from "../../../domain/print/reprint";
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
    "slice_variant_id",
    "source_artifact_id",
    "on_device_file",
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
      slice_variant_id: t.sliceVariantId,
      source_artifact_id: t.sourceArtifactId,
      on_device_file: t.onDeviceFile,
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
      sliceVariantId: asStringOrNull(row.slice_variant_id),
      sourceArtifactId: asStringOrNull(row.source_artifact_id),
      onDeviceFile: asStringOrNull(row.on_device_file),
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

  findPreparableBySource(sourceArtifactId: string): PrintTask | null {
    // The newest task whose executable IS the source model and that can still
    // take a slice — the one a new slice belongs to. A task promoted onto its
    // slice has moved `artifact_id` to the output and is no longer this source's
    // preparation. Newest by insertion order: ids are random, and two drafts
    // created within one clock tick must not be told apart by chance.
    const states = PREPARABLE_TASK_STATES;
    return this.queryOne(
      `SELECT * FROM print_tasks
        WHERE artifact_id = ? AND state IN (${states.map(() => "?").join(",")})
        ORDER BY rowid DESC LIMIT 1`,
      sourceArtifactId,
      ...states
    );
  }

  findLatestReferencing(artifactId: string): PrintTask | null {
    return this.queryOne(
      `SELECT * FROM print_tasks
        WHERE artifact_id = ? OR source_artifact_id = ?
        ORDER BY rowid DESC LIMIT 1`,
      artifactId,
      artifactId
    );
  }

  listBySliceVariant(sliceVariantId: string): PrintTask[] {
    return this.query("SELECT * FROM print_tasks WHERE slice_variant_id = ? ORDER BY rowid", sliceVariantId);
  }

  listReferencingArtifact(artifactId: string): PrintTask[] {
    return this.query(
      `SELECT * FROM print_tasks
        WHERE artifact_id = ? OR source_artifact_id = ?
        ORDER BY created_at, id`,
      artifactId,
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

  listFinished(query: FinishedTaskQuery): PrintTask[] {
    const states = query.states && query.states.length > 0 ? query.states : FINISHED_TASK_STATES;
    const where = [`t.state IN (${states.map(() => "?").join(", ")})`];
    const params: SqlValue[] = [...states];
    // A print is something that entered the queue or reached a printer; an
    // upload's draft cancelled together with its file was neither.
    where.push(
      `(EXISTS (SELECT 1 FROM queue_entries q WHERE q.task_id = t.id)
        OR EXISTS (SELECT 1 FROM print_runs r WHERE r.task_id = t.id))`
    );
    if (query.printerId) {
      where.push("EXISTS (SELECT 1 FROM print_runs p WHERE p.task_id = t.id AND p.printer_id = ?)");
      params.push(query.printerId);
    }
    if (query.before) {
      where.push("(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))");
      params.push(query.before.updatedAt, query.before.updatedAt, query.before.id);
    }
    params.push(Math.max(1, Math.floor(query.limit)));
    return this.query(
      `SELECT t.* FROM print_tasks t
        WHERE ${where.join(" AND ")}
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT ?`,
      ...params
    );
  }
}
