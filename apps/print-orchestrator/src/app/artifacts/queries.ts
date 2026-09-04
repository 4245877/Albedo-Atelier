import { NotFoundError } from "../../core/errors";
import type { Artifact, ArtifactAnalysis, AuditEvent, PrintTask } from "../../domain/print/types";
import type { ArtifactContext } from "./context";
import { deletionBlocker } from "./retention";

export interface ArtifactSummary {
  artifact: Artifact;
  task: PrintTask | null;
  analysis: ArtifactAnalysis | null;
  /**
   * Why this file cannot be deleted right now, or null when it can. Computed by
   * the very rule the delete transaction enforces, so the dashboard can disable
   * the button and name the reason instead of offering an action that is going
   * to be refused. Advisory only — a file can become live between this read and
   * the delete, and the transaction re-checks.
   */
  deletionBlocker: string | null;
}

export interface ArtifactDetail {
  artifact: Artifact;
  task: PrintTask | null;
  analyses: ArtifactAnalysis[];
  audit: AuditEvent[];
  /** @see {@link ArtifactSummary.deletionBlocker} */
  deletionBlocker: string | null;
}

/** Read side of the artifact store: listings and the per-artifact detail. */
export class ArtifactQueries {
  constructor(private readonly ctx: ArtifactContext) {}

  listArtifacts(): ArtifactSummary[] {
    const repos = this.ctx.store.repositories;
    return repos.artifacts
      .list()
      .map((artifact) => ({
        artifact,
        task: repos.tasks.findByArtifactId(artifact.id),
        analysis: repos.artifactAnalyses.latestForArtifact(artifact.id),
        deletionBlocker: deletionBlocker(repos, artifact.id)
      }))
      .reverse(); // newest upload first
  }

  getArtifactDetail(id: string): ArtifactDetail {
    const repos = this.ctx.store.repositories;
    const artifact = repos.artifacts.getById(id);
    if (!artifact) throw new NotFoundError(`Артефакт «${id}»`);
    const task = repos.tasks.findByArtifactId(id);
    const audit = [
      ...repos.audit.listByEntity("artifact", id),
      ...(task ? repos.audit.listByEntity("print_task", task.id) : [])
    ].sort((a, b) => (a.at < b.at ? 1 : -1));
    return {
      artifact,
      task,
      analyses: repos.artifactAnalyses.listByArtifact(id),
      audit,
      deletionBlocker: deletionBlocker(repos, id)
    };
  }
}
