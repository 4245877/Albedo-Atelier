import { Readable } from "node:stream";
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

export interface CameraStream {
  body: Readable;
  mime: string;
  close: () => void;
}

// go2rtc can need several seconds to negotiate the Creality K2 WebRTC source
// and wait for the first keyframe when the bridge is cold.
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 3_000_000;

// Reading go2rtc's /api/streams is a cheap local JSON call — it must return
// fast or the go2rtc bridge is effectively down, so keep the timeout tight.
const GO2RTC_PROBE_TIMEOUT_MS = 2500;

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

/** Resolves an explicitly configured live stream URL suitable for proxying. */
export function resolveStreamUrl(printer: PrinterConfig): string | null {
  const explicit = printer.streamUrl.trim();
  if (!explicit) return null;

  if (/^https?:\/\//i.test(explicit)) return explicit;
  const path = explicit.startsWith("/") ? explicit : `/${explicit}`;
  return `http://${hostWithoutPort(printer.host)}${path}`;
}

/** True when an HTTP live stream route is usable for this printer. */
export function hasCameraStream(printer: PrinterConfig): boolean {
  if (!resolveStreamUrl(printer)) return false;
  return resolveWebrtcSource(printer) === null;
}

/**
 * The go2rtc stream name for a printer's WebRTC view, parsed from a go2rtc-style
 * stream URL (e.g. `…/api/stream.mp4?src=k2` → `"k2"`). Returns null when the
 * stream is not a go2rtc source — WebRTC (which the browser reaches directly via
 * the `/go2rtc/` proxy) is the only transport that gets keyframes out of the
 * Creality K2, so this name is what the dashboard streams over WebRTC.
 */
export function resolveWebrtcSource(printer: PrinterConfig): string | null {
  const explicit = printer.streamUrl.trim();
  if (!explicit || !/\/api\//.test(explicit)) return null;
  const match = /[?&]src=([^&]+)/.exec(explicit);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** True when the printer has any camera source we can try. */
export function hasCameraSource(printer: PrinterConfig): boolean {
  if (resolveSnapshotUrl(printer)) return true;
  return printer.protocol === "bambu" && Boolean(printer.accessCode);
}

/**
 * True when the camera is served by go2rtc and viewed over WebRTC (a go2rtc
 * `…/api/…?src=…` stream URL). For these the browser reaches the live video
 * directly over WebRTC, and liveness is probed via {@link probeGo2RtcStream} —
 * never by pulling `frame.jpeg`, which hangs on the Creality K2 (it only emits
 * a keyframe to an active WebRTC client, so a passive still-image request waits
 * ~60s for an IDR that never comes without one).
 */
export function isGo2RtcCamera(printer: PrinterConfig): boolean {
  return resolveWebrtcSource(printer) !== null;
}

/**
 * The go2rtc API origin for a printer's camera, e.g. `http://go2rtc:1984`,
 * parsed from its go2rtc-style stream (or snapshot) URL. Returns null when the
 * printer is not a go2rtc source.
 */
export function resolveGo2RtcApiBase(printer: PrinterConfig): string | null {
  for (const raw of [printer.streamUrl, printer.snapshotUrl]) {
    const value = raw.trim();
    if (!value || !/\/api\//.test(value)) continue;
    try {
      const parsed = new URL(value);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      // Not an absolute URL — try the next candidate.
    }
  }
  return null;
}

/**
 * A go2rtc stream counts as available when it is present and configured in
 * `/api/streams`. go2rtc connects a producer to the upstream camera lazily —
 * only while a consumer (a watching WebRTC client) is attached — so an
 * idle-but-configured stream has an empty producer list. Presence of the stream
 * entry therefore means go2rtc is up and the bridge is set up, which is the
 * honest "reachable over WebRTC" signal; requiring an active producer would
 * flap the status to offline whenever nobody happens to be watching.
 */
function isGo2RtcStreamLive(stream: unknown): boolean {
  return Boolean(stream) && typeof stream === "object";
}

/**
 * Fast liveness probe for a go2rtc/WebRTC camera. Reads `GET /api/streams` and
 * reports online when go2rtc has the printer's stream configured. This never
 * pulls a frame, so — unlike {@link captureCameraFrame} against `frame.jpeg` —
 * it cannot stall the poll loop or leave idle consumers behind. Returns `false`
 * (never throws) when go2rtc is unreachable or the stream is missing.
 */
export async function probeGo2RtcStream(
  printer: PrinterConfig,
  options: { timeoutMs?: number } = {}
): Promise<boolean> {
  const base = resolveGo2RtcApiBase(printer);
  const src = resolveWebrtcSource(printer);
  if (!base || !src) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? GO2RTC_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/api/streams`, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return false;

    const body = (await response.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return false;

    return isGo2RtcStreamLive(body[src]);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
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

/** Opens a live camera stream. The caller owns closing the returned stream. */
export async function openCameraStream(
  printer: PrinterConfig,
  options: { timeoutMs?: number } = {}
): Promise<CameraStream | null> {
  const url = resolveStreamUrl(printer);
  if (!url) return null;

  const controller = new AbortController();
  // The timeout guards only connection setup — negotiating the source and
  // receiving the response headers. Once frames start flowing the stream must
  // never be torn down on a timer, so the timer is cleared the moment headers
  // arrive; the ongoing stream lives until the client disconnects.
  const connectTimer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(connectTimer);

    if (!response.ok || !response.body) {
      controller.abort();
      return null;
    }

    const contentType = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();

    if (
      contentType &&
      !contentType.startsWith("video/") &&
      contentType !== "application/vnd.apple.mpegurl"
    ) {
      controller.abort();
      return null;
    }

    const body = Readable.fromWeb(response.body);
    // Aborting the fetch (client disconnect) or an upstream reset surfaces as an
    // 'error' on the Node stream. A dropped live stream is expected — the client
    // reconnects — so swallow it here instead of letting it bubble as an
    // unhandled error and spam the logs or crash the process.
    body.on("error", () => {});

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      controller.abort();
      body.destroy();
    };

    return { body, mime: contentType || "video/mp4", close };
  } catch {
    clearTimeout(connectTimer);
    controller.abort();
    return null;
  }
}
