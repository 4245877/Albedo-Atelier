import type { PrinterConfig } from "../config";
import { PrinterCommandError } from "../status/types";
import { listMoonrakerFiles } from "./moonraker";
import type { PrinterFilesListing } from "./types";

/**
 * Browsing the files stored on the printer, one adapter per protocol. Only
 * Moonraker exposes a well-defined HTTP file API; Bambu (MQTT/FTP) and the
 * Creality WebSocket protocol are reported honestly as unsupported rather
 * than faked — mirroring the remote-start policy in `../status`.
 */

export type { PrinterFileEntry, PrinterFilesListing } from "./types";
export {
  isPrintableFile,
  normalizePrinterPath,
  normalizeStartablePath,
  PRINTABLE_EXTENSIONS
} from "./path";

/** Whether browsing on-device files is implemented for this protocol. */
export function supportsPrinterFiles(printer: PrinterConfig): boolean {
  return printer.protocol === "moonraker";
}

/**
 * Lists one directory of the printer's storage. Supported for Moonraker;
 * other protocols throw an honest {@link PrinterCommandError}.
 */
export async function fetchPrinterFiles(
  printer: PrinterConfig,
  path: string
): Promise<PrinterFilesListing> {
  if (printer.protocol === "moonraker") return listMoonrakerFiles(printer, path);
  throw new PrinterCommandError(
    `Просмотр файлов для протокола «${printer.protocol}» пока не поддерживается — только Moonraker-принтеры`
  );
}
