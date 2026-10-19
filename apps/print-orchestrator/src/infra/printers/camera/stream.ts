import { Readable } from "node:stream";

import type { PrinterConfig } from "../config";
import { getAnycubicSession } from "../anycubic";
import { subscribeBambuLiveview } from "./bambuLiveview";
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from "./constants";
import type { CameraStream } from "./types";
import { resolveStreamUrl } from "./urls";

/** Opens a live camera stream. The caller owns closing the returned stream. */
export async function openCameraStream(
  printer: PrinterConfig,
  options: { timeoutMs?: number } = {}
): Promise<CameraStream | null> {
  if (printer.protocol === "bambu" && printer.accessCode.trim()) {
    // Attach to the shared per-printer broadcaster so every tile viewing this
    // camera rides one upstream TLS connection instead of one connection each.
    return subscribeBambuLiveview(
      printer,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      DEFAULT_MAX_BYTES
    );
  }

  const controller = new AbortController();
  let url = resolveStreamUrl(printer);
  let release = (): void => {};
  if (printer.protocol === "anycubic-lan") {
    // Native HTTP-FLV is already available without startCapture on 2.0.2.2.
    // go2rtc 1.9.14 refuses its HTTP 206, so the existing proxy supplies HTTP
    // 200, hides the rotating token and owns one upstream for all WebRTC viewers.
    try {
      const session = getAnycubicSession(printer);
      if ((await session.readPeripheral()).cameraPresent !== true) return null;
      await session.refreshInfo();
      const lease = session.leaseCameraSource(() => controller.abort());
      url = lease.url;
      release = lease.release;
    } catch { return null; }
  }
  if (!url) return null;
  // The timeout guards only connection setup — negotiating the source and
  // receiving the response headers. Once frames start flowing the stream must
  // never be torn down on a timer, so the timer is cleared the moment headers
  // arrive; the ongoing stream lives until the client disconnects.
  const connectTimer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal, ...(printer.protocol === "anycubic-lan" ? { redirect: "error" as const } : {}) });
    clearTimeout(connectTimer);

    if (!response.ok || !response.body) {
      controller.abort();
      release();
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
      release();
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
      release();
    };
    body.once("close", close);

    return { body, mime: contentType || "video/mp4", close };
  } catch {
    clearTimeout(connectTimer);
    controller.abort();
    release();
    return null;
  }
}
