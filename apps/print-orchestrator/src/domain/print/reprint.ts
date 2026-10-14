import { evaluateSliceOutput } from "../slicing/outputGate";
import type { SliceVariant } from "../slicing/types";
import { evaluateExecutableArtifact } from "./executable";
import type { Artifact, ArtifactAnalysis, PrintTask, PrintTaskState } from "./types";

/**
 * **Printing a finished job again.**
 *
 * A finished print is history: its task is terminal (`COMPLETED`/`FAILED`/
 * `CANCELLED` have no way back except the FAILED retry), its queue entry is
 * released, and its runs, assignment and audit trail say what happened. Printing
 * the same thing again is therefore never a matter of reopening that record — it
 * is a **new** print of the **same verified bytes**, linked to the old one and
 * admitted by exactly the checks a fresh job would face.
 *
 * Two routes, decided by what still exists:
 *
 *  - `variant` — the job came out of our slicer and its ready variant is still
 *    on record. The reprint gets its own copy of that variant (same output
 *    artifact, same pinned scale, same profile set and target) and is promoted
 *    like any slice, so the printer pin, the scale provenance and the profile
 *    checks follow it unchanged.
 *  - `executable` — an uploaded G-code / sliced 3MF, or a slice whose variant
 *    record went with its deleted source model. The bytes are queued as an
 *    uploaded executable would be.
 *
 * Neither route re-slices: «повторное использование проверенного G-code» means
 * the start command names the file whose content hash was analysed and printed
 * before. When that file is gone, the answer is preparing the source model
 * again — which the wizard does with the recorded recipe — never a guess.
 *
 * Pure: the caller resolves every fact (including whether the blob is still in
 * storage), this only classifies.
 */

/** The states a print is finished in — what history lists and a reprint starts from. */
export const FINISHED_TASK_STATES: readonly PrintTaskState[] = ["COMPLETED", "FAILED", "CANCELLED"];

export function isFinishedTask(state: PrintTaskState): boolean {
  return FINISHED_TASK_STATES.includes(state);
}

export type ReprintRoute = "variant" | "executable";

/** Stable keys the dashboard branches on; the text is for the operator. */
export type ReprintRefusalCode =
  /** The print is not finished — there is nothing to repeat yet. */
  | "not_finished"
  /** The variant is not a finished slice (pending, failed, blocked). */
  | "variant_not_ready"
  /** No printable file is recorded (deleted, or never had one). */
  | "file_missing"
  /** The file row survives but its bytes are gone from storage. */
  | "file_deleted"
  /** The task was closed while its file was still a model — never sliced. */
  | "not_sliced"
  /** A legacy name-only file: no content hash, so nothing proves what it is. */
  | "file_unverified"
  /** Analysed by an analyzer version whose verdict no longer counts. */
  | "analysis_outdated"
  /** The current analysis does not admit the file (blockers, not executable, …). */
  | "analysis_refused";

export type ReprintVerdict =
  | { ok: true; route: ReprintRoute; artifactId: string; variantId: string | null }
  | { ok: false; code: ReprintRefusalCode; reason: string };

type Refusal = Extract<ReprintVerdict, { ok: false }>;

/** What is known about the printable file itself. */
export interface ReprintFileFacts {
  /** The executable artifact, or null when the row is gone. */
  executable: Artifact | null;
  /**
   * Whether the executable's bytes are still in storage: false when checked and
   * missing, null when the caller could not check (treated as present — the
   * delivery reads the blob and the dispatch re-verifies the device file before
   * any start, so an unchecked file can never be started blind).
   */
  stored: boolean | null;
  /** The executable's latest analysis. */
  analysis: ArtifactAnalysis | null;
  /** Whether that analysis still speaks for the current analyzer. */
  analysisCurrent: boolean;
}

export interface ReprintFacts extends ReprintFileFacts {
  task: Pick<PrintTask, "state" | "artifactId" | "sliceVariantId">;
  /** The variant the task is bound to, when it still exists. */
  variant: SliceVariant | null;
}

