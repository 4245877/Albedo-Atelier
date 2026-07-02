import tls from "node:tls";

import type { PrinterConfig } from "./config";

/**
 * Camera snapshot capture, ported from apps/fulfillment
 * (`modules/printers/snapshot.ts` + `bambuCamera.ts`).
 *
 * A snapshot URL is taken from the printer config when set, otherwise the
 * conventional per-protocol endpoint is tried. Bambu printers have no HTTP
 * snapshot endpoint — a frame is grabbed from their local TLS "LAN liveview"
 * stream on port 6000 instead. All failure modes return `null`; callers report
 * the camera as unavailable rather than showing a fake picture.
 */

export interface CameraFrame {
  data: Buffer;
  mime: string;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_BYTES = 3_000_000;

const BAMBU_CAMERA_PORT = 6000;
const BAMBU_CAMERA_USERNAME = "bblp";
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function hostWithoutPort(host: string): string {
  return host.replace(/:\d+$/, "");
}

/** Resolves the still-image URL for a printer's camera, or null when none. */
export function resolveSnapshotUrl(printer: PrinterConfig): string | null {
  const explicit = printer.snapshotUrl.trim();
  if (explicit) {
    if (/^https?:\/\//i.test(explicit)) return explicit;
    const path = explicit.startsWith("/") ? explicit : `/${explicit}`;
    return `http://${hostWithoutPort(printer.host)}${path}`;
  }

  const host = hostWithoutPort(printer.host);
  if (printer.protocol === "moonraker") return `http://${host}/webcam/?action=snapshot`;
  if (printer.protocol === "creality") return `http://${host}:8080/?action=snapshot`;

  return null;
}

/** True when the printer has any camera source we can try. */
export function hasCameraSource(printer: PrinterConfig): boolean {
  if (resolveSnapshotUrl(printer)) return true;
  return printer.protocol === "bambu" && Boolean(printer.accessCode);
}

/**
 * The 80-byte auth packet the Bambu camera expects before it starts streaming:
 * a 16-byte header, then username and LAN access code in 32-byte fields.
 */
function buildBambuCameraAuthPacket(accessCode: string): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(0x40, 0);
  header.writeUInt32LE(0x3000, 4);

  const username = Buffer.alloc(32);
  username.write(BAMBU_CAMERA_USERNAME, "ascii");

  const code = Buffer.alloc(32);
  code.write(accessCode, "ascii");

  return Buffer.concat([header, username, code]);
}

/** First complete JPEG frame (SOI…EOI) in the stream buffer, or null. */
function extractJpegFrame(buffer: Buffer): Buffer | null {
  const start = buffer.indexOf(JPEG_SOI);
  if (start < 0) return null;
  const end = buffer.indexOf(JPEG_EOI, start + JPEG_SOI.length);
  if (end < 0) return null;
  return buffer.subarray(start, end + JPEG_EOI.length);
}

function captureBambuCameraFrame(
  printer: PrinterConfig,
  timeoutMs: number,
  maxBytes: number
): Promise<CameraFrame | null> {
  const accessCode = printer.accessCode.trim();
  const host = hostWithoutPort(printer.host.trim());
  if (!accessCode || !host) return Promise.resolve(null);

  return new Promise((resolve) => {
    let buffer: Buffer = Buffer.alloc(0);
    let settled = false;
    let socket: tls.TLSSocket;

    const finish = (result: CameraFrame | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      socket = tls.connect(
        { host, port: BAMBU_CAMERA_PORT, rejectUnauthorized: false, timeout: timeoutMs },
        () => {
          socket.write(buildBambuCameraAuthPacket(accessCode));
        }
      );
    } catch {
      finish(null);
      return;
    }

    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      const frame = extractJpegFrame(buffer);
      if (frame) {
        finish({ data: Buffer.from(frame), mime: "image/jpeg" });
        return;
      }
      if (buffer.byteLength > maxBytes) {
        finish(null);
      }
    });

    socket.on("timeout", () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/**
 * Fetches a single real camera frame for the printer. Returns `null` (never
 * throws) when no camera is configured, the request fails/times out, or the
 * response is not a reasonably sized image.
 */
export async function captureCameraFrame(
  printer: PrinterConfig,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<CameraFrame | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const url = resolveSnapshotUrl(printer);
  if (!url) {
    if (printer.protocol === "bambu") {
      return captureBambuCameraFrame(printer, timeoutMs, maxBytes);
    }
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;

    const contentType = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (contentType && !contentType.startsWith("image/")) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) return null;

    return { data: buffer, mime: contentType || "image/jpeg" };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
