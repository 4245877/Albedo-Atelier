import { fetchWithTimeout } from "../../../shared/fetchWithTimeout";
import type { PrinterConfig } from "../config";
import { moonrakerBaseUrl, moonrakerHeaders } from "../status/moonraker";
import { PrinterCommandError } from "../status/types";
import { normalizeStartablePath } from "./path";

/**
 * Pushing a prepared file **to** a printer — the transport the slice→print chain
 * was missing entirely (files could be listed and started, never delivered).
 *
 * Only Moonraker offers a defined upload API. Bambu (MQTT + FTP) and the Creality
 * WebSocket protocol have no implemented upload here and are reported as
 * unsupported rather than faked: for those the operator copies the file and
 * confirms it, and the eligibility check refuses an unconfirmed start
 * (`DEVICE_TRANSFER_NOT_CONFIRMED`).
 */

const MOONRAKER_UPLOAD_TIMEOUT_MS = 120_000;

/** Whether the orchestrator can push a file over this protocol. */
export function supportsPrinterUpload(protocol: string | null | undefined): boolean {
  return protocol === "moonraker";
}

export interface UploadResult {
  /** The normalized path the file now occupies, relative to the G-code root. */
  remotePath: string;
  /** Bytes sent (what the device should report back on a listing). */
  sizeBytes: number;
}

/**
 * Uploads `bytes` to `remotePath` on the printer.
 *
 * No shell, no path interpolation into a command line: the path is validated by
 * {@link normalizeStartablePath} (which rejects traversal, absolute paths and
 * non-printable extensions) and then sent as a multipart form field. A non-2xx
 * answer is an honest {@link PrinterCommandError} — nothing is retried here, the
 * caller decides.
 */
export async function uploadPrinterFile(
  printer: PrinterConfig,
  remotePath: string,
  bytes: Uint8Array
): Promise<UploadResult> {
  if (printer.protocol !== "moonraker") {
    throw new PrinterCommandError(
      `Загрузка файлов для протокола «${printer.protocol}» не реализована — перенесите файл вручную`
    );
  }

  const target = normalizeStartablePath(remotePath);
  const slash = target.lastIndexOf("/");
  const dir = slash === -1 ? "" : target.slice(0, slash);
  const name = slash === -1 ? target : target.slice(slash + 1);

  const form = new FormData();
  // Copy into a fresh buffer so the Blob never aliases a pooled Node buffer.
  form.append("file", new Blob([new Uint8Array(bytes)]), name);
  form.append("root", "gcodes");
  if (dir) form.append("path", dir);
  // Explicitly do NOT ask Moonraker to start the print: delivery and dispatch are
  // separate steps, and a start may only come from the canonical dispatch path.
  form.append("print", "false");

  const res = await fetchWithTimeout(`${moonrakerBaseUrl(printer)}/server/files/upload`, {
    method: "POST",
    body: form,
    timeoutMs: MOONRAKER_UPLOAD_TIMEOUT_MS,
    headers: moonrakerHeaders(printer)
  });
  if (!res.ok) {
    throw new PrinterCommandError(
      `Не удалось загрузить «${target}» на «${printer.name}»: Moonraker HTTP ${res.status}`
    );
  }

  return { remotePath: target, sizeBytes: bytes.byteLength };
}
