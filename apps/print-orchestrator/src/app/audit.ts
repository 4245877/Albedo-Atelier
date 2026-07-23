import { ID_PREFIX, newId } from "../domain/print/ids";
import type { PrintQueueStore } from "../domain/print/repositories";
import type { AuditEntityType, Metadata } from "../domain/print/types";

/** One audit fact: who did what to which entity, with optional state move. */
export interface AuditInput {
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  from?: string;
  to?: string;
  actor?: string;
  detail?: Metadata;
}

/**
 * Appends an {@link AuditEvent} row — the one shared implementation behind
 * every service's `recordAudit`. Callers run it inside their own transaction
 * (the insert is just another write on the shared connection), so an audit row
 * commits or rolls back together with the change it describes.
 */
export function recordAuditEvent(
  store: PrintQueueStore,
  nowIso: () => string,
  defaultActor: string,
  input: AuditInput
): void {
  store.repositories.audit.insert({
    id: newId(ID_PREFIX.auditEvent),
    at: nowIso(),
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    fromState: input.from ?? null,
    toState: input.to ?? null,
    actor: input.actor ?? defaultActor,
    detail: input.detail ?? {}
  });
}
