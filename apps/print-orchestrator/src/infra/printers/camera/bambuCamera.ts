import tls from "node:tls";

import type { PrinterConfig } from "../config";
import type { CameraFrame } from "./types";
import { hostWithoutPort } from "./urls";

/**
 * Bambu printers have no HTTP snapshot endpoint — a frame is grabbed from their
 * local TLS "LAN liveview" stream on port 6000 instead. Ported from
 * apps/fulfillment (`bambuCamera.ts`).
 */

const BAMBU_CAMERA_PORT = 6000;
const BAMBU_CAMERA_USERNAME = "bblp";
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

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

export function captureBambuCameraFrame(
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