/** May this finished print be printed again from its own verified file — and by which route. */
export function evaluateReprint(f: ReprintFacts): ReprintVerdict {
  if (!isFinishedTask(f.task.state)) {
    return refuse(
      "not_finished",
      `печать ещё не завершена (${f.task.state}) — повтор доступен из истории после завершения`
    );
  }
  if (!f.task.artifactId) {
    return refuse("file_missing", "файл этой печати не сохранился — подготовьте модель заново");
  }
  const problem = fileProblem(f);
  if (problem) return problem;
  const file = f.executable as Artifact;
  const analysis = f.analysis;

  const variant = f.variant;
  if (
    variant &&
    f.task.sliceVariantId === variant.id &&
    variant.state === "ready" &&
    variant.outputArtifactId === file.id
  ) {
    const gate = sliceGate(analysis);
    if (gate) return gate;
    return { ok: true, route: "variant", artifactId: file.id, variantId: variant.id };
  }

  const admission = evaluateExecutableArtifact(file, analysis);
  if (!admission.ok) return refuse("analysis_refused", admission.reason);
  return { ok: true, route: "executable", artifactId: file.id, variantId: null };
}

/**
 * May a NEW print be made from this ready slice variant, whatever became of the
 * task it was sliced for? The slicing screen's «напечатать по этому варианту»
 * for a variant whose own task is closed or was promoted onto another slice.
 */
export function evaluateVariantReprint(f: ReprintFileFacts & { variant: SliceVariant }): ReprintVerdict {
  const variant = f.variant;
  if (variant.state !== "ready" || !variant.outputArtifactId) {
    return refuse(
      "variant_not_ready",
      `вариант нарезки не готов (состояние «${variant.state}») — печатать нечего`
    );
  }
  const problem = fileProblem(f);
  if (problem) return problem;
  const file = f.executable as Artifact;
  if (file.id !== variant.outputArtifactId) {
    return refuse("file_missing", "результат нарезки не найден — нарежьте модель заново");
  }
  const gate = sliceGate(f.analysis);
  if (gate) return gate;
  return { ok: true, route: "variant", artifactId: file.id, variantId: variant.id };
}

/** The file-level refusals both routes share, in the order an operator can act on them. */
function fileProblem(f: ReprintFileFacts): Refusal | null {
  const file = f.executable;
  if (!file) {
    return refuse("file_missing", "файл этой печати не сохранился — подготовьте модель заново");
  }
  if (file.sha256 === null) {
    return refuse(
      "file_unverified",
      "файл известен только по имени на принтере — его содержимое никто не проверял; загрузите файл"
    );
  }
  if (f.stored === false) {
    return refuse("file_deleted", `файл «${file.name}» удалён из хранилища — подготовьте модель заново`);
  }
  const analysis = f.analysis;
  if (analysis && analysis.state === "ready" && analysis.verdict === "needs_preparation") {
    return refuse("not_sliced", "печать закрыта до нарезки — подготовьте модель в «Новой печати»");
  }
  if (analysis && analysis.state === "ready" && !f.analysisCurrent) {
    return refuse(
      "analysis_outdated",
      `анализ файла выполнен прежней версией анализатора (${analysis.analyzerVersion ?? "—"}) — перезапустите анализ`
    );
  }
  return null;
}

/** Our own slice output: the same bar promotion applies. */
function sliceGate(analysis: ArtifactAnalysis | null): Refusal | null {
  if (!analysis) return refuse("analysis_refused", "у файла нет анализа — запустите анализ");
  const gate = evaluateSliceOutput(analysis);
  return gate.ok ? null : refuse("analysis_refused", gate.reason);
}

function refuse(code: ReprintRefusalCode, reason: string): Refusal {
  return { ok: false, code, reason };
}

/**
 * Where «Подготовить заново» starts from: the source model and the recipe the
 * print was made with. Null when there is no source model left to slice.
 *
 * The recipe is offered, not enforced — the wizard re-checks it like any other
 * choice (an un-approved or replaced set simply is not selectable there), and a
 * slice identical to the old one is served from the cache instantly.
 */
export interface ReprepareHint {
  artifactId: string;
  printerId: string | null;
  profileSetId: string | null;
}

export function reprepareHint(input: {
  source: Artifact | null;
  sourceAnalysis: ArtifactAnalysis | null;
  variant: SliceVariant | null;
  /** The printer the print last ran on, when it ran at all. */
  lastPrinterId: string | null;
}): ReprepareHint | null {
  const { source, sourceAnalysis } = input;
  if (!source || !sourceAnalysis || sourceAnalysis.state !== "ready") return null;
  if (sourceAnalysis.verdict !== "needs_preparation") return null;
  return {
    artifactId: source.id,
    printerId: input.variant?.targetPrinterId ?? input.lastPrinterId,
    profileSetId: input.variant?.profileSetId ?? null
  };
}
