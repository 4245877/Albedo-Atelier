import { createHash } from "node:crypto";

import type { PrinterRecord } from "./config";
import type { PrinterProtocol } from "./config";
import type { PrinterDiscoveryRecord } from "./discovery";
import { resolvePrinterSpecs, type SpecSource } from "./specs";
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
 *
 * The hardware characteristics published here are **resolved**, not raw stored
 * columns: a printer that reports its own nozzle and bed size now publishes what
 * the device said, and `specSources` states, per field, who the answer came
 * from. That is what stops a consumer from having to decide whether an empty
 * `nozzleDiameterMm` means "0.4, nobody wrote it down" or "genuinely unknown".
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
  /** Loaded material: the printer's active slot when it reports one, else declared. */
  material: string | null;
  /** UI colour for the material chip. */
  swatch: string | null;
  nozzleDiameterMm: number | null;
  nozzleType: string | null;
  buildVolume: { x: number; y: number; z: number } | null;
  /** Whether a multi-material unit is attached; null when the printer cannot say. */
  ams: boolean | null;
  /**
   * Where each resolved characteristic came from — `printer` (the device said
   * it), `manual` (an operator typed it), `catalog` (derived from the identified
   * model) or `unknown`. A consumer that must not act on an assumption can check
   * this instead of trusting every field equally.
   */
  specSources: Record<InventorySpecField, SpecSource>;
  createdAt: string;
  updatedAt: string;
  /** Bumped on every stored change; part of the inventory revision. */
  version: number;
}

/** The characteristics whose provenance the contract publishes. */
export const INVENTORY_SPEC_FIELDS = [
  "model",
  "material",
  "nozzleDiameterMm",
  "nozzleType",
  "buildVolume",
  "ams"
] as const;

export type InventorySpecField = (typeof INVENTORY_SPEC_FIELDS)[number];

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
export function toPrinterInventoryEntry(
  record: PrinterRecord,
  discovery: PrinterDiscoveryRecord | null = null
): PrinterInventoryEntry {
  const specs = resolvePrinterSpecs(record, discovery);
  const buildVolume = specs.buildVolume.value;

  return {
    id: record.id,
    name: record.name,
    model: specs.model.value,
    type: record.type,
    printerClass: orNull(record.printerClass),
    protocol: record.protocol,
    enabled: record.enabled,
    position: record.position,
    material: specs.material.value,
    swatch: orNull(record.swatch),
    nozzleDiameterMm: specs.nozzleDiameterMm.value,
    nozzleType: specs.nozzleType.value,
    buildVolume: buildVolume ? { x: buildVolume.x, y: buildVolume.y, z: buildVolume.z } : null,
    ams: specs.ams.value?.present ?? null,
    specSources: {
      model: specs.model.source,
      material: specs.material.source,
      nozzleDiameterMm: specs.nozzleDiameterMm.source,
      nozzleType: specs.nozzleType.source,
      buildVolume: specs.buildVolume.source,
      ams: specs.ams.source
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version
  };
}

/**
 * Fingerprint of the printer set. Built from (id, version) pairs sorted by id,
 * so it is stable against ordering changes in storage yet changes whenever a
 * printer is added, edited (version bumps) or removed.
 *
 * The discovery version is folded in for the same reason. Now that a printer can
 * report its own nozzle or bed size, the published entry changes without any
 * operator edit — and a consumer that polls only the revision would never see
 * it. A printer with no discovery row contributes `0`, so a farm that has never
 * probed anything keeps the fingerprint it had before this existed.
 */
export function printerInventoryRevision(
  entries: PrinterInventoryEntry[],
  discovery: ReadonlyMap<string, PrinterDiscoveryRecord> = new Map()
): string {
  const material = entries
    .map((entry) => `${entry.id}:${entry.version}:${discovery.get(entry.id)?.version ?? 0}`)
    .sort()
    .join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** The full snapshot served by `GET /api/printers/inventory`. */
export function buildPrinterInventory(
  records: PrinterRecord[],
  discovery: ReadonlyMap<string, PrinterDiscoveryRecord> = new Map()
): PrinterInventorySnapshot {
  const printers = records
    .map((record) => toPrinterInventoryEntry(record, discovery.get(record.id) ?? null))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  const updatedAt = printers.reduce<string | null>(
    (latest, entry) => (latest === null || entry.updatedAt > latest ? entry.updatedAt : latest),
    null
  );

  return {
    revision: printerInventoryRevision(printers, discovery),
    updatedAt,
    count: printers.length,
    printers
  };
}
