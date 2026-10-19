/** Token-bearing addresses are accepted only for the configured device and known endpoint. */
export function anycubicPrivateUrl(raw: unknown, host: string, kind: "camera" | "upload"): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.hostname.replace(/^\[|\]$/g, "").toLowerCase() !== host.replace(/^\[|\]$/g, "").toLowerCase() ||
        url.username || url.password || url.hash) return null;
    if (kind === "camera") {
      if (url.port !== "18088" || !/^\/live\/[A-Za-z0-9_-]+(?:\.flv)?$/.test(url.pathname) || url.search) return null;
    } else {
      if (url.port !== "18910" || url.pathname !== "/gcode_upload" || !url.searchParams.get("s") ||
          [...url.searchParams.keys()].length !== 1) return null;
    }
    return url.href;
  } catch { return null; }
}
