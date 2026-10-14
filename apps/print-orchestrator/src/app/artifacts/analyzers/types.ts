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
 *
 * `1.3.0` describes a 3MF's build plates instead of merely counting them:
 * `data.plates` now carries each plate's name, contents, own box, thumbnail
 * reference and reported estimate (see {@link file://./threemfPlates.ts}). The
 * count itself also changed — plate signals are now *unioned* rather than
 * maximised, so a package that declares plate 1 and also carries `plate_2.png`
 * reports two plates where it used to report one. That count gates the merged
 * bounding box and, through {@link file://../../../domain/print/plateSelection.ts},
 * which plate is sliced; a `1.2.0` row simply has no plate list, so a stored
 * plate choice cannot be validated against it. Re-analysis is the upgrade path.
 *
 * `1.4.0` opens a sliced 3MF's payload: the embedded `plate_N.gcode` is streamed
 * out and held to the bare-G-code analysis (command policy, header metadata,
 * printed box), checked against its `.md5` sidecar, and named so the start
 * command names the same entry; the declared target is normalised into
 * `printerModel` — the key the dispatch gate reads — instead of an unread
 * `targetPrinter` (see {@link file://./threemfPayload.ts}). Nothing changed for
 * STL or bare G-code, so their `1.3.0` rows stay current (see
 * {@link isAnalysisCurrent}); a `1.3.0` 3MF row is outdated.
 */
export const ANALYZER_VERSION = "1.4.0";

/**
 * Per format, the oldest analyzer version whose result is still current.
 *
 * A release that changes how ONE format is read must not make every other
 * file's analysis outdated: the dispatch gate refuses an outdated analysis, so a
 * blanket bump would stop every queued G-code until someone re-ran its analysis
 * by hand, for a change that never touched it. A format missing here (an
 * `unknown` file) is current only at exactly {@link ANALYZER_VERSION}.
 */
const CURRENT_SINCE: Readonly<Record<string, string>> = {
  stl: "1.3.0",
  gcode: "1.3.0",
  "3mf": "1.4.0"
};

/** Whether an analysis written by `analyzerVersion` still speaks for the current analyzer. */
export function isAnalysisCurrent(analyzerVersion: string | null, detectedFormat: string | null): boolean {
  if (!analyzerVersion || analyzerVersion === ANALYZER_VERSION) return true;
  const since = detectedFormat ? CURRENT_SINCE[detectedFormat] : undefined;
  if (!since) return false;
  const atLeast = compareVersions(analyzerVersion, since);
  const atMost = compareVersions(analyzerVersion, ANALYZER_VERSION);
  return atLeast !== null && atMost !== null && atLeast >= 0 && atMost <= 0;
}

/** Numeric `x.y.z` comparison; null when either side is not one. */
function compareVersions(a: string, b: string): number | null {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n) || n < 0)) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

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
