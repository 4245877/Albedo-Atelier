import type { DatabaseSync } from "node:sqlite";

import type { PlanRepository } from "../../../domain/print/repositories";
import type { Plan, PlanState } from "../../../domain/print/types";
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

const PLAN_STATES: readonly PlanState[] = ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"];

function toState(value: unknown): PlanState {
  return PLAN_STATES.includes(value as PlanState) ? (value as PlanState) : "DRAFT";
}

const mapper: RowMapper<Plan> = {
  table: "plans",
  entity: "план",
  columns: ["id", "name", "window", "state", "created_at", "updated_at", "version", "metadata"],
  toRow(p): Record<string, SqlValue> {
    return {
      id: p.id,
      name: p.name,
      window: p.window,
      state: p.state,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      version: p.version,
      metadata: metadataToText(p.metadata)
    };
  },
  fromRow(row: Row): Plan {
    return {
      id: asString(row.id),
      name: asStringOrNull(row.name),
      window: asStringOrNull(row.window),
      state: toState(row.state),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqlitePlanRepository extends BaseRepository<Plan> implements PlanRepository {
  constructor(db: DatabaseSync) {
    super(db, mapper);
  }

  list(): Plan[] {
    return this.query("SELECT * FROM plans ORDER BY created_at, id");
  }
}
