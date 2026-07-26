import { capabilitiesOf, requireCapability } from "../capabilities";
import type { PrinterConfig } from "../config";
import { listMoonrakerFiles } from "./moonraker";
import type { PrinterFilesListing } from "./types";

/**
 * Browsing the files stored on the printer, one adapter per protocol. What each
 * adapter can do is declared once in {@link file://../capabilities.ts
 * capabilities.ts}; this module only dispatches to the implementation. Only
 * Moonraker exposes a well-defined HTTP file API; Bambu (MQTT/FTP) and the
 * Creality WebSocket protocol are reported honestly as unsupported rather
 * than faked — mirroring the remote-start policy in `../status`.
 */

export type { PrinterFileEntry, PrinterFilesListing } from "./types";
export type { UploadResult } from "./upload";
export { MAX_DEVICE_UPLOAD_BYTES, supportsPrinterUpload, uploadPrinterFile } from "./upload";
export { buildDeviceFileName, isGeneratedDeviceFileName } from "./name";
export type { DeviceFileNameInput } from "./name";
export {
  isPrintableFile,
  MAX_DEVICE_PATH_LENGTH,
  MAX_DEVICE_SEGMENT_LENGTH,
  normalizePrinterPath,
  normalizeStartablePath,
  PRINTABLE_EXTENSIONS
} from "./path";

/** Whether browsing on-device files is implemented for this printer's adapter. */
export function supportsPrinterFiles(printer: PrinterConfig): boolean {
  return capabilitiesOf(printer).supportsFileListing;
}

/**
 * Lists one directory of the printer's storage. Supported for Moonraker;
 * other protocols throw a structured {@link PrinterCapabilityError} rather than
 * an empty listing that would read as "no files there".
 */
export async function fetchPrinterFiles(
  printer: PrinterConfig,
  path: string
): Promise<PrinterFilesListing> {
  requireCapability(printer, "supportsFileListing", "проверьте файл на самом принтере");
  return listMoonrakerFiles(printer, path);
}
