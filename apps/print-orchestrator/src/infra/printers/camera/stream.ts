import { Readable } from "node:stream";

import type { PrinterConfig } from "../config";
import { openBambuCameraStream } from "./bambuCamera";
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from "./constants";
import type { CameraStream } from "./types";
import { resolveStreamUrl } from "./urls";

/** Opens a live camera stream. The caller owns closing the returned stream. */
export async function openCameraStream(
  printer: PrinterConfig,
  options: { timeoutMs?: number } = {}
): Promise<CameraStream | null> {
  if (printer.protocol === "bambu" && printer.accessCode.trim()) {
    return openBambuCameraStream(
      printer,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      DEFAULT_MAX_BYTES
    );
  }

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
