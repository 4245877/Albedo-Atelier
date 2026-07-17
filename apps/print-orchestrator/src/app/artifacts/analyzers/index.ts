import fsp from "node:fs/promises";

import { detectFormat } from "./detect";
import { analyzeGcode } from "./gcode";
import { analyzeStl } from "./stl";
import { analyze3mf } from "./threemf";
import { ANALYZER_VERSION, escalateToReview, finding, type AnalyzerLimits, type AnalyzerResult } from "./types";

export { ANALYZER_VERSION } from "./types";
export type { AnalyzerLimits, AnalyzerResult } from "./types";

/** What the worker hands the analyzer: the committed blob path + upload identity. */
export interface AnalyzerInput {
  /** Absolute path to the content-addressed blob (resolved from the storage key). */
  path: string;
  sizeBytes: number;
  /** Original upload file name — used only to compare the declared extension. */
  fileName: string;
}

/**
 * The single entry point the analysis worker calls. It opens the blob once,
 * detects the real format from its bytes, dispatches to the matching analyzer,
 * and — because the file name is never authoritative — escalates the verdict to
 * at least `review` when the declared extension contradicts the detected
 * content. Content that matches no supported format is `blocked`.
 */
export async function analyzeFile(input: AnalyzerInput, limits: AnalyzerLimits): Promise<AnalyzerResult> {
  const handle = await fsp.open(input.path, "r");
  try {
    const detection = await detectFormat(handle, input.sizeBytes, input.fileName);

    let result: AnalyzerResult;
    switch (detection.format) {
      case "stl":
        result = await analyzeStl(handle, input.path, input.sizeBytes, detection.stlVariant ?? "binary");
        break;
      case "3mf":
        result = await analyze3mf(handle, input.sizeBytes, limits);
        break;
      case "gcode":
        result = await analyzeGcode(input.path);
        break;
      default:
        result = {
          detectedFormat: "unknown",
          verdict: "blocked",
          warnings: [],
          blockers: [
            finding(
              "unsupported_content",
              "Содержимое не распознано как STL, 3MF или G-code"
            )
          ],
          data: {},
          analyzer: "detect",
          analyzerVersion: ANALYZER_VERSION
        };
    }

    if (detection.extMismatch && detection.format !== "unknown") {
      result.warnings.push(
        finding(
          "ext_mismatch",
          `Расширение${detection.declaredExt ? ` .${detection.declaredExt}` : ""} не совпадает с содержимым (${detection.format})`
        )
      );
      result.verdict = escalateToReview(result.verdict);
    }

    result.data.declaredExt = detection.declaredExt;
    result.data.extMismatch = detection.extMismatch;
    return result;
  } finally {
    await handle.close();
  }
}
