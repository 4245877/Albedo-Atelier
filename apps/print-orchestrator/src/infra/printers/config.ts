import fs from "node:fs/promises";
import path from "node:path";

import type { PrinterTechnology } from "../../domain/printers/types";
import { isObject } from "../../shared/isObject";

export type PrinterProtocol = "moonraker" | "bambu" | "creality";

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
 * Static config for one real printer. Same shape as apps/fulfillment's
 * `PrinterConfig` (data/printers.json), extended with the dashboard-only
 * presentation fields `type` (FDM/Resin) and `swatch` (material colour).
 */
export interface PrinterConfig {
  id: string;
  name: string;
  model: string;
  type: PrinterTechnology;

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
  light: PrinterLightConfig;
}

export type PrinterConfigSourceKind = "file" | "env" | "none";

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

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config", "printers.json");

/**
 * Allowed printer id shape. The id is used verbatim as a filesystem path
 * segment (camera snapshots: `<snapshotsDir>/<id>/<day>/…`) and as a URL path
 * segment, so it is restricted to characters that cannot traverse a directory
 * or need escaping — letters, digits, underscore and hyphen. An id with any
 * other character (a slash, a dot, `..`, whitespace) is rejected, dropping the
 * whole printer rather than trusting an unsafe key downstream.
 */
const PRINTER_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Expands `${ENV_VAR}` references in config strings so secrets (e.g. the Bambu
 * LAN access code) can live in the environment instead of the committed JSON.
 * An unset variable expands to "" — the driver then reports the printer as
 * "not configured" instead of silently using the literal placeholder.
 */
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => process.env[name] ?? "");
}

function asString(value: unknown): string {
  return expandEnv(String(value ?? "").trim());
}

function normalizeProtocol(value: unknown): PrinterProtocol {
  const protocol = String(value ?? "moonraker").trim().toLowerCase();
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
  const url = asString(value);
  return /^https?:\/\//i.test(url) ? url : "";
}

function normalizeType(value: unknown): PrinterTechnology {
  return String(value ?? "").trim().toLowerCase() === "resin" ? "Resin" : "FDM";
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

function normalizeLightConfig(value: unknown, protocol: PrinterProtocol): PrinterLightConfig {
  const object = isObject(value) ? value : {};
  const pin = asString(object.pin);
  const invert = object.invert === true;
  // Active-low pins light the fixture at VALUE=0, so swap the pin-derived VALUEs.
  const onValue = invert ? 0 : 1;
  const offValue = invert ? 1 : 0;
  const onGcode = asString(object.onGcode) || (pin ? `SET_PIN PIN=${pin} VALUE=${onValue}` : "");
  const offGcode = asString(object.offGcode) || (pin ? `SET_PIN PIN=${pin} VALUE=${offValue}` : "");
  const statusObject = asString(object.statusObject) || (pin ? `output_pin ${pin}` : "");
  const statusField = asString(object.statusField) || "value";
  const bambuNode = asString(object.bambuNode) || "chamber_light";

  const explicitEnabled = object.enabled;
  const enabled =
    typeof explicitEnabled === "boolean"
      ? explicitEnabled
      : protocol === "bambu" || (protocol === "moonraker" && Boolean(onGcode && offGcode));

  return { enabled, pin, invert, onGcode, offGcode, statusObject, statusField, bambuNode };
}

export function normalizePrinterConfig(value: unknown): PrinterConfig | null {
  if (!isObject(value)) return null;

  const id = asString(value.id);
  const name = asString(value.name);
  const host = asString(value.host);
  if (!id || !name || !host) return null;
  // An unsafe id would become a traversable snapshot path / URL segment.
  if (!PRINTER_ID_RE.test(id)) return null;

  const portValue = Number(value.port);
  const protocol = normalizeProtocol(value.protocol);
  const nozzleDiameterValue = Number(value.nozzleDiameterMm);

  return {
    id,
    name,
    model: asString(value.model),
    type: normalizeType(value.type),

    protocol,
    host,
    port: Number.isFinite(portValue) && portValue > 0 ? portValue : undefined,

    material: asString(value.material),
    nozzleDiameterMm:
      Number.isFinite(nozzleDiameterValue) && nozzleDiameterValue > 0 ? nozzleDiameterValue : null,
    nozzleType: asString(value.nozzleType),
    buildVolume: normalizeBuildVolume(value.buildVolume),
    swatch: asString(value.swatch),
    snapshotUrl: asString(value.snapshotUrl),
    streamUrl: asString(value.streamUrl),
    interfaceUrl: normalizeInterfaceUrl(value.interfaceUrl),

    enabled: value.enabled !== false,
    apiKey: asString(value.apiKey),
    serial: asString(value.serial),
    accessCode: asString(value.accessCode),
    allowInsecureTls: value.allowInsecureTls === true,
    light: normalizeLightConfig(value.light, protocol)
  };
}

/**
 * Normalizes every entry and enforces id uniqueness: the first printer to claim
 * an id wins and later duplicates are dropped. Duplicate ids are dangerous
 * downstream — the poller keys live status by id, so a second device under the
 * same id would overwrite the first's status, and a command resolved by id
 * could hit the wrong printer. Returns the accepted printers plus a warning
 * when any duplicate was dropped.
 */
function parsePrinters(raw: unknown): { printers: PrinterConfig[]; warning?: string } {
  if (!Array.isArray(raw)) return { printers: [] };
  const normalized = raw
    .map(normalizePrinterConfig)
    .filter((printer): printer is PrinterConfig => Boolean(printer));

  const seen = new Set<string>();
  const printers: PrinterConfig[] = [];
  const duplicates = new Set<string>();
  for (const printer of normalized) {
    if (seen.has(printer.id)) {
      duplicates.add(printer.id);
      continue;
    }
    seen.add(printer.id);
    printers.push(printer);
  }

  const warning =
    duplicates.size > 0
      ? `Повторяющиеся id принтеров пропущены (первый выигрывает): ${[...duplicates].join(", ")}`
      : undefined;
  return { printers, warning };
}

function readFromEnv(): PrintersConfigResult {
  const raw = process.env.PRINTERS_CONFIG_JSON;
  if (!raw) {
    return { printers: [], source: { kind: "none" } };
  }
  try {
    const { printers, warning } = parsePrinters(JSON.parse(raw));
    return { printers, source: { kind: "env", warning } };
  } catch {
    return {
      printers: [],
      source: { kind: "none", warning: "PRINTERS_CONFIG_JSON не является валидным JSON" }
    };
  }
}

/**
 * Loads the real printer configuration. Order (same policy as fulfillment):
 * the `PRINTERS_CONFIG_PATH` file (default `config/printers.json`), falling
 * back to the `PRINTERS_CONFIG_JSON` env variable when the file is missing or
 * corrupt. Never invents printers: with no usable source the farm is empty and
 * the dashboard says so.
 */
export async function loadPrintersConfig(): Promise<PrintersConfigResult> {
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

  const { printers, warning } = parsePrinters(parsed);
  if (printers.length === 0 && Array.isArray(parsed) && parsed.length > 0) {
    const fallback = readFromEnv();
    return {
      ...fallback,
      source: {
        ...fallback.source,
        warning: `Файл ${configPath}: ни одна запись не валидна (нужны id, name, host; id — [A-Za-z0-9_-])`
      }
    };
  }

  return { printers, source: { kind: "file", path: configPath, warning } };
}
