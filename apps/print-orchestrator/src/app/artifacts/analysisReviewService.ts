import { JobError, NotFoundError, ValidationError } from "../../core/errors";
import {
  makeAnalysisReview,
  readAnalysisReview,
  reviewCodesOf,
  ANALYSIS_REVIEW_KEY,
  type AnalysisReviewAcknowledgement
} from "../../domain/print/analysisReview";
import type { Artifact } from "../../domain/print/types";
import type { ArtifactContext } from "./context";

/**
 * The operator reading a `review` verdict and saying so.
 *
 * The sibling of {@link file://./modelScale.ts ModelScaleService}, and for the
 * same structural reason: the analyzer can be honest about something it cannot
 * verify, and honesty without a way to answer is a dead end. An uploaded
 * `.gcode.3mf` is the case that forces it — the file is startable, and every
 * parameter inside it came from a machine profile this farm never approved, so
 * the verdict is `review` unconditionally and the dispatch gate refuses anything
 * that is not `schedulable`. Correct, and previously terminal.
 *
 * The acknowledgement clears exactly one refusal (`ANALYSIS_VERDICT`, and only
 * in attended mode). It cannot clear an analysis blocker, cannot make a `blocked`
 * verdict startable, and cannot authorise an unattended start — a night dispatch
 * has nobody present to have accepted anything.
 */
export class AnalysisReviewService {
  constructor(private readonly ctx: ArtifactContext) {}

  /**
   * Records that a named operator has read this analysis's findings and accepts
   * them. Bound to the artifact's content hash *and* the analysis id, so a
   * re-upload or a re-analysis lapses it rather than silently carrying over.
   */
  confirm(
    artifactId: string,
    input: { actor?: string; note?: string | null } = {}
  ): { artifact: Artifact; acknowledgement: AnalysisReviewAcknowledgement } {
    return this.ctx.store.transaction(() => {
      const repos = this.ctx.store.repositories;
      const artifact = this.requireArtifact(artifactId);
      const analysis = repos.artifactAnalyses.latestForArtifact(artifactId);
      if (!analysis) {
        throw new JobError(`У файла «${artifact.name}» ещё нет анализа — подтверждать нечего`);
      }

      const acknowledgement = makeAnalysisReview({
        artifact,
        analysis,
        confirmedBy: input.actor?.trim() || this.ctx.defaultActor,
        confirmedAt: this.ctx.nowIso(),
        note: input.note ?? null
      });
      if (!acknowledgement) {
        // Each refusal names the state it is refusing, because "нельзя
        // подтвердить" alone leaves an operator guessing between four causes.
        throw new ValidationError(
          analysis.state !== "ready"
            ? `Анализ ещё не завершён (${analysis.state}) — дождитесь результата`
            : analysis.blockers.length > 0
              ? "Анализ выявил критические проблемы — их нельзя принять подтверждением, файл нужно исправить"
              : analysis.verdict === "schedulable"
                ? "Файл и так допущен к запуску — подтверждать нечего"
                : `Вердикт «${analysis.verdict ?? "—"}» нельзя принять подтверждением оператора`
        );
      }

      const saved = repos.artifacts.update({
        ...artifact,
        metadata: { ...artifact.metadata, [ANALYSIS_REVIEW_KEY]: { ...acknowledgement } },
        updatedAt: this.ctx.nowIso()
      });
      this.ctx.recordAudit({
        entityType: "artifact",
        entityId: artifactId,
        action: "analysis_review_confirmed",
        actor: acknowledgement.confirmedBy,
        detail: {
          analysisId: acknowledgement.analysisId,
          verdict: acknowledgement.verdict,
          codes: acknowledgement.codes,
          sha256: acknowledgement.sha256,
          note: acknowledgement.note
        }
      });
      return { artifact: saved, acknowledgement };
    });
  }

  /** Withdraws the acknowledgement — the verdict reverts to unconfirmed. */
  clear(artifactId: string, actor?: string): { artifact: Artifact } {
    return this.ctx.store.transaction(() => {
      const repos = this.ctx.store.repositories;
      const artifact = this.requireArtifact(artifactId);
      const analysis = repos.artifactAnalyses.latestForArtifact(artifactId);
      const previous = readAnalysisReview(artifact, analysis);
      const metadata = { ...artifact.metadata };
      delete metadata[ANALYSIS_REVIEW_KEY];

      const saved = repos.artifacts.update({
        ...artifact,
        metadata,
        updatedAt: this.ctx.nowIso()
      });
      this.ctx.recordAudit({
        entityType: "artifact",
        entityId: artifactId,
        action: "analysis_review_cleared",
        actor: actor ?? this.ctx.defaultActor,
        detail: { previousBy: previous?.acknowledgement.confirmedBy ?? null }
      });
      return { artifact: saved };
    });
  }

  /**
   * What the dashboard needs to render the review state of one artifact: the
   * findings that would have to be accepted, and the acknowledgement standing
   * against them (with its staleness, so a lapsed one is shown as lapsed rather
   * than as nothing at all).
   */
  describe(artifactId: string): {
    required: boolean;
    codes: string[];
    acknowledgement: AnalysisReviewAcknowledgement | null;
    stale: boolean;
    staleReason: string | null;
  } {
    const repos = this.ctx.store.repositories;
    const artifact = this.requireArtifact(artifactId);
    const analysis = repos.artifactAnalyses.latestForArtifact(artifactId);
    const resolved = readAnalysisReview(artifact, analysis);
    return {
      required:
        analysis !== null &&
        analysis.state === "ready" &&
        analysis.verdict !== null &&
        analysis.verdict !== "schedulable" &&
        analysis.blockers.length === 0,
      codes: analysis ? reviewCodesOf(analysis) : [],
      acknowledgement: resolved?.acknowledgement ?? null,
      stale: resolved?.stale ?? false,
      staleReason: resolved?.staleReason ?? null
    };
  }

  private requireArtifact(artifactId: string): Artifact {
    const artifact = this.ctx.store.repositories.artifacts.getById(artifactId);
    if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);
    return artifact;
  }
}
