import type { AnalysisFinding, Artifact, ArtifactAnalysis } from "./types";

/**
 * The operator's answer to an analysis that came back `review`.
 *
 * Some files are usable but not *provable*. The clearest case is an uploaded
 * `.gcode.3mf`: it is a finished, startable plate package, and every speed,
 * temperature and bed shape inside it was decided by somebody else's machine
 * profile. The analyzer says so honestly — verdict `review`, with the reason —
 * and the dispatch gate refuses anything that is not `schedulable`. Correct, and
 * a dead end: the file was accepted, shown as green in the upload list, and had
 * no next action at all.
 *
 * This record is the way out, and it is the same shape as the model-scale
 * confirmation next door ({@link file://./modelScale.ts}) on purpose:
 *
 *   - **it is bound to the bytes and to the analysis.** Both the artifact's
 *     `sha256` and the `analysisId` are captured, so re-uploading different
 *     content or re-running the analyzer lapses it — the verdict silently
 *     reverts to unconfirmed rather than carrying over to a file nobody read.
 *   - **it names what was accepted.** The finding codes present at confirmation
 *     time are stored, so a *new* reason appearing in a later analysis is not
 *     covered by an acknowledgement made before it existed.
 *   - **it is attributable.** Who, when, and their note.
 *
 * What it deliberately does **not** do: clear a `blocked` verdict, clear analysis
 * blockers, or authorise an unattended start. It answers exactly one question —
 * "a human has read this review and accepts it" — and every other gate still runs.
 */

/** The `artifact.metadata` key the acknowledgement lives under. */
export const ANALYSIS_REVIEW_KEY = "analysisReview";

export interface AnalysisReviewAcknowledgement {
  /** The analysis that was read. */
  analysisId: string;
  /** The verdict at the time it was read (always `review` or `needs_input`). */
  verdict: string;
  /** Finding codes visible when it was accepted; a new code is not covered. */
  codes: string[];
  /** Artifact content hash when this was confirmed; null for a hash-less row. */
  sha256: string | null;
  confirmedBy: string;
  confirmedAt: string;
  note: string | null;
}

/** An acknowledgement read back, with its validity against the current state. */
export interface ResolvedAnalysisReview {
  acknowledgement: AnalysisReviewAcknowledgement;
  /** False when it still describes the current bytes, analysis and findings. */
  stale: boolean;
  /** Why it lapsed, for the operator; null when it is current. */
  staleReason: string | null;
}

/** Verdicts a human is allowed to accept. `blocked` is never one of them. */
export const ACKNOWLEDGEABLE_VERDICTS: ReadonlySet<string> = new Set(["review", "needs_input"]);

/** The finding codes an acknowledgement of `analysis` would have to cover. */
export function reviewCodesOf(analysis: ArtifactAnalysis): string[] {
  const codes = new Set<string>();
  for (const finding of [...analysis.warnings, ...analysis.blockers] as AnalysisFinding[]) {
    codes.add(finding.code);
  }
  return [...codes].sort();
}

/**
 * Validates operator input into a storable acknowledgement, or null when the
 * analysis is not in a state a human may accept (still running, failed, already
 * `schedulable`, or hard-`blocked`).
 */
export function makeAnalysisReview(input: {
  artifact: Pick<Artifact, "sha256">;
  analysis: ArtifactAnalysis;
  confirmedBy: string;
  confirmedAt: string;
  note?: string | null;
}): AnalysisReviewAcknowledgement | null {
  const { analysis } = input;
  if (analysis.state !== "ready") return null;
  if (analysis.verdict === null || !ACKNOWLEDGEABLE_VERDICTS.has(analysis.verdict)) return null;
  // An analysis carrying hard blockers is not a judgement call — no tick makes a
  // corrupt file printable, and `evaluateSliceOutput`/the dispatch gate refuse it
  // independently anyway.
  if (analysis.blockers.length > 0) return null;

  const note = typeof input.note === "string" ? input.note.trim() : "";
  return {
    analysisId: analysis.id,
    verdict: analysis.verdict,
    codes: reviewCodesOf(analysis),
    sha256: input.artifact.sha256,
    confirmedBy: input.confirmedBy,
    confirmedAt: input.confirmedAt,
    note: note || null
  };
}

/**
 * The acknowledgement stored on an artifact, resolved against the analysis and
 * bytes as they stand *now*. A lapsed one is returned with `stale: true` and a
 * reason, so the UI can say "подтверждение устарело: файл переанализирован"
 * rather than silently showing nothing.
 */
export function readAnalysisReview(
  artifact: Artifact,
  analysis: ArtifactAnalysis | null
): ResolvedAnalysisReview | null {
  const raw = artifact.metadata?.[ANALYSIS_REVIEW_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const analysisId = typeof rec.analysisId === "string" ? rec.analysisId : "";
  if (!analysisId) return null;

  const acknowledgement: AnalysisReviewAcknowledgement = {
    analysisId,
    verdict: typeof rec.verdict === "string" ? rec.verdict : "review",
    codes: Array.isArray(rec.codes) ? rec.codes.filter((c): c is string => typeof c === "string") : [],
    sha256: typeof rec.sha256 === "string" ? rec.sha256 : null,
    confirmedBy: typeof rec.confirmedBy === "string" ? rec.confirmedBy : "operator",
    confirmedAt: typeof rec.confirmedAt === "string" ? rec.confirmedAt : "",
    note: typeof rec.note === "string" ? rec.note : null
  };

  const staleReason = lapseReason(acknowledgement, artifact, analysis);
  return { acknowledgement, stale: staleReason !== null, staleReason };
}

/** Whether `analysis` is currently covered by a live acknowledgement on `artifact`. */
export function analysisReviewAccepted(
  artifact: Artifact | null,
  analysis: ArtifactAnalysis | null
): boolean {
  if (!artifact || !analysis) return false;
  const resolved = readAnalysisReview(artifact, analysis);
  return resolved !== null && !resolved.stale;
}

function lapseReason(
  ack: AnalysisReviewAcknowledgement,
  artifact: Artifact,
  analysis: ArtifactAnalysis | null
): string | null {
  if (ack.sha256 !== null && artifact.sha256 !== null && ack.sha256 !== artifact.sha256) {
    return "содержимое файла изменилось после подтверждения";
  }
  if (!analysis) return "анализ, который подтверждали, больше не существует";
  if (analysis.id !== ack.analysisId) return "файл проанализирован заново — подтвердите ещё раз";
  if (analysis.state !== "ready") return "анализ не завершён";
  if (analysis.blockers.length > 0) return "анализ выявил критические проблемы";
  // A reason nobody read cannot have been accepted.
  const covered = new Set(ack.codes);
  const uncovered = reviewCodesOf(analysis).filter((code) => !covered.has(code));
  if (uncovered.length > 0) {
    return `появились новые замечания: ${uncovered.join(", ")}`;
  }
  return null;
}
