import fs from "node:fs/promises";
import path from "node:path";

import type { PrinterTechnology } from "../../domain/printers/types";

export type PrinterProtocol = "moonraker" | "bambu" | "creality";

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
  /** Optional UI colour for the material chip. */
  swatch: string;
  /** Explicit camera snapshot URL; empty when the camera is not set up. */
  snapshotUrl: string;
  /** Explicit live camera stream URL; empty when no browser-safe stream exists. */
  streamUrl: string;

  enabled: boolean;
  apiKey: string;
  serial: string;
  accessCode: string;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

function normalizeType(value: unknown): PrinterTechnology {
  return String(value ?? "").trim().toLowerCase() === "resin" ? "Resin" : "FDM";
}

export function normalizePrinterConfig(value: unknown): PrinterConfig | null {
  if (!isObject(value)) return null;

  const id = asString(value.id);
  const name = asString(value.name);
  const host = asString(value.host);
  if (!id || !name || !host) return null;

  const portValue = Number(value.port);

  return {
    id,
    name,
    model: asString(value.model),
    type: normalizeType(value.type),

    protocol: normalizeProtocol(value.protocol),
    host,
    port: Number.isFinite(portValue) && portValue > 0 ? portValue : undefined,

    material: asString(value.material),
    swatch: asString(value.swatch),
    snapshotUrl: asString(value.snapshotUrl),
    streamUrl: asString(value.streamUrl),

    enabled: value.enabled !== false,
    apiKey: asString(value.apiKey),
    serial: asString(value.serial),
    accessCode: asString(value.accessCode)
  };
}

function parsePrinters(raw: unknown): PrinterConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizePrinterConfig)
    .filter((printer): printer is PrinterConfig => Boolean(printer));
}

function readFromEnv(): PrintersConfigResult {
  const raw = process.env.PRINTERS_CONFIG_JSON;
  if (!raw) {
    return { printers: [], source: { kind: "none" } };
  }
  try {
    const printers = parsePrinters(JSON.parse(raw));
    return { printers, source: { kind: "env" } };
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

  const printers = parsePrinters(parsed);
  if (printers.length === 0 && Array.isArray(parsed) && parsed.length > 0) {
    const fallback = readFromEnv();
    return {
      ...fallback,
      source: {
        ...fallback.source,
        warning: `Файл ${configPath}: ни одна запись не валидна (нужны id, name, host)`
      }
    };
  }

  return { printers, source: { kind: "file", path: configPath } };
}
