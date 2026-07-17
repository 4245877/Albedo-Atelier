import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./index";

/**
 * Two additive scheduler safeguards.
 *
 * 1. `material_overrides` — the manual operator assertion "there is enough loaded
 *    filament for the next N hours" that the night gate needs. The farm has **no**
 *    remaining-material telemetry, so without this the night gate can only ever say
 *    "остаток материала неизвестен" and reject every candidate. An override carries
 *    its author and a validity window (`expires_at`), so a stale assertion stops
 *    counting instead of silently keeping a printer eligible forever.
 *
 * 2. A partial unique index enforcing **at most one `ACTIVE` plan** at the storage
 *    layer, backing the confirm-time supersede (a confirmed plan cancels the
 *    previous one). Any pre-existing extra ACTIVE plans (from before that fix) are
 *    superseded here first — keeping the most recently created — so the index can
 *    be created on an already-populated database without failing.
 */
export const migration005: Migration = {
  version: 5,
  name: "005_material_overrides",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE material_overrides (
        id             TEXT PRIMARY KEY,
        printer_id     TEXT NOT NULL,
        sufficient     INTEGER NOT NULL DEFAULT 1,
        coverage_hours REAL,
        note           TEXT,
        author         TEXT,
        created_at     TEXT NOT NULL,
        expires_at     TEXT,
        version        INTEGER NOT NULL,
        metadata       TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_material_overrides_printer
        ON material_overrides (printer_id, created_at);

      -- Supersede any extra pre-existing ACTIVE plans before the unique guard is
      -- added (keep the newest); a no-op on a healthy database.
      UPDATE plans
        SET state = 'CANCELLED',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE state = 'ACTIVE'
          AND id NOT IN (
            SELECT id FROM plans WHERE state = 'ACTIVE'
            ORDER BY created_at DESC, id DESC LIMIT 1
          );

      CREATE UNIQUE INDEX idx_plans_single_active ON plans (state) WHERE state = 'ACTIVE';
    `);
  }
};
