import type { DatabaseSync } from "node:sqlite";

import type {
  OperatorAbsenceRepository,
  OperatorRepository,
  ScheduleExceptionRepository,
  ScheduleRuleRepository
} from "../../../domain/operations/repositories";
import type {
  Operator,
  OperatorAbsence,
  ScheduleException,
  ScheduleExceptionKind,
  ScheduleRule,
  ScheduleTrack,
  Weekday
} from "../../../domain/operations/types";
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

/**
 * SQLite adapters for the operator schedule: the operator roster, the recurring
 * weekly rules, the date exceptions and the absences. Four small tables, one
 * mapper each — every decision lives in `domain/operations/schedule.ts`; these
 * only read and write rows.
 */

function toTrack(value: unknown): ScheduleTrack {
  return value === "sleep" ? "sleep" : "available";
}

function toWeekday(value: unknown): Weekday {
  const n = asNumber(value);
  return (Number.isInteger(n) && n >= 0 && n <= 6 ? n : 0) as Weekday;
}

function toExceptionKind(value: unknown): ScheduleExceptionKind {
  return value === "sleep" || value === "off" ? value : "available";
}

const operatorMapper: RowMapper<Operator> = {
  table: "operators",
  entity: "оператор",
  columns: ["id", "name", "time_zone", "active", "created_at", "updated_at", "version", "metadata"],
  toRow(o): Record<string, SqlValue> {
    return {
      id: o.id,
      name: o.name,
      time_zone: o.timeZone,
      active: boolToInt(o.active),
      created_at: o.createdAt,
      updated_at: o.updatedAt,
      version: o.version,
      metadata: metadataToText(o.metadata)
    };
  },
  fromRow(row: Row): Operator {
    return {
      id: asString(row.id),
      name: asString(row.name),
      timeZone: asStringOrNull(row.time_zone),
      active: asBool(row.active),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteOperatorRepository
  extends BaseRepository<Operator>
  implements OperatorRepository
{
  constructor(db: DatabaseSync) {
    super(db, operatorMapper);
  }

  list(): Operator[] {
    return this.query("SELECT * FROM operators ORDER BY active DESC, name, id");
  }

  listActive(): Operator[] {
    return this.query("SELECT * FROM operators WHERE active = 1 ORDER BY name, id");
  }
}

const ruleMapper: RowMapper<ScheduleRule> = {
  table: "operator_schedule_rules",
  entity: "правило расписания",
  columns: [
    "id",
    "operator_id",
    "track",
    "weekday",
    "start_minutes",
    "end_minutes",
    "created_at",
    "updated_at",
    "version",
    "metadata"
  ],
  toRow(r): Record<string, SqlValue> {
    return {
      id: r.id,
      operator_id: r.operatorId,
      track: r.track,
      weekday: r.weekday,
      start_minutes: r.startMinutes,
      end_minutes: r.endMinutes,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      version: r.version,
      metadata: metadataToText(r.metadata)
    };
  },
  fromRow(row: Row): ScheduleRule {
    return {
      id: asString(row.id),
      operatorId: asString(row.operator_id),
      track: toTrack(row.track),
      weekday: toWeekday(row.weekday),
      startMinutes: asNumber(row.start_minutes),
      endMinutes: asNumber(row.end_minutes),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteScheduleRuleRepository
  extends BaseRepository<ScheduleRule>
  implements ScheduleRuleRepository
{
  constructor(db: DatabaseSync) {
    super(db, ruleMapper);
  }

  listByOperator(operatorId: string): ScheduleRule[] {
    return this.query(
      `SELECT * FROM operator_schedule_rules WHERE operator_id = ?
       ORDER BY weekday, start_minutes, id`,
      operatorId
    );
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM operator_schedule_rules WHERE id = ?").run(id);
  }

  deleteByOperator(operatorId: string): void {
    this.db.prepare("DELETE FROM operator_schedule_rules WHERE operator_id = ?").run(operatorId);
  }
}

const exceptionMapper: RowMapper<ScheduleException> = {
  table: "operator_schedule_exceptions",
  entity: "исключение расписания",
  columns: [
    "id",
    "operator_id",
    "date",
    "kind",
    "start_minutes",
    "end_minutes",
    "note",
    "created_at",
    "updated_at",
    "version",
    "metadata"
  ],
  toRow(e): Record<string, SqlValue> {
    return {
      id: e.id,
      operator_id: e.operatorId,
      date: e.date,
      kind: e.kind,
      start_minutes: e.startMinutes,
      end_minutes: e.endMinutes,
      note: e.note,
      created_at: e.createdAt,
      updated_at: e.updatedAt,
      version: e.version,
      metadata: metadataToText(e.metadata)
    };
  },
  fromRow(row: Row): ScheduleException {
    return {
      id: asString(row.id),
      operatorId: asString(row.operator_id),
      date: asString(row.date),
      kind: toExceptionKind(row.kind),
      startMinutes: asNumberOrNull(row.start_minutes),
      endMinutes: asNumberOrNull(row.end_minutes),
      note: asStringOrNull(row.note),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteScheduleExceptionRepository
  extends BaseRepository<ScheduleException>
  implements ScheduleExceptionRepository
{
  constructor(db: DatabaseSync) {
    super(db, exceptionMapper);
  }

  listByOperator(operatorId: string): ScheduleException[] {
    return this.query(
      "SELECT * FROM operator_schedule_exceptions WHERE operator_id = ? ORDER BY date, id",
      operatorId
    );
  }

  listUpcoming(operatorId: string, fromLocalDate: string): ScheduleException[] {
    return this.query(
      `SELECT * FROM operator_schedule_exceptions
       WHERE operator_id = ? AND date >= ? ORDER BY date, id`,
      operatorId,
      fromLocalDate
    );
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM operator_schedule_exceptions WHERE id = ?").run(id);
  }
}

const absenceMapper: RowMapper<OperatorAbsence> = {
  table: "operator_absences",
  entity: "отсутствие оператора",
  columns: [
    "id",
    "operator_id",
    "starts_at",
    "ends_at",
    "reason",
    "created_at",
    "updated_at",
    "version",
    "metadata"
  ],
  toRow(a): Record<string, SqlValue> {
    return {
      id: a.id,
      operator_id: a.operatorId,
      starts_at: a.startsAt,
      ends_at: a.endsAt,
      reason: a.reason,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
      version: a.version,
      metadata: metadataToText(a.metadata)
    };
  },
  fromRow(row: Row): OperatorAbsence {
    return {
      id: asString(row.id),
      operatorId: asString(row.operator_id),
      startsAt: asString(row.starts_at),
      endsAt: asStringOrNull(row.ends_at),
      reason: asStringOrNull(row.reason),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqliteOperatorAbsenceRepository
  extends BaseRepository<OperatorAbsence>
  implements OperatorAbsenceRepository
{
  constructor(db: DatabaseSync) {
    super(db, absenceMapper);
  }

  listByOperator(operatorId: string): OperatorAbsence[] {
    return this.query(
      "SELECT * FROM operator_absences WHERE operator_id = ? ORDER BY starts_at DESC, id",
      operatorId
    );
  }

  listActiveOrFuture(operatorId: string, nowIso: string): OperatorAbsence[] {
    return this.query(
      `SELECT * FROM operator_absences
       WHERE operator_id = ? AND (ends_at IS NULL OR ends_at > ?)
       ORDER BY starts_at, id`,
      operatorId,
      nowIso
    );
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM operator_absences WHERE id = ?").run(id);
  }
}
