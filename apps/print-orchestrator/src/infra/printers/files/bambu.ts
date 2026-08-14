import { requireReady } from "../capabilities";
import type { PrinterConfig } from "../config";
import { PrinterCommandError } from "../status/types";
import { withBambuFtps, BAMBU_FTPS_PORT, type BambuFtpsTarget } from "./bambuFtps";
import { isPrintableFile, normalizePrinterPath } from "./path";
import type { PrinterFileEntry, PrinterFilesListing } from "./types";

/**
 * The Bambu half of the printer file API — listing, upload and delete over the
 * device's own implicit-FTPS server.
 *
 * The transport lives in {@link file://./bambuFtps.ts bambuFtps.ts}; this module
 * is the adapter that turns it into the same shapes the Moonraker adapter
 * produces, so `DeviceArtifactService` and `DispatchService` treat both printers
 * identically and no caller learns a protocol name.
 *
 * One connection per operation, always closed. Bambu's server tolerates very few
 * concurrent sessions, and a pooled connection that silently died is worse than
 * a reconnect: it turns "the printer is unreachable" into "the file is missing",
 * which is a materially different (and dangerous) conclusion for a dispatch.
 */

/** Where prepared files live on the device — the SD-card root, as Bambu Studio uses. */
const BAMBU_ROOT = "";

function targetOf(printer: PrinterConfig): BambuFtpsTarget {
  // Config supplies the MQTT port (8883); FTPS is always its own well-known port.
  return {
    host: printer.host,
    accessCode: printer.accessCode,
    port: BAMBU_FTPS_PORT
  };
}

/**
 * Lists one directory on the printer's SD card.
 *
 * Paths are relative to the SD-card root and normalized exactly like the
 * Moonraker adapter's, so an entry's `path` can be handed straight to the start
 * command.
 */
export async function listBambuFiles(
  printer: PrinterConfig,
  path: string
): Promise<PrinterFilesListing> {
  requireReady(printer);
  const dir = normalizePrinterPath(path, { allowEmpty: true });

  const raw = await withBambuFtps(targetOf(printer), (session) => session.list(dir));

  const entries: PrinterFileEntry[] = raw.map((entry) => {
    const full = dir ? `${dir}/${entry.name}` : entry.name;
    return {
      name: entry.name,
      path: full,
      type: entry.type,
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.modifiedAt ? { modifiedAt: entry.modifiedAt } : {}),
      printable: entry.type === "file" && isPrintableFile(full, printer)
    };
  });

  return { path: dir, entries };
}

/**
 * Uploads a prepared file to the printer's SD card and **verifies the byte count
 * the device now reports**.
 *
 * The size re-read is not decoration. FTPS reports `226 Transfer complete` as
 * soon as it has taken the stream, and a card that filled up mid-write can still
 * produce that reply; the only way to know the whole file landed is to ask the
 * device how big it is. A short file here is a hard error, so the delivery is
 * recorded as `FAILED` rather than becoming a print that stops halfway.
 */
export async function uploadBambuFile(
  printer: PrinterConfig,
  remotePath: string,
  bytes: Uint8Array
): Promise<{ remotePath: string; sizeBytes: number }> {
  requireReady(printer);
  const target = normalizePrinterPath(remotePath);

  const reported = await withBambuFtps(targetOf(printer), async (session) => {
    await session.store(target, bytes);
    // Best-effort: a server that will not answer SIZE leaves this null, which the
    // caller's listing-based verification still catches.
    return session.size(target).catch(() => null);
  });

  if (reported !== null && reported !== bytes.byteLength) {
    throw new PrinterCommandError(
      `Файл «${target}» загружен не полностью: принтер сообщает ${reported} байт вместо ${bytes.byteLength} — повторите подготовку`
    );
  }

  return { remotePath: target, sizeBytes: bytes.byteLength };
}

/** Deletes one file from the printer's SD card. */
export async function deleteBambuFile(printer: PrinterConfig, remotePath: string): Promise<void> {
  requireReady(printer);
  const target = normalizePrinterPath(remotePath);
  await withBambuFtps(targetOf(printer), (session) => session.delete(target));
}

export { BAMBU_ROOT };
