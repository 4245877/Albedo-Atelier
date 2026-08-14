import { ValidationError } from "../../../core/errors";
import { capabilitiesOf } from "../capabilities";
import type { PrinterConfig } from "../config";

/**
 * Extensions Klipper/Moonraker can actually print. Anything else (directories,
 * thumbnails, configs) is listed but not startable. Case-insensitive.
 *
 * This is the **default** set, used when no printer is in scope. What a given
 * device can start is a property of its adapter and lives in the capability
 * table (`startableExtensions`): a Bambu printer starts a `.gcode.3mf` plate
 * package, which Moonraker could not execute, and vice versa. Callers that hold
 * a printer pass it, and get that printer's answer.
 */
export const PRINTABLE_EXTENSIONS = [".gcode", ".gco", ".g"] as const;

/** The extensions `printer` can start; the G-code default when none is given. */
export function startableExtensionsFor(
  printer?: PrinterConfig | null
): readonly string[] {
  return printer ? capabilitiesOf(printer).startableExtensions : PRINTABLE_EXTENSIONS;
}

/** Whether a file path ends in an extension `printer` (or Klipper, by default) can start. */
export function isPrintableFile(filePath: string, printer?: PrinterConfig | null): boolean {
  const lower = filePath.toLowerCase();
  return startableExtensionsFor(printer).some((ext) => lower.endsWith(ext));
}

/**
 * Length ceilings. A path component longer than 255 bytes is rejected by every
 * common filesystem the printers use (ext4/FAT/exFAT), and an over-long whole
 * path is how a crafted name gets silently truncated into a *different* file
 * than the one we verified. Both are refused up front rather than repaired.
 */
export const MAX_DEVICE_SEGMENT_LENGTH = 200;
export const MAX_DEVICE_PATH_LENGTH = 400;

export interface NormalizePathOptions {
  /** Allow "" (the G-code root) — used for directory listing, never for start. */
  allowEmpty?: boolean;
}

/**
 * Normalizes a client-supplied printer path to a safe relative form.
 *
 * The result is always relative to the printer's G-code root with `/`
 * separators and no empty/dot segments. Rejected outright (never silently
 * "fixed", so a crafted path cannot degrade into a different valid one):
 * absolute paths, `..`/`.` segments, backslashes, and control characters.
 */
export function normalizePrinterPath(raw: unknown, options: NormalizePathOptions = {}): string {
  if (typeof raw !== "string") {
    throw new ValidationError("Путь к файлу принтера должен быть строкой");
  }

  const value = raw.trim().replace(/\/+$/, "");
  if (!value) {
    if (options.allowEmpty) return "";
    throw new ValidationError("Путь к файлу принтера не может быть пустым");
  }

  if (value.includes("\\")) {
    throw new ValidationError("Путь к файлу принтера не может содержать «\\» — используйте «/»");
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError("Путь к файлу принтера содержит недопустимые символы");
  }
  if (value.startsWith("/")) {
    throw new ValidationError("Абсолютные пути запрещены — укажите путь относительно каталога G-code");
  }
  // A Windows-style drive prefix ("C:name") is absolute on the device even
  // without a leading slash, and ":" is not valid in a FAT/exFAT name anyway.
  if (value.includes(":")) {
    throw new ValidationError("Путь к файлу принтера не может содержать «:»");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_DEVICE_PATH_LENGTH) {
    throw new ValidationError(
      `Путь к файлу принтера длиннее ${MAX_DEVICE_PATH_LENGTH} байт — укоротите имя`
    );
  }

  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment) {
      throw new ValidationError("Путь к файлу принтера содержит пустой сегмент («//»)");
    }
    if (segment === "." || segment === "..") {
      throw new ValidationError("Путь к файлу принтера не может содержать «.» или «..»");
    }
    if (Buffer.byteLength(segment, "utf8") > MAX_DEVICE_SEGMENT_LENGTH) {
      throw new ValidationError(
        `Имя «${segment.slice(0, 40)}…» длиннее ${MAX_DEVICE_SEGMENT_LENGTH} байт — укоротите его`
      );
    }
  }

  return segments.join("/");
}

/**
 * Validates a path for remote start: non-empty, safe, and a file the target
 * adapter can actually start (a directory, or a format that firmware cannot
 * execute, can never be started). Returns the normalized path to pass to
 * `startPrint`.
 *
 * Pass `printer` wherever one is in scope — without it the check falls back to
 * the Klipper G-code set, which would reject a legitimate Bambu plate package.
 */
export function normalizeStartablePath(raw: unknown, printer?: PrinterConfig | null): string {
  const path = normalizePrinterPath(raw);
  if (!isPrintableFile(path, printer)) {
    throw new ValidationError(
      `«${path}» не похож на файл печати — на этом принтере можно запустить только ${startableExtensionsFor(printer).join(", ")}`
    );
  }
  return path;
}
