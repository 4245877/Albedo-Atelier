import { createHash } from "node:crypto";

import type { PrinterRecord } from "./config";
import type { PrinterProtocol } from "./config";
import type { PrinterTechnology } from "./types";

/**
 * The **printer inventory contract** — what the farm is made of, published for
 * other services (today: apps/fulfillment) to consume read-only.
 *
 * It is deliberately a third view of a printer, next to the two that already
 * exist, because they answer different questions:
 *
 *  - `PrinterConfigView` (`/api/printers/config`) is the *admin* surface: it
 *    carries connection parameters and credential status because an operator is
 *    editing them. No other service should read it — a consumer that only needs
 *    "which printers exist and what are they" would then be one field away from
 *    holding the farm's wiring;
 *  - `PrinterView` (`/api/printers`) is *live state*: it exists only for enabled
 *    printers, it is empty until the first poll, and it changes every 10 s.
 *    Reading configuration out of it conflates "configured" with "answering";
 *  - this one is *configuration only*: stable between operator edits, includes
 *    DISABLED printers (with `enabled: false`, so a consumer can tell «отключён»
 *    from «удалён»), and contains no host, port, credential or camera URL.
 *
 * `revision` is a fingerprint over (id, version) of every printer, so a consumer
 * can cheaply detect that the *set* changed — including a deletion, which no
 * per-record `updatedAt` can show.
 */
export interface PrinterInventoryEntry {
  /** Permanent identifier — immutable by design; see PrinterConfigService.update. */
  id: string;
  name: string;
  model: string | null;
  type: PrinterTechnology;
  /** Interchangeability class for class-scoped slice variants; null = none. */
  printerClass: string | null;
  /** Device dialect. Not an address — it tells a consumer what the printer *is*. */
  protocol: PrinterProtocol;
  /** Whether the farm currently uses this printer at all. */
  enabled: boolean;
  /** Operator-facing ordering; consumers should sort by it, then by id. */
  position: number;
  /** Declared loaded material (configuration, NOT live telemetry). */
  material: string | null;
  /** UI colour for the material chip. */
  swatch: string | null;
  nozzleDiameterMm: number | null;
  nozzleType: string | null;
  buildVolume: { x: number; y: number; z: number } | null;
  createdAt: string;
  updatedAt: string;
  /** Bumped on every stored change; part of the inventory revision. */
  version: number;
}

export interface PrinterInventorySnapshot {
  /** Fingerprint of the whole set (ids + versions); changes on any add/edit/delete. */
  revision: string;
  /** Most recent per-printer `updatedAt`, or null for an empty farm. */
  updatedAt: string | null;
  count: number;
  printers: PrinterInventoryEntry[];
}

/**
 * Fields that must never appear on this contract. Kept as data (not just prose)
 * so the contract test can assert their absence mechanically — the check that
 * actually keeps a credential from leaking when someone spreads a record.
 */
export const PRINTER_INVENTORY_FORBIDDEN_FIELDS = [
  "host",
  "port",
  "apiKey",
  "serial",
  "accessCode",
  "allowInsecureTls",
  "snapshotUrl",
  "streamUrl",
  "interfaceUrl",
  "light",
  "secrets",
  "metadata"
] as const;

/** "" is how the record stores "not specified"; on the wire that is `null`. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Projects one stored record onto the contract. Written as an explicit field
 * list rather than a rest-spread: a new column added to `PrinterRecord` — a
 * credential, an internal address — must be *opted in* here, never leak by
 * being added upstream.
 */
export function toPrinterInventoryEntry(record: PrinterRecord): PrinterInventoryEntry {
  return {
    id: record.id,
    name: record.name,
    model: orNull(record.model),
    type: record.type,
    printerClass: orNull(record.printerClass),
    protocol: record.protocol,
    enabled: record.enabled,
    position: record.position,
    material: orNull(record.material),
    swatch: orNull(record.swatch),
    nozzleDiameterMm: record.nozzleDiameterMm,
    nozzleType: orNull(record.nozzleType),
    buildVolume: record.buildVolume
      ? { x: record.buildVolume.x, y: record.buildVolume.y, z: record.buildVolume.z }
      : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version
  };
}

/**
 * Fingerprint of the printer set. Built from (id, version) pairs sorted by id,
 * so it is stable against ordering changes in storage yet changes whenever a
 * printer is added, edited (version bumps) or removed.
 */
export function printerInventoryRevision(entries: PrinterInventoryEntry[]): string {
  const material = entries
    .map((entry) => `${entry.id}:${entry.version}`)
    .sort()
    .join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** The full snapshot served by `GET /api/printers/inventory`. */
export function buildPrinterInventory(records: PrinterRecord[]): PrinterInventorySnapshot {
  const printers = records
    .map(toPrinterInventoryEntry)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  const updatedAt = printers.reduce<string | null>(
    (latest, entry) => (latest === null || entry.updatedAt > latest ? entry.updatedAt : latest),
    null
  );

  return {
    revision: printerInventoryRevision(printers),
    updatedAt,
    count: printers.length,
    printers
  };
}
