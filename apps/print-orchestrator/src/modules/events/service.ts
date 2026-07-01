import type { DomainEvent } from "../../domain/events/types";
import { listEventRecords } from "./repo";

export async function listEvents(): Promise<DomainEvent[]> {
  return listEventRecords();
}
