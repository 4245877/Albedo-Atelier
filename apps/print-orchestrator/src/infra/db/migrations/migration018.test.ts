import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";

import { DEFAULT_LIGHT_SETTINGS, NO_AUTOMATIC_CONTINUATION, type PrinterRecord } from "../../../domain/printers/config";
import { openDatabase } from "../database";
import { SqlitePrinterRepository } from "../repositories/printerRepository";
import { MIGRATIONS } from "./index";

/*
 * Migration 018 rebuilds `printers` so its protocol CHECK admits `anycubic-lan`.
 *
 * A table rebuild is the one kind of migration that can lose data silently: a
 * column left out of the copy, an index not recreated, or — the trap specific to
 * this table — the `printer_discovery` rows that `DROP TABLE printers` cascades
 * away with foreign keys ON. These tests pin all three against a database built
 * at schema 17, the shape every deployed farm has today.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-migration018-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every migration up to 017 — the schema the production database is at. */
function openAtVersion017(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
  );
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const migration of MIGRATIONS.filter((m) => m.version <= 17)) {
    migration.up(db);
    record.run(migration.version, migration.name, new Date().toISOString());
  }
  return db;
}

const PRINTER_ROWS = [
  // Every column filled, including the credentials and the nullable ones.
  `INSERT INTO printers VALUES ('bambu-a1','Bambu A1','Bambu Lab A1','FDM','a1','bambu','192.168.0.187',8883,
     'PLA',0.4,'hardened_steel',256,256,256,'#efe8d8','','','',1,'','0309CA470100001','\${BAMBU_CODE}',1,
     1,'auto-eject','2026-08-01',NULL,'',0,'','','','','chamber_light',10,
     '2026-08-01T00:00:00.000Z','2026-08-02T00:00:00.000Z',4,'{"note":"seed"}')`,
  `INSERT INTO printers VALUES ('creality-k2','Creality K2','Creality K2','FDM','','moonraker','192.168.0.132',4408,
     'PETG',NULL,'',NULL,NULL,NULL,'','http://go2rtc:1984/api/frame.jpeg?src=k2','http://go2rtc:1984/api/stream.mp4?src=k2',
     'http://192.168.0.132:4408',1,'key-1','','',0,0,'',NULL,1,'LED',1,'','','output_pin LED','value','',20,
     '2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',1,'{}')`,
  `INSERT INTO printers VALUES ('ender3-v3-ke','Ender 3 V3 KE','','FDM','','creality','192.168.0.140',9999,
     '',NULL,'',NULL,NULL,NULL,'','','','',0,'','','',0,0,'',NULL,0,'',0,'','','','','',30,
     '2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',2,'{}')`
];

const DISCOVERY_ROWS = [
  `INSERT INTO printer_discovery VALUES ('bambu-a1','bambu',
     '{"nozzleType":{"value":"hardened_steel","source":"printer","via":"MQTT print.nozzle_type"}}',
     '2026-08-07T10:00:00.000Z',1,NULL,3)`,
  `INSERT INTO printer_discovery VALUES ('creality-k2','moonraker','{}','2026-08-07T10:05:00.000Z',0,'timeout',1)`
];

function rows(db: DatabaseSync, sql: string): unknown[] {
  // Null-prototype rows → plain objects, so deepEqual compares values only.
  return (db.prepare(sql).all() as Record<string, unknown>[]).map((row) => ({ ...row }));
}

test("018 keeps every printer row, column for column, and every discovery row", () => {
  const file = path.join(dir, "farm.db");
  const old = openAtVersion017(file);
  for (const sql of [...PRINTER_ROWS, ...DISCOVERY_ROWS]) old.exec(sql);
  const printersBefore = rows(old, "SELECT * FROM printers ORDER BY id");
  const discoveryBefore = rows(old, "SELECT * FROM printer_discovery ORDER BY id");
  old.close();

  const db = openDatabase(file);
  try {
    assert.deepEqual(rows(db, "SELECT * FROM printers ORDER BY id"), printersBefore);
    assert.deepEqual(
      rows(db, "SELECT * FROM printer_discovery ORDER BY id"),
      discoveryBefore,
      "the discovery rows survive the cascade a bare DROP TABLE would trigger"
    );
    const versions = rows(db, "SELECT version FROM schema_migrations ORDER BY version").map(
      (r) => (r as { version: number }).version
    );
    assert.equal(versions.at(-1), 18);
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_printers_position'").get(),
      "the position index is recreated"
    );
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_018' OR name = 'printers_new'").get(),
      undefined,
      "no scratch table is left behind"
    );
    assert.deepEqual(rows(db, "PRAGMA foreign_key_check"), []);
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    assert.equal(integrity.integrity_check, "ok");
  } finally {
    db.close();
  }
});

