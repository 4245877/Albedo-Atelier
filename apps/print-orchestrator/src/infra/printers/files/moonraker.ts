import { fetchWithTimeout } from "../../../shared/fetchWithTimeout";
import { isObject } from "../../../shared/isObject";
import type { PrinterConfig } from "../config";
import { toFiniteNumber } from "../status/mapper";
import { moonrakerBaseUrl, moonrakerHeaders } from "../status/moonraker";
import { PrinterCommandError } from "../status/types";
import { isPrintableFile, normalizePrinterPath } from "./path";
import type { PrinterFileEntry, PrinterFilesListing } from "./types";

const MOONRAKER_FILES_TIMEOUT_MS = 5000;

/**
 * Slicer metadata fields worth forwarding to the dashboard from Moonraker's
 * extended directory listing. Thumbnails and layer-by-layer noise are dropped —
 * the browser list only needs "what is this print and how long is it".
 */
const METADATA_FIELDS = [
  "slicer",
  "estimated_time",
  "filament_type",
  "filament_name",
  "filament_total",
  "filament_weight_total",
  "object_height",
  "layer_height"
] as const;

function toIsoTime(value: unknown): string | undefined {
  const seconds = toFiniteNumber(value);
  if (seconds === null || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function pickMetadata(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  for (const field of METADATA_FIELDS) {
    const value = entry[field];
    if (value !== undefined && value !== null && value !== "") metadata[field] = value;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function joinPath(basePath: string, name: string): string {
  return basePath ? `${basePath}/${name}` : name;
}

/**
 * Maps one Moonraker `/server/files/directory` result to normalized entries.
 * Paths are relative to the `gcodes` root (what `startPrint` expects). Dot
 * entries (`.thumbs` and friends) are hidden, matching what Fluidd/Mainsail
 * show an operator. Directories first, then files, each alphabetically.
 * Pure — no HTTP; exported for unit testing.
 */
export function parseMoonrakerDirectory(basePath: string, result: unknown): PrinterFileEntry[] {
  if (!isObject(result)) return [];

  const dirs: PrinterFileEntry[] = [];
  for (const raw of Array.isArray(result.dirs) ? result.dirs : []) {
    if (!isObject(raw)) continue;
    const name = typeof raw.dirname === "string" ? raw.dirname.trim() : "";
    if (!name || name.startsWith(".")) continue;
    dirs.push({
      name,
      path: joinPath(basePath, name),
      type: "directory",
      ...(toFiniteNumber(raw.size) !== null ? { size: Number(raw.size) } : {}),
      ...(toIsoTime(raw.modified) ? { modifiedAt: toIsoTime(raw.modified) } : {}),
      printable: false
    });
  }

  const files: PrinterFileEntry[] = [];
  for (const raw of Array.isArray(result.files) ? result.files : []) {
    if (!isObject(raw)) continue;
    const name = typeof raw.filename === "string" ? raw.filename.trim() : "";
    if (!name || name.startsWith(".")) continue;
    const path = joinPath(basePath, name);
    const metadata = pickMetadata(raw);
    files.push({
      name,
      path,
      type: "file",
      ...(toFiniteNumber(raw.size) !== null ? { size: Number(raw.size) } : {}),
      ...(toIsoTime(raw.modified) ? { modifiedAt: toIsoTime(raw.modified) } : {}),
      printable: isPrintableFile(path),
      ...(metadata ? { metadata } : {})
    });
  }

  const byName = (a: PrinterFileEntry, b: PrinterFileEntry): number =>
    a.name.localeCompare(b.name, "ru");
  return [...dirs.sort(byName), ...files.sort(byName)];
}

/**
 * Lists one directory of the printer's virtual SD card via Moonraker's
 * `/server/files/directory` (root `gcodes`, `extended=true` so G-code entries
 * carry their slicer metadata — the same metadata source as
 * `/server/files/metadata`, already used for the active-filament read).
 */
export async function listMoonrakerFiles(
  printer: PrinterConfig,
  path: string
): Promise<PrinterFilesListing> {
  const relative = normalizePrinterPath(path, { allowEmpty: true });
  const target = relative ? `gcodes/${relative}` : "gcodes";

  const res = await fetchWithTimeout(
    `${moonrakerBaseUrl(printer)}/server/files/directory?path=${encodeURIComponent(target)}&extended=true`,
    { timeoutMs: MOONRAKER_FILES_TIMEOUT_MS, headers: moonrakerHeaders(printer) }
  );
  if (!res.ok) {
    // Moonraker answers 400/404 for a directory that does not exist.
    throw new PrinterCommandError(
      res.status === 404 || res.status === 400
        ? `Папка «${relative || "/"}» не найдена на принтере`
        : `Moonraker HTTP ${res.status}`
    );
  }
  const json = (await res.json()) as { result?: unknown };
  return { path: relative, entries: parseMoonrakerDirectory(relative, json?.result) };
}

/**
 * Deletes one file from Moonraker's G-code root.
 *
 * `DELETE /server/files/gcodes/<path>` — the counterpart of the upload this
 * module already performs. It existed in the API all along and was simply not
 * implemented here, which is why the capability table declared
 * `supportsFileDelete: false`: an accurate statement about this codebase that
 * was easy to misread as a statement about Klipper.
 *
 * A 404 is treated as success: the caller's goal is "this file is not on the
 * printer", and a file that is already gone satisfies it. That makes the whole
 * retention sweep idempotent and safe to retry.
 */
export async function deleteMoonrakerFile(printer: PrinterConfig, remotePath: string): Promise<void> {
  const target = normalizePrinterPath(remotePath);
  const res = await fetchWithTimeout(
    `${moonrakerBaseUrl(printer)}/server/files/gcodes/${encodeURI(target)}`,
    {
      method: "DELETE",
      timeoutMs: MOONRAKER_FILES_TIMEOUT_MS,
      headers: moonrakerHeaders(printer)
    }
  );
  if (res.ok || res.status === 404) return;
  throw new PrinterCommandError(
    `Не удалось удалить «${target}» с принтера: Moonraker HTTP ${res.status}`,
    // A 4xx other than 404 is the device refusing definitively (bad path, locked
    // by a running print); a 5xx or a timeout leaves the outcome unknown.
    res.status >= 400 && res.status < 500
  );
}
