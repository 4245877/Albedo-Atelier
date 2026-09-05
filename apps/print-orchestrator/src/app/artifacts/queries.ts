import { NotFoundError } from "../../core/errors";
import type { Artifact, ArtifactAnalysis, AuditEvent, PrintTask } from "../../domain/print/types";
import type { ArtifactContext } from "./context";
import { resolveArtifactStatus, type ArtifactStatusView } from "./nextAction";
import { deletionHold, type HeldTask } from "./retention";

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
  /**
   * The scheduler tasks a cascading delete (`?cascade=true`) would cancel to
   * free this file, or null when there is nothing to cascade — either the file
   * is free, or it is held by something a cascade may not override (a running
   * print, bytes on the wire, a slicer mid-job). Non-null is what lets the
   * dashboard offer «удалить вместе с заданием» and NAME what disappears,
   * instead of showing a dead-ended button whose tooltip says the file is busy
   * and leaving the operator to find the task themselves.
   */
  deletionCascade: HeldTask[] | null;
  /**
   * The single obvious next step for this file, decided by the server — see
   * {@link resolveArtifactStatus}. The acceptance rule for the whole intake is
   * that this is never «nothing»: either an action, or a sentence saying why
   * printing is impossible.
   */
  status: ArtifactStatusView;
}

export interface ArtifactDetail {
  artifact: Artifact;
  task: PrintTask | null;
  analyses: ArtifactAnalysis[];
  audit: AuditEvent[];
  /** @see {@link ArtifactSummary.deletionBlocker} */
  deletionBlocker: string | null;
  /** @see {@link ArtifactSummary.deletionCascade} */
  deletionCascade: HeldTask[] | null;
  /** @see {@link ArtifactSummary.status} */
  status: ArtifactStatusView;
}

/** Read side of the artifact store: listings and the per-artifact detail. */
export class ArtifactQueries {
  constructor(private readonly ctx: ArtifactContext) {}

  listArtifacts(): ArtifactSummary[] {
    const repos = this.ctx.store.repositories;
    return repos.artifacts
      .list()
      .map((artifact) => {
        const task = repos.tasks.findByArtifactId(artifact.id);
        const analysis = repos.artifactAnalyses.latestForArtifact(artifact.id);
        const hold = deletionHold(repos, artifact.id);
        return {
          artifact,
          task,
          analysis,
          deletionBlocker: hold.reason,
          deletionCascade: hold.cascadable ? hold.tasks : null,
          status: resolveArtifactStatus(artifact, analysis, task)
        };
      })
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
    const analyses = repos.artifactAnalyses.listByArtifact(id);
    const hold = deletionHold(repos, id);
    return {
      artifact,
      task,
      analyses,
      audit,
      deletionBlocker: hold.reason,
      deletionCascade: hold.cascadable ? hold.tasks : null,
      status: resolveArtifactStatus(
        artifact,
        repos.artifactAnalyses.latestForArtifact(id),
        task
      )
    };
  }
}
