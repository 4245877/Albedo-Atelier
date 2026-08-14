import type { AnalysisFinding, AnalysisVerdict, DetectedFormat } from "../../../domain/print/types";

/**
 * The built-in analyzer suite version. Bumped when the extraction logic changes
 * so a re-analysis after a deploy is comparable to the old one (stored on the
 * {@link ArtifactAnalysis.analyzerVersion} column).
 *
 * `1.1.0` added the normalized {@link file://./geometry.ts geometry} payload:
 * unit-resolved millimetre bounds, an explicit `scaleKnown` flag and per-plate
 * scoping. A row written by `1.0.0` is still *readable* (the scheduler falls
 * back to its `bbox`/`units` pair) but dispatch refuses it as outdated until it
 * is re-analysed — which is the intended, fail-closed upgrade path.
 *
 * `1.2.0` changed what G-code analysis *means* on two counts, so its rows are not
 * comparable with `1.1.0`'s and the same fail-closed re-analysis applies: `bbox`
 * is now the printed model's box rather than every motion the head makes (see
 * {@link file://./gcode.ts}), and command safety is judged in the context of the
 * target machine rather than by opcode alone (see {@link file://./gcodePolicy.ts}).
 */
export const ANALYZER_VERSION = "1.2.0";

/**
 * The pure output of analysing one file's bytes — no persistence, no ids. The
 * {@link file://../artifactService.ts ArtifactService} maps this onto an
 * {@link ArtifactAnalysis} row. `data` is the format-specific structured payload
 * (bbox, slicer, plate…); the optional lifted fields populate the typed columns.
 */
export interface AnalyzerResult {
  detectedFormat: DetectedFormat;
  verdict: AnalysisVerdict;
  warnings: AnalysisFinding[];
  blockers: AnalysisFinding[];
  data: Record<string, unknown>;
  analyzer: string;
  analyzerVersion: string;
  material?: string | null;
  estimatedDurationS?: number | null;
  estimatedFilamentG?: number | null;
  nozzleDiameterMm?: number | null;
  layerHeightMm?: number | null;
}

/** Limits handed to the analyzers (ZIP/XML/gcode caps), sourced from env. */
export interface AnalyzerLimits {
  zipMaxEntries: number;
  zipMaxEntryBytes: number;
  zipMaxTotalBytes: number;
  zipMaxRatio: number;
  xmlMaxBytes: number;
}

export function finding(code: string, message: string, hint?: string): AnalysisFinding {
  return hint ? { code, message, hint } : { code, message };
}

/** How restrictive each verdict is; the worst (highest) one wins when several apply. */
const VERDICT_RANK: Record<AnalysisVerdict, number> = {
  schedulable: 0,
  needs_preparation: 1,
  needs_input: 2,
  review: 3,
  blocked: 4
};

/** Picks the most restrictive verdict from a set (defaults to `blocked` if empty). */
export function worstVerdict(verdicts: readonly AnalysisVerdict[]): AnalysisVerdict {
  return verdicts.reduce(
    (worst, v) => (VERDICT_RANK[v] > VERDICT_RANK[worst] ? v : worst),
    verdicts[0] ?? "blocked"
  );
}

/** Raises a verdict to at least `review` (leaving an already-`blocked` one). */
export function escalateToReview(verdict: AnalysisVerdict): AnalysisVerdict {
  return verdict === "blocked" ? "blocked" : worstVerdict([verdict, "review"]);
}
