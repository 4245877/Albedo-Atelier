import { fetchWithTimeout } from "../../../shared/fetchWithTimeout";
import type { PrinterConfig } from "../config";
import { resolveGo2RtcApiBase, resolveWebrtcSource } from "./urls";

// Reading go2rtc's /api/streams is a cheap local JSON call — it must return
// fast or the go2rtc bridge is effectively down, so keep the timeout tight.
const GO2RTC_PROBE_TIMEOUT_MS = 2500;

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
 * pulls a frame, so — unlike `captureCameraFrame` against `frame.jpeg` — it
 * cannot stall the poll loop or leave idle consumers behind. Returns `false`
 * (never throws) when go2rtc is unreachable or the stream is missing.
 */
export async function probeGo2RtcStream(
  printer: PrinterConfig,
  options: { timeoutMs?: number } = {}
): Promise<boolean> {
  const base = resolveGo2RtcApiBase(printer);
  const src = resolveWebrtcSource(printer);
  if (!base || !src) return false;

  try {
    const response = await fetchWithTimeout(`${base}/api/streams`, {
      timeoutMs: options.timeoutMs ?? GO2RTC_PROBE_TIMEOUT_MS,
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return false;

    const body = (await response.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return false;

    return isGo2RtcStreamLive(body[src]);
  } catch {
    return false;
  }
}
