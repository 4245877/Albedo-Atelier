/**
 * `fetch` with a hard deadline, for the short-lived JSON/snapshot requests the
 * orchestrator makes (Moonraker, go2rtc, fulfillment, camera frames). Replaces
 * the repeated `AbortController` + `setTimeout` + `clearTimeout` boilerplate
 * with `AbortSignal.timeout()` (Node ≥ 17.3; this project runs Node 22).
 *
 * On expiry the promise rejects with the signal's own `TimeoutError`
 * DOMException — the original cause is surfaced, never swallowed or rewrapped,
 * so callers keep mapping/reporting errors exactly as before (see
 * {@link isTimeoutError} for the name check).
 *
 * The deadline covers the whole exchange, including reading the body. That is
 * what every short request here wants. Deliberately NOT for long-lived live
 * streams (camera MJPEG/MP4): a stream may only bound connection setup and must
 * never be killed by a timer once frames flow — see `camera/stream.ts`, which
 * keeps its manual connect-only timer.
 */
export function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit & { timeoutMs: number }
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  return fetch(input, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Whether an error is the deadline firing. `TimeoutError` is what
 * `AbortSignal.timeout()` reports; `AbortError` is kept for any signal aborted
 * by hand, so callers distinguishing "timed out" from "refused/reset" keep
 * doing so faithfully.
 */
export function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}
