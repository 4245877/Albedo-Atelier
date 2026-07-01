import { nowIso } from "../shared/time";

export interface OutboxMessage<TPayload = unknown> {
  id: string;
  type: string;
  payload: TPayload;
  createdAt: string;
}

export function createOutboxMessage<TPayload>(
  id: string,
  type: string,
  payload: TPayload
): OutboxMessage<TPayload> {
  return {
    id,
    type,
    payload,
    createdAt: nowIso()
  };
}
