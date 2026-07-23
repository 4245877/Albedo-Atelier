import { NotFoundError } from "../../core/errors";
import type { Artifact, ArtifactAnalysis, AuditEvent, PrintTask } from "../../domain/print/types";
import type { ArtifactContext } from "./context";

export interface ArtifactSummary {
  artifact: Artifact;
  task: PrintTask | null;
  analysis: ArtifactAnalysis | null;
}

export interface ArtifactDetail {
  artifact: Artifact;
  task: PrintTask | null;
  analyses: ArtifactAnalysis[];
  audit: AuditEvent[];
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
        analysis: repos.artifactAnalyses.latestForArtifact(artifact.id)
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
      audit
    };
  }
}
