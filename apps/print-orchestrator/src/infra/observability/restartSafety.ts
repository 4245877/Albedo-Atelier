import type { RestartSafetyAssessment } from "../../app/restartSafety";

/** The farm surface this read needs — nothing wider, and no singleton. */
export interface RestartSafetySource {
  assessRestartSafety(options: { restartWindowSeconds?: number }): RestartSafetyAssessment;
}

/**
 * `GET /restart-safety` — may this process be recreated right now without
 * losing print accounting?
 *
 * Sits beside {@link file://./ready.ts getReadiness} for the same reason: the
 * route stays a one-liner and the parsing has somewhere to be tested. The only
 * input is `?window=<seconds>`, the outage the caller expects to cause; a
 * missing, malformed or negative value falls back to the module default rather
 * than failing the request, because a deploy asking this question must never be
 * answered with a 400 it would have to interpret.
 */
export function getRestartSafety(
  farm: RestartSafetySource,
  query: unknown
): RestartSafetyAssessment {
  const raw =
    query && typeof query === "object" ? (query as { window?: unknown }).window : undefined;
  // `Number("")` is 0, and a 0-second window is not "unspecified" — it disables
  // the finishing-soon check, making the gate MORE permissive. An empty
  // `?window=` must therefore mean "not given", not "zero".
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
  const restartWindowSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  return farm.assessRestartSafety({ restartWindowSeconds });
}
