import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * The printer configuration itself moves into the database.
 *
 * Until now a printer was described by `config/printers.json`, a file baked into
 * the image and bind-mounted read-only — so rotating a Bambu LAN access code
 * meant editing a file in the repository, rebuilding and redeploying. This table
 * makes the farm's own database the source of truth, which is what lets the
 * dashboard add, edit and re-credential a printer at runtime.
 *
 * Shape notes:
 *
 *  - the **id stays the operator's slug** (`bambu-a1-combo`), not a generated
 *    id: it is already the key of every snapshot directory, API path and
 *    `printer_id` reference in the queue, and re-keying those is a migration
 *    this feature does not need;
 *  - strings are stored **verbatim**, `${ENV_VAR}` references included. They are
 *    expanded when the row is materialized (`infra/printers/materialize.ts`), so
 *    a config imported from the old file keeps resolving its secrets from `.env`
 *    while anything typed into the UI is stored literally;
 *  - `light_enabled` is nullable on purpose: NULL means the operator never
 *    stated a preference and the protocol default applies. A stored 0/1 is a
 *    decision and always wins;
 *  - `auto_continuation_*` keeps the "allowed **and** physically verified" pair
 *    together, so the fail-closed rule in `automaticContinuationEnabled` reads
 *    both halves from one row.
 *
 * The table starts **empty**: the one-time import in `infra/db/printersImport.ts`
 * seeds it from the existing file/env config on the first boot. An empty table is
 * therefore "not imported yet or genuinely no printers", never "we invented one".
 *
 * The credentials in this table (`api_key`, `serial`, `access_code`) are stored
 * as-is, exactly like the JSON file they replace — the database file inherits the
 * same protection the config file had, and the API never returns them.
 */
export const migration012: Migration = {
  version: 12,
  name: "012_printers",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE printers (
        id                            TEXT PRIMARY KEY,
        name                          TEXT NOT NULL,
        model                         TEXT NOT NULL DEFAULT '',
        type                          TEXT NOT NULL DEFAULT 'FDM'
                                        CHECK (type IN ('FDM','Resin')),
        printer_class                 TEXT NOT NULL DEFAULT '',

        protocol                      TEXT NOT NULL
                                        CHECK (protocol IN ('moonraker','bambu','creality')),
        host                          TEXT NOT NULL,
        port                          INTEGER,

        material                      TEXT NOT NULL DEFAULT '',
        nozzle_diameter_mm            REAL,
        nozzle_type                   TEXT NOT NULL DEFAULT '',
        build_volume_x                REAL,
        build_volume_y                REAL,
        build_volume_z                REAL,
        swatch                        TEXT NOT NULL DEFAULT '',
        snapshot_url                  TEXT NOT NULL DEFAULT '',
        stream_url                    TEXT NOT NULL DEFAULT '',
        interface_url                 TEXT NOT NULL DEFAULT '',

        enabled                       INTEGER NOT NULL DEFAULT 1,

        api_key                       TEXT NOT NULL DEFAULT '',
        serial                        TEXT NOT NULL DEFAULT '',
        access_code                   TEXT NOT NULL DEFAULT '',
        allow_insecure_tls            INTEGER NOT NULL DEFAULT 0,

        auto_continuation_allowed     INTEGER NOT NULL DEFAULT 0,
        auto_continuation_mechanism   TEXT NOT NULL DEFAULT '',
        auto_continuation_verified_at TEXT,

        light_enabled                 INTEGER,
        light_pin                     TEXT NOT NULL DEFAULT '',
        light_invert                  INTEGER NOT NULL DEFAULT 0,
        light_on_gcode                TEXT NOT NULL DEFAULT '',
        light_off_gcode               TEXT NOT NULL DEFAULT '',
        light_status_object           TEXT NOT NULL DEFAULT '',
        light_status_field            TEXT NOT NULL DEFAULT '',
        light_bambu_node              TEXT NOT NULL DEFAULT '',

        position                      INTEGER NOT NULL DEFAULT 0,
        created_at                    TEXT NOT NULL,
        updated_at                    TEXT NOT NULL,
        version                       INTEGER NOT NULL DEFAULT 1,
        metadata                      TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX idx_printers_position ON printers (position, id);
    `);
  }
};
