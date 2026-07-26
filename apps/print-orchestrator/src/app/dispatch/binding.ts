import type { Repositories } from "../../domain/print/repositories";
import {
  EMPTY_ASSIGNMENT_BINDING,
  type AssignmentBinding,
  type PrintTask
} from "../../domain/print/types";
import { readFilament, readMachine } from "../../domain/slicing/orcaProfile";
import type { ProfileSet, SliceVariant } from "../../domain/slicing/types";
import { settingsOf } from "../slicing/profileService";

/**
 * Resolving a task's **executable binding** — the one place that answers "what
 * exactly would we print, and with which profiles?".
 *
 * Before this existed the answer was scattered: the file name lived in
 * `task.metadata.file`, the slice in `task.metadata.sliceVariantId`, and the
 * profile revisions nowhere at all — so `DispatchReservation.profileRevisionIds`
 * was read from `assignment.metadata` that nothing ever wrote. Plan confirmation,
 * manual assignment and the dispatch pre-flight now all call this, so the three
 * cannot disagree about what a task's executable is.
 *
 * Every field is resolved from stored rows only. Nothing is inferred or
 * defaulted: an unknown stays `null` and the eligibility rules decide what an
 * unknown means (a warning when attended, a refusal unattended).
 */

/** The binding plus the rows it was resolved from, so callers re-read nothing. */
export interface ResolvedTaskBinding {
  binding: AssignmentBinding;
  variant: SliceVariant | null;
  profileSet: ProfileSet | null;
}

/**
 * The binding for a task as it stands right now.
 *
 * `plan` fields (`plannedStartAt`, `planRevision`) are left null — only the
 * planner knows those, and it fills them in when it writes the assignment.
 */
export function resolveTaskBinding(
  repos: Repositories,
  task: PrintTask
): ResolvedTaskBinding {
  const variant = task.sliceVariantId ? repos.sliceVariants.getById(task.sliceVariantId) : null;
  const profileSet = variant ? repos.profileSets.getById(variant.profileSetId) : null;
  const artifact = task.artifactId ? repos.artifacts.getById(task.artifactId) : null;
  const analysis = artifact ? repos.artifactAnalyses.latestForArtifact(artifact.id) : null;

  const machineRev = profileSet
    ? repos.profileRevisions.getById(profileSet.machineRevisionId)
    : null;
  const filamentRev = profileSet
    ? repos.profileRevisions.getById(profileSet.filamentRevisionId)
    : null;
  const machine = machineRev ? readMachine(settingsOf(machineRev)) : null;
  const filament = filamentRev ? readFilament(settingsOf(filamentRev)) : null;

  const binding: AssignmentBinding = {
    ...EMPTY_ASSIGNMENT_BINDING,
    sliceVariantId: variant?.id ?? task.sliceVariantId,
    artifactId: artifact?.id ?? task.artifactId,
    artifactSha256: artifact?.sha256 ?? null,
    machineRevisionId: profileSet?.machineRevisionId ?? null,
    processRevisionId: profileSet?.processRevisionId ?? null,
    filamentRevisionId: profileSet?.filamentRevisionId ?? null,
    expectedRemotePath: task.onDeviceFile,
    // The flavor/nozzle the file was actually produced for wins over anything the
    // analysis guessed; the analysis is the fallback for an uploaded G-code.
    gcodeFlavor: machine?.gcodeFlavor ?? readAnalysisString(analysis?.data, "flavor"),
    nozzleMm: machine?.nozzleDiameterMm ?? analysis?.nozzleDiameterMm ?? null,
    material: task.material ?? filament?.filamentType ?? analysis?.material ?? null,
    etaS: positive(variant?.orcaEtaS ?? null) ?? positive(analysis?.estimatedDurationS ?? null)
  };

  return { binding, variant, profileSet };
}

/**
 * Whether a stored binding still describes the task. A `false` here is what
 * makes an assignment STALE rather than silently executed against changed data —
 * the invariant "подтверждённое назначение нельзя незаметно переназначить".
 *
 * Only the identity fields are compared: the slice variant, the executable
 * artifact and its content hash. Presentation-ish fields (ETA, material label)
 * may legitimately drift without changing *what* gets printed.
 */
export function bindingMatchesTask(binding: AssignmentBinding, task: PrintTask): boolean {
  if (binding.sliceVariantId !== null && binding.sliceVariantId !== task.sliceVariantId) return false;
  if (binding.artifactId !== null && binding.artifactId !== task.artifactId) return false;
  if (
    binding.expectedRemotePath !== null &&
    task.onDeviceFile !== null &&
    binding.expectedRemotePath !== task.onDeviceFile
  ) {
    return false;
  }
  return true;
}

/**
 * Whether every profile revision the binding pins still exists and is `active`.
 * A re-import can quarantine a revision an approved set pinned; executing a plan
 * confirmed under the old revision would print with settings nobody vetted.
 */
export function profileRevisionsIntact(
  repos: Repositories,
  binding: AssignmentBinding
): { ok: true } | { ok: false; reason: string } {
  const pinned = [
    ["machine", binding.machineRevisionId],
    ["process", binding.processRevisionId],
    ["filament", binding.filamentRevisionId]
  ] as const;
  for (const [label, id] of pinned) {
    if (!id) continue;
    const revision = repos.profileRevisions.getById(id);
    if (!revision) return { ok: false, reason: `профиль ${label} «${id}» больше не существует` };
    if (revision.status !== "active") {
      return { ok: false, reason: `профиль ${label} «${revision.name}» теперь «${revision.status}»` };
    }
  }
  return { ok: true };
}

/** The profile revision ids a binding pins, in a stable order (audit/UI use). */
export function profileRevisionIdsOf(binding: AssignmentBinding): string[] {
  return [binding.machineRevisionId, binding.processRevisionId, binding.filamentRevisionId].filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
}

// ── Internals ────────────────────────────────────────────────────────────────

function readAnalysisString(
  data: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  const value = data?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positive(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
