import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_LIGHT_SETTINGS,
  NO_AUTOMATIC_CONTINUATION,
  PRINTER_ID_RE,
  type AutomaticContinuationConfig,
  type PrinterLightSettings,
  type PrinterProtocol,
  type PrinterRecord
} from "../../domain/printers/config";
import type { PrinterTechnology } from "../../domain/printers/types";
import { isObject } from "../../shared/isObject";
import { expandEnvRefs, materializePrinter } from "./materialize";

/**
 * Re-exported from the domain so the many existing importers of this module keep
 * working; the vocabulary itself lives in `domain/printers/config.ts`.
 */
export {
  automaticContinuationEnabled,
  NO_AUTOMATIC_CONTINUATION
} from "../../domain/printers/config";
export type {
  AutomaticContinuationConfig,
  PrinterProtocol,
  PrinterRecord
} from "../../domain/printers/config";

/** Executable light configuration — the record's settings after defaults. */
export interface PrinterLightConfig {
  enabled: boolean;
  /** Moonraker output pin name; produces SET_PIN commands when present. */
  pin: string;
  /**
   * The physical pin is active-low: it lights the fixture at VALUE=0 and darkens
   * it at VALUE=1 (a `!`-inverted `output_pin` in Klipper, common on the K2). When
   * true, the pin-derived on/off G-code swaps its VALUE and the reported pin state
   * is flipped, so "on" always means the light is physically lit. Ignored when the
   * caller supplies explicit onGcode/offGcode (those already encode the intent),
   * but the status read is still inverted so the reported state stays truthful.
   */
  invert: boolean;
  /** Explicit Moonraker G-code command for switching the light on. */
  onGcode: string;
  /** Explicit Moonraker G-code command for switching the light off. */
  offGcode: string;
  /** Moonraker object queried for state, e.g. "output_pin LED". */
  statusObject: string;
  /** Field inside the Moonraker status object; defaults to "value". */
  statusField: string;
  /** Bambu LED node passed to the local MQTT ledctrl command. */
  bambuNode: string;
}

/**
 * Runtime config for one real printer — a {@link PrinterRecord} with `${ENV}`
 * references expanded and light defaults applied. This is what the drivers, the
 * poller and the read models consume; nothing downstream sees the stored shape.
 */
export interface PrinterConfig {
  id: string;
  name: string;
  model: string;
  type: PrinterTechnology;

  /**
   * Interchangeability class — a label grouping printers a *class-scoped* profile
   * set / slice variant may target (e.g. every "Creality K2" is class `k2`). It is
   * how a slice made "for the K2 class" is matched to a concrete K2 at schedule
   * time. Absent/empty when the printer belongs to no class: a class-scoped variant
   * then matches it only if it, too, has no class — never "any printer"
   * (fail-closed).
   */
  printerClass?: string;

  protocol: PrinterProtocol;
  host: string;
  port?: number;

  /** Declared loaded material (config metadata, not live telemetry). */
  material: string;
  /**
   * Optional configured nozzle diameter in mm. A config fallback the view shows
   * as "из конфигурации" only when the device does not report a live diameter
   * (e.g. a Creality WS printer, or any printer while it is offline).
   */
  nozzleDiameterMm?: number | null;
  /** Optional configured nozzle hardware type; same "из конфигурации" fallback role. */
  nozzleType?: string;
  /**
   * Optional explicit build volume in mm (`{x,y,z}`). When set it is the *priority*
   * source the manual scheduler uses for fit checks; otherwise the scheduler falls
   * back to the printer's approved machine profile. Null when not configured.
   */
  buildVolume?: { x: number; y: number; z: number } | null;
  /** Optional UI colour for the material chip. */
  swatch: string;
  /** Explicit camera snapshot URL; empty when the camera is not set up. */
  snapshotUrl: string;
  /** Explicit live camera stream URL; empty when no browser-safe stream exists. */
  streamUrl: string;
  /**
   * Explicit URL of the printer's own web UI (Fluidd/Mainsail…), opened by the
   * dashboard in a new tab. Configured, never guessed — Moonraker, Bambu MQTT
   * and Creality WS expose their interfaces (if any) in incompatible ways.
   * Empty when the printer has no browser UI.
   */
  interfaceUrl: string;

