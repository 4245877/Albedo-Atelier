import type { DomainEvent } from "../../domain/events/types";

const events: DomainEvent[] = [];

export async function listEventRecords(): Promise<DomainEvent[]> {
  return [...events];
}
