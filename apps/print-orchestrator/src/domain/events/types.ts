export interface DomainEvent<TPayload = unknown> {
  id: string;
  type: string;
  payload: TPayload;
  occurredAt: string;
}
