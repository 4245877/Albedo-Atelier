import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * What each printer told the farm about itself.
 *
 * The service already read a few hardware facts off the wire — Bambu's
 * `nozzle_diameter`/`nozzle_type`, Klipper's configured nozzle — but only into
 * the live status, which is rebuilt every poll and thrown away. So the hardware
 * card, which is the one place an operator looks up a printer's specification,
 * knew nothing but what a human had typed into it. This table is the missing
 * half: the device's own answer, kept.
 *
 * Shape notes:
 *
 *  - **one row per printer**, `id` being the printer's id and a foreign key onto
 *    it. This is a 1:1 extension of `printers`, not a log — only the current
 *    answer matters, and `ON DELETE CASCADE` means removing a printer takes its
 *    discovery with it;
 *  - **kept out of `printers`** on purpose. A background probe writes here every
 *    few minutes; had it written to `printers`, every probe would bump that
 *    row's `version` and collide with an operator editing the same record
 *    through the optimistic-locking `update` — a rewrite of the card's settings
 *    losing to a nozzle re-read. Separate table, separate version counter, no
 *    contention;
 *  - **`facts` is JSON**, parsed schema-on-read by
 *    `domain/printers/discovery.ts`. The set of learnable characteristics grows
 *    with each protocol we teach the service, and a column per fact would mean a
 *    migration per field — while the values are only ever written whole by a
 *    probe and never queried by SQL;
 *  - **`succeeded` is separate from the facts.** A probe that could not reach
 *    the device records the failure but leaves the last known facts in place: a
 *    printer that is briefly offline has not changed its bed size, and blanking
 *    the card would lose real information over a transient network blip.
 *
 * Nothing here is operator-editable. The manual values stay in `printers`; which
 * of the two wins is decided in `domain/printers/specs.ts`, not by this schema.
 */
export const migration013: Migration = {
  version: 13,
  name: "013_printer_discovery",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE printer_discovery (
        id         TEXT PRIMARY KEY REFERENCES printers(id) ON DELETE CASCADE,
        protocol   TEXT NOT NULL,
        facts      TEXT NOT NULL DEFAULT '{}',
        probed_at  TEXT NOT NULL,
        succeeded  INTEGER NOT NULL DEFAULT 0,
        error      TEXT,
        version    INTEGER NOT NULL DEFAULT 1
      );
    `);
  }
};
