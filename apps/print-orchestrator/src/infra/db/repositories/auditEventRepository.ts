import type { DatabaseSync } from "node:sqlite";

import type { AuditEventRepository } from "../../../domain/print/repositories";
import type { AuditEntityType, AuditEvent } from "../../../domain/print/types";
import {
  asString,
  asStringOrNull,
  metadataToText,
  parseMetadata,
  type Row
} from "./shared";

const DEFAULT_LIMIT = 200;

function fromRow(row: Row): AuditEvent {
  return {
    id: asString(row.id),
    at: asString(row.at),
    entityType: asString(row.entity_type) as AuditEntityType,
    entityId: asString(row.entity_id),
    action: asString(row.action),
    fromState: asStringOrNull(row.from_state),
    toState: asStringOrNull(row.to_state),
    actor: asStringOrNull(row.actor),
    detail: parseMetadata(row.detail)
  };
}

/**
 * Append-only audit log. No `update`, no optimistic version — an audit row is
 * written once and never touched again, which is the whole point of an audit
 * trail. Reads are newest-first.
 */
export class SqliteAuditEventRepository implements AuditEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(event: AuditEvent): AuditEvent {
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, at, entity_type, entity_id, action, from_state, to_state, actor, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.at,
        event.entityType,
        event.entityId,
        event.action,
        event.fromState,
        event.toState,
        event.actor,
        metadataToText(event.detail)
      );
    return event;
  }

  list(limit = DEFAULT_LIMIT): AuditEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_events ORDER BY at DESC, rowid DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(fromRow);
  }

  listByEntity(entityType: AuditEntityType, entityId: string): AuditEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM audit_events WHERE entity_type = ? AND entity_id = ? ORDER BY at, rowid"
      )
      .all(entityType, entityId) as Row[];
    return rows.map(fromRow);
  }
}