  enabled: boolean;
  apiKey: string;
  serial: string;
  accessCode: string;
  /**
   * Explicit opt-in for a TLS connection WITHOUT certificate verification
   * (Bambu LAN MQTT uses a per-printer self-signed certificate with no CA).
   * Without this flag (or the global `BAMBU_ALLOW_INSECURE_TLS=1`) the adapter
   * refuses to connect and reports the printer offline with the reason —
   * unverified TLS is never a silent default. Optional so existing fixtures
   * and configs stay valid; absent means `false` (refuse).
   */
  allowInsecureTls?: boolean;
  /**
   * Whether this printer may continue the queue **by itself** after a print
   * finishes, i.e. whether it clears its own bed.
   *
   * Deliberately separate from a task's `unattendedAllowed`: that is permission
   * to run *one* print with nobody watching, which is a statement about the
   * print. This is a statement about the *hardware* — an auto-eject arm, a belt,
   * a plate changer — and only it may move a bed from `AWAITING_CLEARANCE` to
   * `CLEAR` without a human. Conflating the two is what let a night queue start
   * its next job onto a plate that still held the previous part.
   *
   * Absent means `{ allowed: false }`: no printer in the farm has such hardware
   * today, so the safe default is the one that requires an operator.
   */
  automaticContinuation?: AutomaticContinuationConfig;
  light: PrinterLightConfig;
}

/**
 * Where the live printer config came from. `db` is the normal answer since the
 * configuration moved into SQLite (editable from the dashboard); `file`/`env`
 * describe the one-time seed and stay for the import path and older fixtures.
 */
export type PrinterConfigSourceKind = "db" | "file" | "env" | "none";

export interface PrinterConfigSource {
  kind: PrinterConfigSourceKind;
  /** Path of the file the config came from, when kind === "file". */
  path?: string;
  /** Human-readable problem when the preferred source was unusable. */
  warning?: string;
}

export interface PrintersConfigResult {
  printers: PrinterConfig[];
  source: PrinterConfigSource;
}

export interface PrinterRecordsResult {
  records: PrinterRecord[];
  source: PrinterConfigSource;
}

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config", "printers.json");

