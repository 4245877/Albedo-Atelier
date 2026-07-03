import tls from "node:tls";
import { PassThrough } from "node:stream";

import type { PrinterConfig } from "../config";
import {
  BAMBU_CAMERA_PORT,
  BAMBU_MJPEG_MIME,
  buildBambuCameraAuthPacket,
  JPEG_EOI,
  JPEG_SOI,
  writeMjpegFrame
} from "./bambuProtocol";
import { DEFAULT_MAX_BYTES } from "./constants";
import type { CameraFrame, CameraStream } from "./types";
import { hostWithoutPort } from "./urls";

/**
 * Shared Bambu liveview fan-out.
 *
 * The A1's liveview service on port 6000 effectively serves one client at a
 * time, yet the dashboard shows a printer's camera in several tiles at once
 * (card + camera thumbnail + modal). Opening a fresh TLS connection per tile
 * makes those viewers fight over the single stream — frames split, "losers"
 * error out and reconnect every few seconds, and the FPS collapses.
 *
 * This module keeps exactly ONE upstream TLS connection per printer and
 * broadcasts its JPEG frames as MJPEG to every attached HTTP client — the same
 * single-producer / many-consumer shape go2rtc gives the Creality K2. N tiles
 * therefore cost one connection to the printer, not N.
 */

// Keep the upstream connection alive briefly after the last viewer leaves so a
// board redraw (old tile detaches, new one attaches) reuses it instead of
// reconnecting.
const LINGER_MS = 10_000;

// While connected, no frame for this long means the upstream has stalled — tear
// it down so viewers reconnect against a fresh socket.
const STALL_MS = 15_000;

// A viewer that falls this far behind (slow client / paused tab) has its frames
// dropped rather than buffered without bound; this keeps one slow consumer from
// growing memory or stalling the shared upstream for everyone else.
const MAX_SUBSCRIBER_BACKLOG_BYTES = 4_000_000;

// How stale a broadcast frame may be to still serve as a snapshot/liveness
// answer without opening a separate probe connection.
const DEFAULT_PEEK_MAX_AGE_MS = 15_000;

interface Subscriber {
  body: PassThrough;
  /** Resolve the pending subscribe promise once frames flow (or `null` on failure). */
  open: (() => void) | null;
  fail: (() => void) | null;
}

