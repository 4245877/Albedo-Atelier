import type { Writable } from "node:stream";

/**
 * Low-level Bambu "LAN liveview" protocol helpers, shared by the one-shot frame
 * grab ({@link ./bambuCamera}) and the fan-out broadcaster ({@link ./bambuLiveview}).
 *
 * Bambu printers expose no HTTP snapshot endpoint — the camera is a raw JPEG
 * push over a local TLS socket on port 6000, unlocked by an 80-byte auth packet.
 */

export const BAMBU_CAMERA_PORT = 6000;
const BAMBU_CAMERA_USERNAME = "bblp";
const BAMBU_MJPEG_BOUNDARY = "bambu-liveview";

export const BAMBU_MJPEG_MIME = `multipart/x-mixed-replace; boundary=${BAMBU_MJPEG_BOUNDARY}`;

export const JPEG_SOI = Buffer.from([0xff, 0xd8]);
export const JPEG_EOI = Buffer.from([0xff, 0xd9]);

/**
 * The 80-byte auth packet the Bambu camera expects before it starts streaming:
 * a 16-byte header, then username and LAN access code in 32-byte fields.
 */
export function buildBambuCameraAuthPacket(accessCode: string): Buffer {
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
export function extractJpegFrame(buffer: Buffer): Buffer | null {
  const start = buffer.indexOf(JPEG_SOI);
  if (start < 0) return null;
  const end = buffer.indexOf(JPEG_EOI, start + JPEG_SOI.length);
  if (end < 0) return null;
  return buffer.subarray(start, end + JPEG_EOI.length);
}

/** Writes one MJPEG multipart part for `frame` to a subscriber body. */
export function writeMjpegFrame(body: Writable, frame: Buffer): boolean {
  const header = Buffer.from(
    `--${BAMBU_MJPEG_BOUNDARY}\r\n` +
      "Content-Type: image/jpeg\r\n" +
      `Content-Length: ${frame.byteLength}\r\n\r\n`,
    "ascii"
  );
  const tail = Buffer.from("\r\n", "ascii");
  return body.write(Buffer.concat([header, frame, tail]));
}
