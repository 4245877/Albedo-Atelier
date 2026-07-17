import type { DatabaseSync } from "node:sqlite";

import type { AppMetaRepository } from "../../../domain/print/repositories";

/**
 * A tiny key/value side-table for operational markers (currently just the
 * legacy-import guard). Upserts on write; returns null for a missing key.
 */
export class SqliteAppMetaRepository implements AppMetaRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }
}
