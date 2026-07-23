import type { DatabaseSync } from "node:sqlite";

/**
 * One forward-only schema migration. `up` receives the open connection and runs
 * inside a transaction the runner opens for it, so a migration that throws
 * half-way leaves the schema untouched.
 *
 * Lives in its own module (not `index.ts`) so each migration file can import
 * the type without importing the registry that imports it back — the
 * `index ↔ 00N_*` type-only cycle is broken here.
 */
export interface Migration {
  /** Strictly increasing, unique across the registry. */
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}
