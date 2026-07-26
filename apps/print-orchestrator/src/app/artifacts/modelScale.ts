import { NotFoundError, ValidationError } from "../../core/errors";
import {
  makeModelScaleConfirmation,
  readModelScale,
  MODEL_SCALE_KEY,
  type ModelScaleConfirmation
} from "../../domain/print/modelScale";
import type { Artifact } from "../../domain/print/types";
import { KNOWN_UNITS } from "../../domain/shared/units";
import type { ArtifactContext } from "./context";

/**
 * The operator's scale confirmation for a model artifact — the one supported way
 * an STL's (or an unreadable-unit 3MF's) bounding box becomes a *trusted*
 * millimetre measurement.
 *
 * Until it exists the scheduler reports `model_scale_unknown`, the compatibility
 * verdict can never be `compatible`, and an unattended start is refused. This is
 * deliberately a human decision recorded against specific bytes: the system has
 * no way to infer a unit the file never stored, and guessing is exactly the
 * failure mode that prints a 25.4×-wrong part.
 */
export class ModelScaleService {
  constructor(private readonly ctx: ArtifactContext) {}

  /**
   * Records that this artifact's coordinates are in `units` (optionally times an
   * extra `scaleFactor`). Bound to the artifact's current content hash, so it
   * lapses by itself if the file is replaced.
   */
  confirm(
    artifactId: string,
    input: { units: unknown; scaleFactor?: unknown; actor?: string }
  ): { artifact: Artifact; confirmation: ModelScaleConfirmation } {
    return this.ctx.store.transaction(() => {
      const artifact = this.requireArtifact(artifactId);
      const confirmation = makeModelScaleConfirmation({
        units: input.units,
        scaleFactor: input.scaleFactor,
        artifact,
        confirmedBy: input.actor ?? this.ctx.defaultActor,
        confirmedAt: this.ctx.nowIso()
      });
      if (!confirmation) {
        throw new ValidationError(
          `Единицы должны быть одним из: ${KNOWN_UNITS.join(", ")}; масштаб — положительное число`
        );
      }
      if (artifact.kind === "gcode") {
        // G-code is machine coordinates: already millimetres by definition, and
        // re-scaling it would silently contradict the file itself.
        throw new ValidationError("G-code уже в миллиметрах — подтверждение масштаба к нему неприменимо");
      }

      const saved = this.ctx.store.repositories.artifacts.update({
        ...artifact,
        metadata: { ...artifact.metadata, [MODEL_SCALE_KEY]: { ...confirmation } },
        updatedAt: this.ctx.nowIso()
      });
      this.ctx.recordAudit({
        entityType: "artifact",
        entityId: artifactId,
        action: "model_scale_confirmed",
        actor: confirmation.confirmedBy,
        detail: {
          units: confirmation.units,
          scaleFactor: confirmation.scaleFactor,
          sha256: confirmation.sha256
        }
      });
      return { artifact: saved, confirmation };
    });
  }

  /** Withdraws a confirmation — the size goes back to unproven (fail-closed). */
  clear(artifactId: string, actor?: string): { artifact: Artifact } {
    return this.ctx.store.transaction(() => {
      const artifact = this.requireArtifact(artifactId);
      const previous = readModelScale(artifact);
      const metadata = { ...artifact.metadata };
      delete metadata[MODEL_SCALE_KEY];

      const saved = this.ctx.store.repositories.artifacts.update({
        ...artifact,
        metadata,
        updatedAt: this.ctx.nowIso()
      });
      this.ctx.recordAudit({
        entityType: "artifact",
        entityId: artifactId,
        action: "model_scale_cleared",
        actor: actor ?? this.ctx.defaultActor,
        detail: { previousUnits: previous?.confirmation.units ?? null }
      });
      return { artifact: saved };
    });
  }

  private requireArtifact(artifactId: string): Artifact {
    const artifact = this.ctx.store.repositories.artifacts.getById(artifactId);
    if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);
    return artifact;
  }
}
