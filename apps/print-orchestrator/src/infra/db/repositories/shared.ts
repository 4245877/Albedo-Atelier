import type { DatabaseSync } from "node:sqlite";

import { NotFoundError, VersionConflictError } from "../../../core/errors";
import type { AnalysisFinding, Metadata } from "../../../domain/print/types";

/**
 * Shared plumbing for the SQLite repository adapters.
 *
 * Everything the domain repositories have in common — column↔field coercion, a
 * JSON metadata column, and the optimistic-concurrency `insert`/`update`/
 * `getById` trio — lives here so each entity repository is just its schema
 * mapping plus a handful of query methods, with no `any` and no copy-pasted
 * version-check logic.
 */

/** The value types `node:sqlite` accepts as a bound parameter / returns as a cell. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** A raw result row: column name → cell value (null-prototype object from the driver). */
export type Row = Record<string, unknown>;

// ── Cell coercion (row → field) ──────────────────────────────────────────────

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

export function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

/** SQLite has no boolean type: 0/1 INTEGER ↔ boolean. */
export function asBool(value: unknown): boolean {
  return value === 1 || value === 1n || value === true;
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

/** Parses a JSON metadata column; anything unusable degrades to `{}` (never throws). */
export function parseMetadata(value: unknown): Metadata {
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Metadata)
      : {};
  } catch {
    return {};
  }
}

export function metadataToText(value: Metadata): string {
  return JSON.stringify(value ?? {});
}

/**
 * Like {@link parseMetadata} but preserves the SQL NULL / absent distinction: a
 * null/empty cell reads back as `null` (not `{}`), so a column that means "no value
 * recorded yet" (e.g. slice dimensions before a slice runs) round-trips faithfully.
 */
export function parseMetadataOrNull(value: unknown): Metadata | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Metadata)
      : null;
  } catch {
    return null;
  }
}

/** Serialises a nullable metadata object; `null`/`undefined` stays SQL NULL. */
export function metadataToTextOrNull(value: Metadata | null | undefined): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * Parses a JSON array of {@link AnalysisFinding} (the `warnings`/`blockers`
 * columns); anything unusable — bad JSON, non-array, malformed entries —
 * degrades to `[]` so a corrupt cell never throws mid-read. Each entry is
 * narrowed to `{ code, message }`.
 */
export function parseFindings(value: unknown): AnalysisFinding[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): AnalysisFinding[] => {
      if (item !== null && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const code = typeof record.code === "string" ? record.code : "";
        const message = typeof record.message === "string" ? record.message : "";
        if (code || message) return [{ code, message }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export function findingsToText(value: readonly AnalysisFinding[]): string {
  return JSON.stringify(value ?? []);
}

// ── Base repository (insert / getById / optimistic update) ───────────────────

/**
 * Describes how one entity maps to its table: the column order used for
 * INSERT/UPDATE, and the two pure conversions between the entity and a row.
 * `toRow` must return one {@link SqlValue} per column in `columns` order.
 */
export interface RowMapper<T> {
  table: string;
  /** Human label used in error messages ("задание", "назначение", …). */
  entity: string;
  /** Every column, `id` first, in a fixed order shared by insert and update. */
  columns: readonly string[];
  toRow(entity: T): Record<string, SqlValue>;
  fromRow(row: Row): T;
}

/**
 * Base adapter implementing the {@link file://../../../domain/print/repositories.ts
 * WritableRepository} contract over a {@link RowMapper}. Subclasses add only
 * their entity-specific queries.
 */
export abstract class BaseRepository<T extends { id: string; version: number }> {
  constructor(
    protected readonly db: DatabaseSync,
    protected readonly mapper: RowMapper<T>
  ) {}

  insert(entity: T): T {
    const { table, columns } = this.mapper;
    const row = this.mapper.toRow(entity);
    const placeholders = columns.map(() => "?").join(", ");
    const stmt = this.db.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
    );
    stmt.run(...columns.map((col) => requireValue(row, col)));
    return entity;
  }

  getById(id: string): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.mapper.table} WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? this.mapper.fromRow(row) : null;
  }

  /**
   * Optimistic update: writes only when the stored `version` still equals
   * `entity.version`, bumping it to `version + 1`. A zero-row result is
   * disambiguated into a {@link NotFoundError} (row gone) or a
   * {@link VersionConflictError} (someone wrote first). Returns the persisted
   * row (with the bumped version) so the caller can chain further writes.
   */
  update(entity: T): T {
    const { table, columns, entity: label } = this.mapper;
    const next = { ...entity, version: entity.version + 1 } as T;
    const row = this.mapper.toRow(next);
    const setColumns = columns.filter((col) => col !== "id");
    const assignments = setColumns.map((col) => `${col} = ?`).join(", ");
    const stmt = this.db.prepare(
      `UPDATE ${table} SET ${assignments} WHERE id = ? AND version = ?`
    );
    const result = stmt.run(
      ...setColumns.map((col) => requireValue(row, col)),
      entity.id,
      entity.version
    );

    if (result.changes === 0) {
      const exists = this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(entity.id);
      if (!exists) throw new NotFoundError(`${label} «${entity.id}»`);
      throw new VersionConflictError(label, entity.id, entity.version);
    }
    return next;
  }

  /** Runs a prepared SELECT and maps every row through the entity mapper. */
  protected query(sql: string, ...params: SqlValue[]): T[] {
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map((row) => this.mapper.fromRow(row));
  }

  /** Runs a prepared SELECT for a single row, mapped, or null. */
  protected queryOne(sql: string, ...params: SqlValue[]): T | null {
    const row = this.db.prepare(sql).get(...params) as Row | undefined;
    return row ? this.mapper.fromRow(row) : null;
  }
}

/**
 * Guards against a mapper that forgot a column: `node:sqlite` throws on
 * `undefined` params anyway, but this points at the offending column instead of
 * a generic bind error.
 */
function requireValue(row: Record<string, SqlValue>, column: string): SqlValue {
  const value = row[column];
  if (value === undefined) {
    throw new Error(`Row mapper produced no value for column "${column}"`);
  }
  return value;
}
