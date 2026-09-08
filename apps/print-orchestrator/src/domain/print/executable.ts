import { analysisReviewAccepted, readAnalysisReview } from "./analysisReview";
import { readPlateCount } from "./plateSelection";
import type { Artifact, ArtifactAnalysis } from "./types";

/**
 * **Is this uploaded file something a printer could be handed as-is?**
 *
 * The system accepts four things: `.stl`, a plain `.3mf`, bare G-code, and a
 * sliced `.gcode.3mf`. The first two are *source geometry* and have a complete
 * road ahead of them — analysis, slicing, promotion, queue. The last two are
 * already executable, and had no road at all: the upload made a `DRAFT` task, and
 * the only thing in the system that turns a draft into a queued job is
 * `promoteSliceVariant`, which needs a slice variant that an already-sliced file
 * by definition does not have. So a perfectly good G-code was accepted, analysed,
 * shown as green, and could not be printed by any route in the interface.
 *
 * This is the admission test for the use case that closes that gap. It is
 * separate from {@link file://../slicing/outputGate.ts evaluateSliceOutput} —
 * which judges *our own* slicer's output and is deliberately stricter, refusing
 * anything that is not bare G-code — because the two answer different questions:
 * that one asks "may we bind this as a slice result", this one asks "may an
 * operator queue this file they uploaded".
 *
 * Fail-closed, and it never *creates* permission: a `review` verdict passes only
 * when a named operator has already accepted it against these exact bytes (see
 * {@link file://./analysisReview.ts}), which is a separate, audited act.
 */

/** What an executable file is, once the analysis has spoken. */
export type ExecutableKind =
  /** Bare G-code (`.gcode`/`.gco`/`.g`) — content-verified. */
  | "gcode"
  /** A sliced 3MF: an archive whose payload is a plate's G-code. */
  | "sliced_3mf";

export type ExecutableAdmission =
  | { ok: true; kind: ExecutableKind; acknowledgedBy: string | null }
  | {
      ok: false;
      /** Stable key so the UI can branch instead of matching on text. */
      code:
        | "analysis_missing"
        | "analysis_incomplete"
        | "analysis_failed"
        | "analysis_blocked"
        | "not_executable"
        | "multi_plate_payload"
        | "needs_review";
      reason: string;
      /**
       * True when the only thing missing is a human reading the review. The
       * upload card turns this into «прочитайте причину и подтвердите», which is
       * the difference between a dead end and a next step.
       */
      needsReview: boolean;
    };

/** The 3MF flavours that carry a G-code payload, as the analyzer classifies them. */
const SLICED_3MF_CLASS = "sliced";

export function evaluateExecutableArtifact(
  artifact: Artifact,
  analysis: ArtifactAnalysis | null
): ExecutableAdmission {
  if (!analysis) {
    return {
      ok: false,
      code: "analysis_missing",
      reason: "у файла нет анализа — запустите анализ перед постановкой в очередь",
      needsReview: false
    };
  }
  if (analysis.state === "pending" || analysis.state === "running") {
    return {
      ok: false,
      code: "analysis_incomplete",
      reason: "анализ файла ещё не завершён",
      needsReview: false
    };
  }
  if (analysis.state === "failed") {
    return {
      ok: false,
      code: "analysis_failed",
      reason: analysis.error ?? "анализ файла завершился ошибкой — перезапустите анализ",
      needsReview: false
    };
  }
  if (analysis.blockers.length > 0) {
    return {
      ok: false,
      code: "analysis_blocked",
      reason: `анализ выявил критические проблемы: ${analysis.blockers.map((b) => b.message).join("; ")}`,
      needsReview: false
    };
  }

  const kind = executableKindOf(analysis);
  if (kind === null) {
    return {
      ok: false,
      code: "not_executable",
      reason:
        analysis.detectedFormat === "stl" || analysis.detectedFormat === "3mf"
          ? "это модель, а не готовый к печати файл — сначала нарежьте её в разделе «Слайсинг»"
          : `формат «${analysis.detectedFormat ?? "неизвестно"}» нельзя отправить на принтер как есть`,
      needsReview: false
    };
  }

  // An already-sliced package holding several plates is several finished prints
  // in one container, and picking one is a *delivery* problem: the chosen plate's
  // G-code would have to be unpacked and re-wrapped for the machine, and nothing
  // here does that. Refused before any acknowledgement can apply — a human ticking
  // "I have read the review" is not consent to ship an arbitrary plate — and
  // deliberately separate from the project flow next door, where choosing a plate
  // means *slicing* that plate and is fully supported.
  if (kind === "sliced_3mf" && readPlateCount(analysis) > 1) {
    return {
      ok: false,
      code: "multi_plate_payload",
      reason:
        `нарезанный файл содержит ${readPlateCount(analysis)} пластин — отправить такой на принтер целиком нельзя; ` +
        "экспортируйте нужную пластину отдельным файлом или загрузите проект и нарежьте пластину здесь",
      needsReview: false
    };
  }

  if (analysis.verdict === "schedulable") {
    return { ok: true, kind, acknowledgedBy: null };
  }

  // Everything else needs a human to have read it. A sliced 3MF is *always* here
  // by construction: its parameters came from somebody else's machine profile, so
  // the analyzer marks it `review` unconditionally and correctly.
  if (analysisReviewAccepted(artifact, analysis)) {
    return {
      ok: true,
      kind,
      acknowledgedBy: readAnalysisReview(artifact, analysis)?.acknowledgement.confirmedBy ?? null
    };
  }

  const stale = readAnalysisReview(artifact, analysis);
  return {
    ok: false,
    code: "needs_review",
    reason:
      stale?.stale === true
        ? `подтверждение проверки устарело (${stale.staleReason}) — подтвердите заново`
        : `вердикт анализа «${analysis.verdict ?? "—"}» требует подтверждения оператора`,
    needsReview: true
  };
}

/**
 * The executable kind, from the analysed CONTENT — never the file name.
 *
 * A `.gcode.3mf` is a ZIP, so the format detector honestly reports `3mf`; what
 * makes it executable is the `sliced` classification the 3MF analyzer assigns
 * after opening the archive and finding a real plate payload (not just a
 * `.md5` sidecar).
 */
export function executableKindOf(analysis: ArtifactAnalysis): ExecutableKind | null {
  if (analysis.detectedFormat === "gcode") return "gcode";
  if (analysis.detectedFormat === "3mf") {
    const cls = analysis.data?.threeMfClass;
    const hasPayload = analysis.data?.hasGcodePayload;
    if (cls === SLICED_3MF_CLASS || hasPayload === true) return "sliced_3mf";
  }
  return null;
}
