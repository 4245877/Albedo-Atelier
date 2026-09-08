import { NotFoundError, ValidationError } from "../../core/errors";
import {
  makePlateSelectionConfirmation,
  readPlateCount,
  readPlateSelection,
  readPlates,
  PLATE_SELECTION_KEY,
  type PlateSelectionConfirmation,
  type PlateView
} from "../../domain/print/plateSelection";
import type { Artifact, ArtifactAnalysis } from "../../domain/print/types";
import type { ArtifactContext } from "./context";

/**
 * The operator's choice of which build plate of a multi-plate 3MF to work on —
 * the one supported way such a project stops being several prints in a trench
 * coat and becomes one printable job.
 *
 * Modelled on {@link file://./modelScale.ts ModelScaleService} down to the
 * transaction shape, because it answers the same *kind* of question: a fact only
 * a human can supply, recorded against specific bytes, audited, and lapsing by
 * itself when those bytes (or the analysis of them) change. Until it exists the
 * package has no printable size, `select_plate` is the file's next action, and a
 * slice is refused with that reason rather than silently picking a plate.
 */
export class PlateSelectionService {
  constructor(private readonly ctx: ArtifactContext) {}

  /** Records which plate this artifact is to be printed from. */
  select(
    artifactId: string,
    input: { plateIndex: unknown; actor?: string }
  ): { artifact: Artifact; selection: PlateSelectionConfirmation; plate: PlateView } {
    return this.ctx.store.transaction(() => {
      const { artifact, analysis } = this.require(artifactId);
      if (!analysis || analysis.state !== "ready") {
        throw new ValidationError(
          "Пластину можно выбрать только после успешного анализа файла — дождитесь его окончания"
        );
      }
      const plates = readPlates(analysis);
      if (plates.length === 0) {
        throw new ValidationError(
          "В этом файле нет пластин, среди которых можно выбирать — это не проект слайсера с несколькими столами"
        );
      }

      const made = makePlateSelectionConfirmation({
        plateIndex: input.plateIndex,
        plates,
        plateCount: readPlateCount(analysis),
        artifact,
        confirmedBy: input.actor ?? this.ctx.defaultActor,
        confirmedAt: this.ctx.nowIso()
      });
      if ("error" in made) throw new ValidationError(made.error);

      const saved = this.ctx.store.repositories.artifacts.update({
        ...artifact,
        metadata: { ...artifact.metadata, [PLATE_SELECTION_KEY]: { ...made.confirmation } },
        updatedAt: this.ctx.nowIso()
      });
      this.ctx.recordAudit({
        entityType: "artifact",
        entityId: artifactId,
        action: "plate_selected",
        actor: made.confirmation.confirmedBy,
        detail: {
          plateIndex: made.confirmation.plateIndex,
          plateCount: made.confirmation.plateCount,
          plateName: made.plate.name,
          sha256: made.confirmation.sha256
        }
      });
      return { artifact: saved, selection: made.confirmation, plate: made.plate };
    });
  }

  /** Withdraws the choice — the package goes back to "no plate chosen" (fail-closed). */
  clear(artifactId: string, actor?: string): { artifact: Artifact } {
    return this.ctx.store.transaction(() => {
      const { artifact, analysis } = this.require(artifactId);
      const previous = readPlateSelection(artifact, analysis);
      const metadata = { ...artifact.metadata };
      delete metadata[PLATE_SELECTION_KEY];

      const saved = this.ctx.store.repositories.artifacts.update({
        ...artifact,
        metadata,
        updatedAt: this.ctx.nowIso()
      });
      this.ctx.recordAudit({
        entityType: "artifact",
        entityId: artifactId,
        action: "plate_selection_cleared",
        actor: actor ?? this.ctx.defaultActor,
        detail: { previousPlateIndex: previous?.confirmation.plateIndex ?? null }
      });
      return { artifact: saved };
    });
  }

  private require(artifactId: string): { artifact: Artifact; analysis: ArtifactAnalysis | null } {
    const repos = this.ctx.store.repositories;
    const artifact = repos.artifacts.getById(artifactId);
    if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);
    return { artifact, analysis: repos.artifactAnalyses.latestForArtifact(artifactId) };
  }
}
