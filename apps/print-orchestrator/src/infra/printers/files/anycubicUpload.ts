import { getAnycubicSession } from "../anycubic";
import type { AnycubicSession } from "../anycubic/session";
import type { PrinterConfig } from "../config";
import { PrinterCommandError } from "../status/types";
import { fetchWithTimeout } from "../../../shared/fetchWithTimeout";
import { normalizePrinterPath } from "./path";
import { parseAnycubicFilePage } from "./anycubic";
import type { UploadResult } from "./upload";

/** Prepared transport only: both the capability table and session write gate stay closed. */
export async function uploadAnycubicFile(
  printer: PrinterConfig, rawPath: string, bytes: Uint8Array,
  injectedSession?: Pick<AnycubicSession, "uploadAddress" | "withFileRead" | "readFilePage">
): Promise<UploadResult> {
  const normalized = normalizePrinterPath(rawPath);
  const filename = normalized.startsWith("local/") ? normalized.slice(6) : normalized;
  if (filename.includes("/") || !/\.gcode(?:\.3mf)?$/i.test(filename) || bytes.byteLength === 0 || bytes.byteLength > 512 * 1024 * 1024) {
    throw new PrinterCommandError("Anycubic LAN: допустим непустой .gcode или .gcode.3mf в корне памяти, до 512 МБ", true);
  }
  const session = injectedSession ?? getAnycubicSession(printer);
  return session.withFileRead(async () => {
    await session.uploadAddress();
    const before = parseAnycubicFilePage("local", await session.readFilePage("local", "/", 1, 200));
    if (before.some(e => e.path === `local/${filename}`)) throw new PrinterCommandError("Anycubic LAN: файл уже существует — перезапись запрещена", true);
    const url = await session.uploadAddress();
    const form = new FormData();
    form.append("filename", filename);
    const content = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? new Uint8Array(bytes.buffer) : new Uint8Array(bytes);
    form.append("gcode", new Blob([content]), filename);
    try {
      const response = await fetchWithTimeout(url, { method: "POST", body: form, redirect: "error", timeoutMs: 120000,
        headers: { "X-File-Length": String(bytes.byteLength), "X-BBL-Client-Name": "AnycubicSlicerNext", "X-BBL-Client-Type": "slicer" } });
      const result = await readUploadReply(response);
      if (!response.ok || result?.code !== 200) throw new Error("rejected");
    } catch {
      // HTTP exception causes contain the private upload URL. Never propagate them.
      throw new PrinterCommandError("Anycubic LAN: исход загрузки неизвестен — проверьте файл; повтор автоматически не выполняется");
    }
    const after = parseAnycubicFilePage("local", await session.readFilePage("local", "/", 1, 200));
    if (!after.some(e => e.path === `local/${filename}` && e.type === "file" && e.size === bytes.byteLength)) {
      throw new PrinterCommandError("Anycubic LAN: имя и размер загруженного файла не подтверждены");
    }
    return { remotePath: `local/${filename}`, sizeBytes: bytes.byteLength };
  });
}

async function readUploadReply(response: Response): Promise<{ code?: unknown }> {
  if (Number(response.headers.get("content-length")) > 65536) {
    await response.body?.cancel();
    throw new Error("oversized reply");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing reply");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error("oversized reply"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
