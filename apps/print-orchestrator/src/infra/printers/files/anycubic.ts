import { ValidationError } from "../../../core/errors";
import { isObject } from "../../../shared/isObject";
import { getAnycubicSession } from "../anycubic";
import type { AnycubicStorage } from "../anycubic/requests";
import type { PrinterConfig } from "../config";
import { PrinterCommandError } from "../status/types";
import { normalizePrinterPath } from "./path";
import type { PrinterFileEntry, PrinterFilesListing } from "./types";

export const ANYCUBIC_PAGE_SIZE = 200;
export const ANYCUBIC_MAX_FILES = 20000;

/** Explicit storage namespaces prevent a USB file aliasing an internal file. */
export function anycubicFilePath(raw: string): { path: string; storage: AnycubicStorage; directory: string } | null {
  const path = normalizePrinterPath(raw, { allowEmpty: true });
  if (!path) return null;
  const [root, ...parts] = path.split("/");
  if (root !== "local" && root !== "usb") throw new ValidationError("Выберите память принтера или USB");
  return { path, storage: root, directory: parts.length ? `/${parts.join("/")}` : "/" };
}

/** Parse only the captured records schema. An invalid answer is never an empty folder. */
export function parseAnycubicFilePage(base: string, response: unknown): PrinterFileEntry[] {
  if (!isObject(response) || response.code !== 200 || !isObject(response.data) ||
      response.data.list_mode !== 0 || !Array.isArray(response.data.records) || response.data.records.length > ANYCUBIC_MAX_FILES) {
    throw new PrinterCommandError("Anycubic LAN: некорректный ответ списка файлов");
  }
  const seen = new Set<string>();
  return response.data.records.map((raw): PrinterFileEntry => {
    if (!isObject(raw) || typeof raw.filename !== "string" || typeof raw.is_dir !== "boolean") {
      throw new PrinterCommandError("Anycubic LAN: некорректная запись файла");
    }
    const name = raw.filename;
    // No repair or URL decoding: '+' is a literal character in device filenames.
    if (name.includes("/") || normalizePrinterPath(name) !== name || seen.has(name)) {
      throw new PrinterCommandError("Anycubic LAN: неоднозначное имя файла");
    }
    seen.add(name);
    const timestamp = raw.timestamp;
    const size = raw.size;
    return {
      name: typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name : name,
      path: normalizePrinterPath(`${base}/${name}`),
      type: raw.is_dir ? "directory" : "file",
      ...(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
      ...(typeof timestamp === "number" && timestamp > 0 && timestamp < 8.64e15 ? { modifiedAt: new Date(timestamp).toISOString() } : {}),
      // Browsing is enabled independently of print dispatch.
      printable: false
    };
  });
}

export async function listAnycubicFiles(printer: PrinterConfig, rawPath: string): Promise<PrinterFilesListing> {
  const target = anycubicFilePath(rawPath);
  const session = getAnycubicSession(printer);
  if (!target) {
    const peripheral = await session.readPeripheral();
    return { path: "", entries: [
      { name: "Память принтера", path: "local", type: "directory", printable: false },
      ...(peripheral.usbPresent === true ? [{ name: "USB", path: "usb", type: "directory" as const, printable: false }] : [])
    ] };
  }
  // 2.0.2.2 requires page_num/page_size but ignores them: list_mode=0 is a
  // complete snapshot (verified with page_size=2 and page_num=1,2,5). Never
  // request a second page of that snapshot, or truncate it at the requested size.
  return session.withFileRead(async () => {
    const reply = await session.readFilePage(target.storage, target.directory, 1, ANYCUBIC_PAGE_SIZE);
    const entries = parseAnycubicFilePage(target.path, reply);
    entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name, "ru"));
    return { path: target.path, entries };
  });
}
