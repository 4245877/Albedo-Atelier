import tls from "node:tls";

import type { PrinterConfig } from "../config";
import {
  BAMBU_CAMERA_PORT,
  buildBambuCameraAuthPacket,
  extractJpegFrame
} from "./bambuProtocol";
import type { CameraFrame } from "./types";
import { hostWithoutPort } from "./urls";

/**
 * One-shot Bambu camera frame grab over the local TLS "LAN liveview" stream on
 * port 6000. Used as a snapshot/liveness fallback when no live viewer is
 * attached; while a viewer is watching, frames are peeked from the shared
 * broadcaster instead (see {@link ./bambuLiveview}). Ported from
 * apps/fulfillment (`bambuCamera.ts`).
 */
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
