import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./types";

/**
 * `printers.protocol` admits `anycubic-lan` — the Anycubic LAN-mode adapter.
 *
 * SQLite cannot edit a CHECK constraint in place, so the table is rebuilt the way
 * 010 rebuilt `device_artifacts`: create the new shape, copy every row verbatim,
 * drop, rename, recreate the index. Columns, types, defaults and every other
 * constraint are exactly migration 012's; only the protocol list grows.
 *
 * One thing 010 did not have to handle: `printer_discovery.id` REFERENCES
 * `printers(id)` ON DELETE CASCADE, and the connection runs with foreign keys ON.
 * A migration cannot switch them off — the runner wraps it in a transaction,
 * where `PRAGMA foreign_keys` is a no-op — so `DROP TABLE printers` performs an
 * implicit DELETE that would cascade every discovery row away. Those rows are
 * parked in a scratch table first and put back once the new `printers` exists
 * under its final name; `PRAGMA foreign_key_check` then proves nothing dangles.
 *
 * Lossless by construction: ids, every column value, the position index and the
 * discovery rows survive unchanged. Nothing else references `printers` by FK —
 * queue history refers to printer ids by value and is not touched.
 */
export const migration018: Migration = {
  version: 18,
  name: "018_anycubic_lan",
  up(db: DatabaseSync): void {
    const columns = PRINTER_COLUMNS.join(", ");
    db.exec(`
      CREATE TABLE printer_discovery_018 AS SELECT * FROM printer_discovery;

      CREATE TABLE printers_new (
        id                            TEXT PRIMARY KEY,
        name                          TEXT NOT NULL,
        model                         TEXT NOT NULL DEFAULT '',
        type                          TEXT NOT NULL DEFAULT 'FDM'
                                        CHECK (type IN ('FDM','Resin')),
        printer_class                 TEXT NOT NULL DEFAULT '',

        protocol                      TEXT NOT NULL
                                        CHECK (protocol IN ('moonraker','bambu','creality','anycubic-lan')),
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

      INSERT INTO printers_new (${columns}) SELECT ${columns} FROM printers;

      DROP TABLE printers;
      ALTER TABLE printers_new RENAME TO printers;

      CREATE INDEX idx_printers_position ON printers (position, id);

      INSERT INTO printer_discovery (id, protocol, facts, probed_at, succeeded, error, version)
        SELECT id, protocol, facts, probed_at, succeeded, error, version FROM printer_discovery_018;
      DROP TABLE printer_discovery_018;
    `);

    const dangling = db.prepare("PRAGMA foreign_key_check").all();
    if (dangling.length > 0) {
      // Thrown inside the runner's transaction: the whole rebuild rolls back and
      // the database stays exactly at schema 17.
      throw new Error(`018_anycubic_lan: нарушены внешние ключи после пересборки printers (${dangling.length})`);
    }
  }
};

/** Every column of `printers`, in migration 012's order — copied verbatim. */
const PRINTER_COLUMNS = [
  "id",
  "name",
  "model",
  "type",
  "printer_class",
  "protocol",
  "host",
  "port",
  "material",
  "nozzle_diameter_mm",
  "nozzle_type",
  "build_volume_x",
  "build_volume_y",
  "build_volume_z",
  "swatch",
  "snapshot_url",
  "stream_url",
  "interface_url",
  "enabled",
  "api_key",
  "serial",
  "access_code",
  "allow_insecure_tls",
  "auto_continuation_allowed",
  "auto_continuation_mechanism",
  "auto_continuation_verified_at",
  "light_enabled",
  "light_pin",
  "light_invert",
  "light_on_gcode",
  "light_off_gcode",
  "light_status_object",
  "light_status_field",
  "light_bambu_node",
  "position",
  "created_at",
  "updated_at",
  "version",
  "metadata"
] as const;