test("018 admits anycubic-lan and still refuses a protocol nobody implements", () => {
  const db = openDatabase(path.join(dir, "check.db"));
  try {
    const insert = (id: string, protocol: string) =>
      db
        .prepare(
          "INSERT INTO printers (id, name, protocol, host, created_at, updated_at) VALUES (?, ?, ?, ?, 'now', 'now')"
        )
        .run(id, id, protocol, "192.168.1.60");
    insert("kobra-x", "anycubic-lan");
    assert.throws(() => insert("typo", "anycubic"), /CHECK constraint failed/);
    assert.throws(() => insert("other", "octoprint"), /CHECK constraint failed/);
  } finally {
    db.close();
  }
});

test("after the rebuild, removing a printer still cascades to its discovery row", () => {
  const file = path.join(dir, "cascade.db");
  const old = openAtVersion017(file);
  for (const sql of [...PRINTER_ROWS, ...DISCOVERY_ROWS]) old.exec(sql);
  old.close();

  const db = openDatabase(file);
  try {
    db.prepare("DELETE FROM printers WHERE id = ?").run("bambu-a1");
    assert.equal(db.prepare("SELECT id FROM printer_discovery WHERE id = 'bambu-a1'").get(), undefined);
    assert.ok(db.prepare("SELECT id FROM printer_discovery WHERE id = 'creality-k2'").get());
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO printer_discovery (id, protocol, probed_at) VALUES ('ghost', 'bambu', 'now')")
          .run(),
      /FOREIGN KEY constraint failed/,
      "the discovery FK still points at the rebuilt table"
    );
  } finally {
    db.close();
  }
});

test("an anycubic-lan printer round-trips through the repository unchanged", () => {
  const db = openDatabase(path.join(dir, "repo.db"));
  try {
    const repo = new SqlitePrinterRepository(db);
    const record: PrinterRecord = {
      id: "kobra-x",
      name: "Anycubic Kobra X",
      model: "",
      type: "FDM",
      printerClass: "",
      protocol: "anycubic-lan",
      host: "192.168.1.60",
      port: null,
      material: "PLA",
      nozzleDiameterMm: null,
      nozzleType: "",
      buildVolume: null,
      swatch: "",
      snapshotUrl: "",
      streamUrl: "",
      interfaceUrl: "",
      enabled: true,
      apiKey: "",
      serial: "",
      accessCode: "",
      allowInsecureTls: true,
      automaticContinuation: { ...NO_AUTOMATIC_CONTINUATION },
      light: { ...DEFAULT_LIGHT_SETTINGS },
      position: 40,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
      version: 1,
      metadata: {}
    };
    repo.insert(record);
    assert.deepEqual(repo.getById("kobra-x"), record);
    assert.deepEqual(
      repo.list().map((p) => p.protocol),
      ["anycubic-lan"]
    );
  } finally {
    db.close();
  }
});

test("a row with a protocol this build does not know is an explicit error, never Moonraker", () => {
  const db = openDatabase(path.join(dir, "foreign.db"));
  try {
    // Only reachable by bypassing the CHECK — a database written by something else.
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare(
      "INSERT INTO printers (id, name, protocol, host, created_at, updated_at) VALUES ('alien', 'Alien', 'octoprint', '10.0.0.9', 'now', 'now')"
    ).run();
    db.exec("PRAGMA ignore_check_constraints = OFF");

    const repo = new SqlitePrinterRepository(db);
    assert.throws(() => repo.list(), /неподдерживаемый протокол «octoprint»/);
  } finally {
    db.close();
  }
});
