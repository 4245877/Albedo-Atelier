import type { AnalysisFinding, ArtifactAnalysis } from "../print/types";
import { dedupeFindings, finding } from "./findings";

/** The outcome of admitting a slice's output analysis: usable, or the reasons it is not. */
export type SliceOutputGate = { ok: true } | { ok: false; reason: string; blockers: AnalysisFinding[] };

/**
 * The single admission test for a slice's OUTPUT analysis, mirroring the dispatch
 * gate: a sliced file is only usable — `ready` as a variant, and promotable onto a
 * task — when its analysis actually completed (`state: "ready"`), the verdict is
 * `schedulable`, and there is no blocker (e.g. a forbidden config-mutating command
 * like M502/SAVE_CONFIG baked into a profile's start/end G-code, which the analyzer
 * flags `blocked` while the job itself is technically `ready`).
 *
 * Shared by the slice pipeline (which uses it to decide a variant's terminal state)
 * and the handoff (which uses it before binding an output onto a dispatchable task),
 * so the two can never disagree on what "a safe, verified output" means and an
 * unverified file can never slip through either path.
 */
export function evaluateSliceOutput(analysis: ArtifactAnalysis): SliceOutputGate {
  if (analysis.state !== "ready") {
    return {
      ok: false,
      reason: analysis.error ?? "Анализ выходного файла не завершился успешно",
      blockers: [finding("output_analysis_incomplete", analysis.error ?? "Не удалось проанализировать выходной файл")]
    };
  }
  const blockers = [...analysis.blockers];
  if (analysis.verdict !== "schedulable") {
    blockers.push(
      finding(
        "output_not_schedulable",
        `Вердикт анализа выходного файла «${analysis.verdict ?? "—"}» не допускает запуск (нужен schedulable)`
      )
    );
  }
  if (blockers.length > 0) {
    return { ok: false, reason: blockers.map((b) => b.message).join("; "), blockers: dedupeFindings(blockers) };
  }
  return { ok: true };
}
