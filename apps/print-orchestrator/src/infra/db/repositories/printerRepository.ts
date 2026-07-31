import type { DatabaseSync } from "node:sqlite";

import {
  NO_AUTOMATIC_CONTINUATION,
  type PrinterProtocol,
  type PrinterRecord
} from "../../../domain/printers/config";
import type { PrinterRepository } from "../../../domain/printers/repositories";
import type { PrinterTechnology } from "../../../domain/printers/types";
import {
  asBool,
  asNumber,
  asNumberOrNull,
  asString,
  BaseRepository,
  boolToInt,
  metadataToText,
  parseMetadata,
  type Row,
  type RowMapper,
  type SqlValue
} from "./shared";

/**
 * SQLite adapter for the printer configuration (migration 012). Values are
 * stored verbatim; `${ENV}` expansion and light defaults belong to
 * `infra/printers/materialize.ts`, so a row round-trips unchanged.
 */

function toProtocol(value: unknown): PrinterProtocol {
  return value === "bambu" || value === "creality" ? value : "moonraker";
}

function toTechnology(value: unknown): PrinterTechnology {
  return value === "Resin" ? "Resin" : "FDM";
}

/** SQLite has no boolean: NULL stays "not stated", 0/1 is an explicit choice. */
function asBoolOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return asBool(value);
}

function boolToIntOrNull(value: boolean | null): number | null {
  return value === null ? null : boolToInt(value);
}

const printerMapper: RowMapper<PrinterRecord> = {
  table: "printers",
  entity: "принтер",
  columns: [
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
  ],
  toRow(p): Record<string, SqlValue> {
    return {
      id: p.id,
      name: p.name,
      model: p.model,
      type: p.type,
      printer_class: p.printerClass,
      protocol: p.protocol,
      host: p.host,
      port: p.port,
      material: p.material,
      nozzle_diameter_mm: p.nozzleDiameterMm,
      nozzle_type: p.nozzleType,
      build_volume_x: p.buildVolume?.x ?? null,
      build_volume_y: p.buildVolume?.y ?? null,
      build_volume_z: p.buildVolume?.z ?? null,
      swatch: p.swatch,
      snapshot_url: p.snapshotUrl,
      stream_url: p.streamUrl,
      interface_url: p.interfaceUrl,
      enabled: boolToInt(p.enabled),
      api_key: p.apiKey,
      serial: p.serial,
      access_code: p.accessCode,
      allow_insecure_tls: boolToInt(p.allowInsecureTls),
      auto_continuation_allowed: boolToInt(p.automaticContinuation.allowed),
      auto_continuation_mechanism: p.automaticContinuation.mechanism,
      auto_continuation_verified_at: p.automaticContinuation.verifiedAt,
      light_enabled: boolToIntOrNull(p.light.enabled),
      light_pin: p.light.pin,
      light_invert: boolToInt(p.light.invert),
      light_on_gcode: p.light.onGcode,
      light_off_gcode: p.light.offGcode,
      light_status_object: p.light.statusObject,
      light_status_field: p.light.statusField,
      light_bambu_node: p.light.bambuNode,
      position: p.position,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      version: p.version,
      metadata: metadataToText(p.metadata)
    };
  },
  fromRow(row: Row): PrinterRecord {
    const x = asNumberOrNull(row.build_volume_x);
    const y = asNumberOrNull(row.build_volume_y);
    const z = asNumberOrNull(row.build_volume_z);
    return {
      id: asString(row.id),
      name: asString(row.name),
      model: asString(row.model),
      type: toTechnology(row.type),
      printerClass: asString(row.printer_class),
      protocol: toProtocol(row.protocol),
      host: asString(row.host),
      port: asNumberOrNull(row.port),
      material: asString(row.material),
      nozzleDiameterMm: asNumberOrNull(row.nozzle_diameter_mm),
      nozzleType: asString(row.nozzle_type),
      // A half-written volume is not a volume: all three axes or nothing.
      buildVolume: x !== null && y !== null && z !== null ? { x, y, z } : null,
      swatch: asString(row.swatch),
      snapshotUrl: asString(row.snapshot_url),
      streamUrl: asString(row.stream_url),
      interfaceUrl: asString(row.interface_url),
      enabled: asBool(row.enabled),
      apiKey: asString(row.api_key),
      serial: asString(row.serial),
      accessCode: asString(row.access_code),
      allowInsecureTls: asBool(row.allow_insecure_tls),
      automaticContinuation: {
        ...NO_AUTOMATIC_CONTINUATION,
        allowed: asBool(row.auto_continuation_allowed),
        mechanism: asString(row.auto_continuation_mechanism),
        verifiedAt:
          typeof row.auto_continuation_verified_at === "string"
            ? row.auto_continuation_verified_at
            : null
      },
      light: {
        enabled: asBoolOrNull(row.light_enabled),
        pin: asString(row.light_pin),
        invert: asBool(row.light_invert),
        onGcode: asString(row.light_on_gcode),
        offGcode: asString(row.light_off_gcode),
        statusObject: asString(row.light_status_object),
        statusField: asString(row.light_status_field),
        bambuNode: asString(row.light_bambu_node)
      },
      position: asNumber(row.position),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      version: asNumberOrNull(row.version) ?? 1,
      metadata: parseMetadata(row.metadata)
    };
  }
};

export class SqlitePrinterRepository
  extends BaseRepository<PrinterRecord>
  implements PrinterRepository
{
  constructor(db: DatabaseSync) {
    super(db, printerMapper);
  }

  list(): PrinterRecord[] {
    return this.query("SELECT * FROM printers ORDER BY position, id");
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM printers WHERE id = ?").run(id);
  }

  maxPosition(): number {
    const row = this.db.prepare("SELECT MAX(position) AS max FROM printers").get() as
      | { max: unknown }
      | undefined;
    return asNumberOrNull(row?.max) ?? 0;
  }
}
