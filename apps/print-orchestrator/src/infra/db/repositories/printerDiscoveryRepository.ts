import type { DatabaseSync } from "node:sqlite";

import {
  parseDiscoveredFacts,
  type PrinterDiscoveryRecord,
  type PrinterDiscoveryRepository
} from "../../../domain/printers/discovery";
import {
  asBool,
  asString,
  asStringOrNull,
  asNumberOrNull,
  BaseRepository,
  boolToInt,
  type Row,
  type RowMapper,
  type SqlValue
} from "./shared";

/**
 * SQLite adapter for discovery results (migration 013). The `facts` column is
 * JSON parsed schema-on-read, so a blob written by an older build degrades to
 * "that fact is unknown" instead of failing the read — see
 * `domain/printers/discovery.ts`.
 */

const discoveryMapper: RowMapper<PrinterDiscoveryRecord> = {
  table: "printer_discovery",
  entity: "результат опроса принтера",
  columns: ["id", "protocol", "facts", "probed_at", "succeeded", "error", "version"],
  toRow(record): Record<string, SqlValue> {
    return {
      id: record.id,
      protocol: record.protocol,
      facts: JSON.stringify(record.facts ?? {}),
      probed_at: record.probedAt,
      succeeded: boolToInt(record.succeeded),
      error: record.error,
      version: record.version
    };
  },
  fromRow(row: Row): PrinterDiscoveryRecord {
    return {
      id: asString(row.id),
      // Verbatim: an unknown value only means another adapter probed last; the
      // next probe rewrites it. It is never read as a protocol to talk to.
      protocol: asString(row.protocol),
      facts: parseDiscoveredFacts(row.facts),
      probedAt: asString(row.probed_at),
      succeeded: asBool(row.succeeded),
      error: asStringOrNull(row.error),
      version: asNumberOrNull(row.version) ?? 1
    };
  }
};

export class SqlitePrinterDiscoveryRepository
  extends BaseRepository<PrinterDiscoveryRecord>
  implements PrinterDiscoveryRepository
{
  constructor(db: DatabaseSync) {
    super(db, discoveryMapper);
  }

  list(): PrinterDiscoveryRecord[] {
    return this.query("SELECT * FROM printer_discovery");
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM printer_discovery WHERE id = ?").run(id);
  }
}
