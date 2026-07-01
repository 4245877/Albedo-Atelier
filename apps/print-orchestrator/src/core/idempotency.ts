export interface IdempotencyRecord {
  key: string;
  scope: string;
  createdAt: string;
}

export function createIdempotencyKey(scope: string, id: string): string {
  return `${scope}:${id}`;
}
