/**
 * `fetch` with a hard deadline, for the short-lived JSON/snapshot requests the
 * orchestrator makes (Moonraker, go2rtc, fulfillment, camera frames). Replaces
 * the repeated `AbortController` + `setTimeout` + `clearTimeout` boilerplate
 * with `AbortSignal.timeout()` (Node ≥ 17.3; this project runs Node ≥ 22).
 *
 * A caller MAY still pass its own `RequestInit.signal` (e.g. a shutdown/cancel
 * controller): it is combined with the deadline via `AbortSignal.any` (Node ≥
 * 20.3) rather than being silently dropped, so BOTH can abort the request.
 * Whichever fires first supplies the rejection reason — the deadline rejects
 * with a `TimeoutError` DOMException, a manual abort with an `AbortError` — so
 * callers can tell the two apart (see {@link isTimeoutError} /
 * {@link isAbortError}). The original cause is surfaced, never swallowed or
 * rewrapped.
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
  const { timeoutMs, signal, ...rest } = init;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // With no caller signal, pass the deadline alone (no needless wrapper). With
  // one, merge them so an external cancel and the deadline both stay effective.
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...rest, signal: combined });
}

/**
 * Whether an error is the DEADLINE firing — the `TimeoutError` DOMException
 * `AbortSignal.timeout()` reports. Deliberately narrow: a manual `AbortError`
 * (an external signal aborted by hand) is a different cause and is NOT reported
 * as a timeout — use {@link isAbortError} for that. Callers that must fail
 * closed on "the response was lost" should treat both as inconclusive.
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Whether an error is a manual cancellation — the `AbortError` DOMException a
 * caller-supplied {@link AbortSignal} raises when aborted by hand (shutdown,
 * an operator cancel). Distinct from the deadline (see {@link isTimeoutError}).
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
