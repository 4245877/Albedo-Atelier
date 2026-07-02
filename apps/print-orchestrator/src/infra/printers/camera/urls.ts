import type { PrinterConfig } from "../config";

/**
 * Camera URL resolving and capability predicates. A snapshot URL is taken from
 * the printer config when set, otherwise the conventional per-protocol endpoint
 * is tried. go2rtc-backed cameras (Creality K2) are recognised by their
 * `…/api/…?src=…` stream URL and viewed over WebRTC.
 */

export function hostWithoutPort(host: string): string {
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
 * directly over WebRTC, and liveness is probed via `probeGo2RtcStream` — never
 * by pulling `frame.jpeg`, which hangs on the Creality K2 (it only emits a
 * keyframe to an active WebRTC client, so a passive still-image request waits
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
