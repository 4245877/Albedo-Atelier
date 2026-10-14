import { ID_PREFIX, newId } from "./ids";
import type { Artifact, Metadata, PrintTask, PrintTaskState } from "./types";

/**
 * Task states that can still take a finished slice — the states promotion
 * accepts, and therefore the only ones a new slice of a source may join. A task
 * of the source in any other state (assigned, printing, closed) is not where a
 * new slice belongs: attaching one there would produce a variant nothing can
 * promote.
 */
export const PREPARABLE_TASK_STATES: readonly PrintTaskState[] = ["DRAFT", "QUEUED", "PLANNED", "NEEDS_REVIEW"];

/**
 * A new `DRAFT` task for a source model — the one shape a print instance starts
 * in, whether it came from an upload or from preparing an already-used model
 * again.
 *
 * One source supports any number of independent preparations and prints. The
 * upload's own draft is the first; once it has been promoted onto a slice (its
 * executable becomes the G-code) or closed, preparing the same model again opens
 * a new draft here instead of reaching back into a task whose history is
 * somebody's finished print.
 */
export function newDraftTask(input: {
  artifact: Pick<Artifact, "id" | "name">;
  iso: string;
  metadata?: Metadata;
  title?: string;
}): PrintTask {
  return {
    id: newId(ID_PREFIX.printTask),
    artifactId: input.artifact.id,
    // The source IS the executable here; nothing has been sliced yet.
    sliceVariantId: null,
    sourceArtifactId: input.artifact.id,
    onDeviceFile: null,
    title: input.title ?? input.artifact.name,
    material: null,
    targetPrinter: null,
    priority: 0,
    // A draft is deliberately NOT enqueued (no QueueEntry): it is still being prepared.
    state: "DRAFT",
    reason: null,
    // "When" has one source of truth — the preference — and `night` is its
    // projection. A new draft states neither.
    dayNightPreference: "any",
    night: false,
    notBefore: null,
    deadline: null,
    pinnedPrinterId: null,
    unattendedAllowed: false,
    createdAt: input.iso,
    updatedAt: input.iso,
    version: 1,
    legacyRef: null,
    metadata: input.metadata ?? {}
  };
}