function asRaw(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeProtocol(value: unknown): PrinterProtocol {
  const protocol = asRaw(value).toLowerCase();
  if (protocol === "bambu") return "bambu";
  if (protocol === "creality") return "creality";
  return "moonraker";
}

/**
 * The printer's web-UI link is rendered as a clickable href on the dashboard,
 * so only http(s) URLs are accepted; anything else is dropped (treated as
 * "no interface configured") rather than passed through to the browser.
 */
function normalizeInterfaceUrl(value: unknown): string {
  const url = asRaw(value);
  // A `${VAR}` reference is judged on what it expands to, not on its own text.
  return /^https?:\/\//i.test(expandEnvRefs(url)) ? url : "";
}

function normalizeType(value: unknown): PrinterTechnology {
  return asRaw(value).toLowerCase() === "resin" ? "Resin" : "FDM";
}

/**
 * An explicit `{x,y,z}` build volume in mm — accepted only when all three axes are
 * finite and positive; anything else (missing, partial, non-numeric) is dropped to
 * null so the scheduler falls back to the approved machine profile instead of a
 * half-specified box.
 */
function normalizeBuildVolume(value: unknown): { x: number; y: number; z: number } | null {
  if (!isObject(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if ([x, y, z].every((n) => Number.isFinite(n) && n > 0)) return { x, y, z };
  return null;
}

function normalizeAutomaticContinuation(value: unknown): AutomaticContinuationConfig {
  if (!isObject(value)) return { ...NO_AUTOMATIC_CONTINUATION };
  const verifiedAt = asRaw(value.verifiedAt);
  return {
    // Opt-in only: anything other than a literal `true` stays false.
    allowed: value.allowed === true,
    mechanism: asRaw(value.mechanism),
    verifiedAt: verifiedAt && Number.isFinite(Date.parse(verifiedAt)) ? verifiedAt : null
  };
}

function normalizeLightSettings(value: unknown): PrinterLightSettings {
  const object = isObject(value) ? value : {};
  return {
    enabled: typeof object.enabled === "boolean" ? object.enabled : null,
    pin: asRaw(object.pin),
    invert: object.invert === true,
    onGcode: asRaw(object.onGcode),
    offGcode: asRaw(object.offGcode),
    statusObject: asRaw(object.statusObject),
    statusField: asRaw(object.statusField),
    bambuNode: asRaw(object.bambuNode)
  };
}

/**
 * Lenient normalization of one hand-written JSON entry into a stored record.
 * Strings are kept **verbatim** (including `${VAR}` references) — expansion is
 * the materializer's job. Returns null when the entry cannot describe a printer
 * at all, so one bad row cannot take the rest of the file down.
 *
 * The strict counterpart, used for input arriving from the UI, is
 * `domain/printers/validation.ts` — it answers with a 400 naming the field
 * instead of dropping the row.
 */
export function normalizePrinterRecord(value: unknown, position = 0): PrinterRecord | null {
  if (!isObject(value)) return null;

  const id = asRaw(value.id);
  const name = asRaw(value.name);
  const host = asRaw(value.host);
  if (!id || !name || !host) return null;
  // An unsafe id would become a traversable snapshot path / URL segment.
  if (!PRINTER_ID_RE.test(id)) return null;

  const portValue = Number(value.port);
  const nozzleDiameterValue = Number(value.nozzleDiameterMm);
  const now = new Date().toISOString();

  return {
    id,
    name,
    model: asRaw(value.model),
    type: normalizeType(value.type),
    printerClass: asRaw(value.printerClass ?? value.class),

    protocol: normalizeProtocol(value.protocol),
    host,
    port: Number.isFinite(portValue) && portValue > 0 ? portValue : null,

    material: asRaw(value.material),
    nozzleDiameterMm:
      Number.isFinite(nozzleDiameterValue) && nozzleDiameterValue > 0 ? nozzleDiameterValue : null,
    nozzleType: asRaw(value.nozzleType),
    buildVolume: normalizeBuildVolume(value.buildVolume),
    swatch: asRaw(value.swatch),
    snapshotUrl: asRaw(value.snapshotUrl),
    streamUrl: asRaw(value.streamUrl),
    interfaceUrl: normalizeInterfaceUrl(value.interfaceUrl),

    enabled: value.enabled !== false,
    apiKey: asRaw(value.apiKey),
    serial: asRaw(value.serial),
    accessCode: asRaw(value.accessCode),
    allowInsecureTls: value.allowInsecureTls === true,
    automaticContinuation: normalizeAutomaticContinuation(value.automaticContinuation),
    light: normalizeLightSettings(value.light),

    position,
    createdAt: now,
    updatedAt: now,
    version: 1,
    metadata: {}
  };
}

/** Backwards-compatible helper: normalize one JSON entry straight to runtime config. */
export function normalizePrinterConfig(value: unknown): PrinterConfig | null {
  const record = normalizePrinterRecord(value);
  return record ? materializePrinter(record) : null;
}

/**
 * Normalizes every entry and enforces id uniqueness: the first printer to claim
 * an id wins and later duplicates are dropped. Duplicate ids are dangerous
 * downstream — the poller keys live status by id, so a second device under the
 * same id would overwrite the first's status, and a command resolved by id
 * could hit the wrong printer. Returns the accepted records plus a warning
 * when any duplicate was dropped.
 */
function parsePrinters(raw: unknown): { records: PrinterRecord[]; warning?: string } {
  if (!Array.isArray(raw)) return { records: [] };

  const seen = new Set<string>();
  const records: PrinterRecord[] = [];
  const duplicates = new Set<string>();
  for (const entry of raw) {
    const record = normalizePrinterRecord(entry, (records.length + 1) * 10);
    if (!record) continue;
    if (seen.has(record.id)) {
      duplicates.add(record.id);
      continue;
    }
    seen.add(record.id);
    records.push(record);
  }

  const warning =
    duplicates.size > 0
      ? `Повторяющиеся id принтеров пропущены (первый выигрывает): ${[...duplicates].join(", ")}`
      : undefined;
  return { records, warning };
}

function readFromEnv(): PrinterRecordsResult {
  const raw = process.env.PRINTERS_CONFIG_JSON;
  if (!raw) {
    return { records: [], source: { kind: "none" } };
  }
  try {
    const { records, warning } = parsePrinters(JSON.parse(raw));
    return { records, source: { kind: "env", warning } };
  } catch {
    return {
      records: [],
      source: { kind: "none", warning: "PRINTERS_CONFIG_JSON не является валидным JSON" }
    };
  }
}

/**
 * Loads the printer configuration **seed** — the hand-written source that is
 * imported into SQLite once, on the first boot after the configuration moved
 * into the database (see `infra/db/printersImport.ts`). After that import the
 * database is authoritative and this file is no longer read.
 *
 * Order (unchanged): the `PRINTERS_CONFIG_PATH` file (default
 * `config/printers.json`), falling back to the `PRINTERS_CONFIG_JSON` env
 * variable when the file is missing or corrupt. Never invents printers: with no
 * usable source the farm is empty and the dashboard says so.
 */
export async function loadPrinterRecords(): Promise<PrinterRecordsResult> {
  const configPath = process.env.PRINTERS_CONFIG_PATH || DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return readFromEnv();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const fallback = readFromEnv();
    return {
      ...fallback,
      source: {
        ...fallback.source,
        warning: `Файл ${configPath} не является валидным JSON`
      }
    };
  }

  const { records, warning } = parsePrinters(parsed);
  if (records.length === 0 && Array.isArray(parsed) && parsed.length > 0) {
    const fallback = readFromEnv();
    return {
      ...fallback,
      source: {
        ...fallback.source,
        warning: `Файл ${configPath}: ни одна запись не валидна (нужны id, name, host; id — [A-Za-z0-9_-])`
      }
    };
  }

  return { records, source: { kind: "file", path: configPath, warning } };
}

/** {@link loadPrinterRecords} materialized into runtime configs. */
export async function loadPrintersConfig(): Promise<PrintersConfigResult> {
  const { records, source } = await loadPrinterRecords();
  return { printers: records.map(materializePrinter), source };
}
