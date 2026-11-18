export const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";

export async function probeCdp() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const version = await response.json();
    if (!version?.webSocketDebuggerUrl) throw new Error("Missing CDP WebSocket URL");
    return version;
  } catch (error) {
    if (process.env.CHROME_CDP_URL) {
      throw new Error(`Chrome CDP is unavailable at ${CDP_URL}`, { cause: error });
    }
    return null;
  }
}
