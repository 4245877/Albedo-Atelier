import type { PrinterConfig } from "../config";
import { captureBambuCameraFrame } from "./bambuCamera";
import { peekBambuLiveviewFrame } from "./bambuLiveview";
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from "./constants";
import type { CameraFrame } from "./types";
import { resolveSnapshotUrl } from "./urls";

/**
 * Fetches a single real camera frame for the printer. Returns `null` (never
 * throws) when no camera is configured, the request fails/times out, or the
 * response is not a reasonably sized image. Bambu printers fall back to the
 * local TLS liveview stream (see {@link captureBambuCameraFrame}).
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
      // If a viewer is already streaming this camera, grab the freshest frame
      // from the shared broadcast instead of opening a competing connection to
      // port 6000 (which would fight the live stream for the single slot).
      const live = peekBambuLiveviewFrame(printer);
      if (live) return live;
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
