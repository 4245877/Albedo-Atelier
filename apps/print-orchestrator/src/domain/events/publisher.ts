import type { DomainEvent } from "./types";

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export class NoopEventPublisher implements EventPublisher {
  async publish(_event: DomainEvent): Promise<void> {
    return undefined;
  }
}