class BambuLiveviewSource {
  private socket: tls.TLSSocket | null = null;
  private connecting = false;
  private connected = false;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly subscribers = new Set<Subscriber>();
  private latestFrame: Buffer | null = null;
  private latestFrameAt = 0;
  private lingerTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly host: string,
    readonly accessCode: string,
    private readonly maxBytes: number
  ) {}

  /** The most recent frame if it is younger than `maxAgeMs`, else null. */
  peekFrame(maxAgeMs: number): CameraFrame | null {
    if (this.latestFrame && Date.now() - this.latestFrameAt <= maxAgeMs) {
      return { data: Buffer.from(this.latestFrame), mime: "image/jpeg" };
    }
    return null;
  }

  /** Attach a viewer; resolves once frames flow, or null on connect timeout. */
  addSubscriber(timeoutMs: number): Promise<CameraStream | null> {
    return new Promise((resolve) => {
      const body = new PassThrough();
      body.on("error", () => {});

      const sub: Subscriber = { body, open: null, fail: null };
      const stream: CameraStream = {
        body,
        mime: BAMBU_MJPEG_MIME,
        close: () => this.removeSubscriber(sub)
      };

      let done = false;
      const finish = (result: CameraStream | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub.open = null;
        sub.fail = null;
        if (!result) this.removeSubscriber(sub);
        resolve(result);
      };
      sub.open = () => finish(stream);
      sub.fail = () => finish(null);

      const timer = setTimeout(() => finish(null), timeoutMs);

      this.subscribers.add(sub);
      this.cancelLinger();

      // When the upstream is already live, a buffered frame lets a new tile show
      // a picture immediately and marks the subscription live without waiting for
      // the next frame. We require an active connection so a reconnecting viewer
      // never gets frozen on a stale frame from a printer that has since dropped —
      // in that case it waits for a real frame (or times out and reconnects).
      if (this.connected && this.latestFrame) {
        writeMjpegFrame(body, this.latestFrame);
        finish(stream);
      }

      this.ensureConnected(timeoutMs);
    });
  }

  private removeSubscriber(sub: Subscriber): void {
    if (!this.subscribers.delete(sub)) return;
    try {
      sub.body.end();
    } catch {
      // ignore
    }
    if (this.subscribers.size === 0) this.scheduleLinger();
  }

  private ensureConnected(timeoutMs: number): void {
    if (this.socket || this.connecting) return;
    this.connecting = true;

    let socket: tls.TLSSocket;
    try {
      socket = tls.connect(
        { host: this.host, port: BAMBU_CAMERA_PORT, rejectUnauthorized: false, timeout: timeoutMs },
        () => {
          this.connecting = false;
          this.connected = true;
          socket.setNoDelay(true);
          socket.write(buildBambuCameraAuthPacket(this.accessCode));
        }
      );
    } catch {
      this.connecting = false;
      this.teardownUpstream();
      return;
    }

    this.socket = socket;
    this.resetStall();

    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.flushFrames();
    });
    socket.on("timeout", () => this.teardownUpstream());
    socket.on("error", () => this.teardownUpstream());
    socket.on("close", () => this.teardownUpstream());
  }

  private flushFrames(): void {
    for (;;) {
      const start = this.buffer.indexOf(JPEG_SOI);
      if (start < 0) {
        // Keep only a trailing byte — it may be the first half of a split SOI.
        this.buffer =
          this.buffer.length > 1 ? this.buffer.subarray(this.buffer.length - 1) : this.buffer;
        return;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);

      const end = this.buffer.indexOf(JPEG_EOI, JPEG_SOI.length);
      if (end < 0) {
        if (this.buffer.byteLength > this.maxBytes) this.teardownUpstream();
        return;
      }

      const frame = this.buffer.subarray(0, end + JPEG_EOI.length);
      this.buffer = this.buffer.subarray(end + JPEG_EOI.length);

      if (frame.byteLength > this.maxBytes) {
        this.teardownUpstream();
        return;
      }

      this.broadcast(Buffer.from(frame));
    }
  }

  private broadcast(frame: Buffer): void {
    this.latestFrame = frame;
    this.latestFrameAt = Date.now();
    this.resetStall();

    for (const sub of this.subscribers) {
      // Drop frames for a viewer that has fallen behind instead of buffering
      // unboundedly or pausing the shared upstream for the others.
      if (sub.body.writableLength <= MAX_SUBSCRIBER_BACKLOG_BYTES) {
        writeMjpegFrame(sub.body, frame);
      }
      if (sub.open) sub.open();
    }
  }

  private teardownUpstream(): void {
    this.connecting = false;
    this.connected = false;
    this.clearStall();
    this.buffer = Buffer.alloc(0);

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }

    // End every viewer's response so its browser player reconnects; the first
    // reconnecting client re-establishes a single upstream connection.
    const subs = [...this.subscribers];
    this.subscribers.clear();
    for (const sub of subs) {
      if (sub.fail) sub.fail();
      try {
        sub.body.end();
      } catch {
        // ignore
      }
    }
  }

  private resetStall(): void {
    this.clearStall();
    this.stallTimer = setTimeout(() => this.teardownUpstream(), STALL_MS);
  }

  private clearStall(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private scheduleLinger(): void {
    this.cancelLinger();
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.subscribers.size === 0) this.teardownUpstream();
    }, LINGER_MS);
  }

  private cancelLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  dispose(): void {
    this.cancelLinger();
    this.teardownUpstream();
  }
}

const sources = new Map<string, BambuLiveviewSource>();

function sourceFor(printer: PrinterConfig, maxBytes: number): BambuLiveviewSource | null {
  const accessCode = printer.accessCode.trim();
  const host = hostWithoutPort(printer.host.trim());
  if (!accessCode || !host) return null;

  let src = sources.get(printer.id);
  if (!src || src.host !== host || src.accessCode !== accessCode) {
    src?.dispose(); // config changed — replace the stale source
    src = new BambuLiveviewSource(host, accessCode, maxBytes);
    sources.set(printer.id, src);
  }
  return src;
}

/** Subscribe an HTTP viewer to the printer's shared MJPEG broadcast. */
export function subscribeBambuLiveview(
  printer: PrinterConfig,
  timeoutMs: number,
  maxBytes: number = DEFAULT_MAX_BYTES
): Promise<CameraStream | null> {
  const src = sourceFor(printer, maxBytes);
  return src ? src.addSubscriber(timeoutMs) : Promise.resolve(null);
}

/**
 * The latest broadcast frame for a printer, if a viewer is currently watching
 * and the frame is fresh. Lets snapshot/liveness reuse the live stream instead
 * of opening a competing connection to port 6000.
 */
export function peekBambuLiveviewFrame(
  printer: PrinterConfig,
  maxAgeMs: number = DEFAULT_PEEK_MAX_AGE_MS
): CameraFrame | null {
  const src = sources.get(printer.id);
  return src ? src.peekFrame(maxAgeMs) : null;
}
