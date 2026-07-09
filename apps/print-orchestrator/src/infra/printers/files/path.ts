import { ValidationError } from "../../../core/errors";

/**
 * Extensions Klipper/Moonraker can actually print. Anything else (directories,
 * thumbnails, configs) is listed but not startable. Case-insensitive.
 */
export const PRINTABLE_EXTENSIONS = [".gcode", ".gco", ".g"] as const;

/** Whether a file path ends in a printable G-code extension. */
export function isPrintableFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return PRINTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

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

  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment) {
      throw new ValidationError("Путь к файлу принтера содержит пустой сегмент («//»)");
    }
    if (segment === "." || segment === "..") {
      throw new ValidationError("Путь к файлу принтера не может содержать «.» или «..»");
    }
  }

  return segments.join("/");
}

/**
 * Validates a path for remote start: non-empty, safe, and a printable file
 * (a directory or a non-G-code file can never be started). Returns the
 * normalized path to pass to `startPrint`.
 */
export function normalizeStartablePath(raw: unknown): string {
  const path = normalizePrinterPath(raw);
  if (!isPrintableFile(path)) {
    throw new ValidationError(
      `«${path}» не похож на файл печати — удалённо можно запустить только ${PRINTABLE_EXTENSIONS.join(", ")}`
    );
  }
  return path;
}
