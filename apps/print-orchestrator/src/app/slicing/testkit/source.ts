import { ID_PREFIX, newId } from "../../../domain/print/ids";
import type { PrintQueueStore } from "../../../domain/print/repositories";
import type { ArtifactAnalysis } from "../../../domain/print/types";
import { ANALYZER_VERSION } from "../../artifacts/analyzers";

/**
 * Records the analysis of a slice's SOURCE model as a file that declares its own
 * unit (a 3MF with `unit="millimeter"`), so the slice cut from it has proven
 * millimetres.
 *
 * Fixtures used to insert a source artifact with no analysis at all and a
 * finished slice next to it — and the slice's box was trusted as millimetres
 * anyway, because G-code always is. That was the HIGH-07 defect: the source's
 * unit decides whether the slice's size is proven. A fixture that means "a
 * properly prepared job" now says where its scale came from.
 */
export function declareSourceUnits(
  store: PrintQueueStore,
  sourceArtifactId: string,
  sizeMm: [number, number, number] = [100, 100, 100],
  at = "2026-08-14T12:00:00.000Z"
): ArtifactAnalysis {
  const analysis: ArtifactAnalysis = {
    id: newId(ID_PREFIX.artifactAnalysis),
    artifactId: sourceArtifactId,
    state: "ready",
    detectedFormat: "3mf",
    verdict: "needs_preparation",
    analyzer: "3mf",
    analyzerVersion: ANALYZER_VERSION,
    estimatedDurationS: null,
    estimatedFilamentG: null,
    material: null,
    nozzleDiameterMm: null,
    layerHeightMm: null,
    warnings: [],
    blockers: [],
    data: {
      threeMfClass: "generic",
      geometry: { scaleKnown: true, sizeMm, sizeRaw: sizeMm, plateCount: 1, multiPlate: false }
    },
    error: null,
    createdAt: at,
    updatedAt: at,
    version: 1,
    metadata: {}
  };
  return store.repositories.artifactAnalyses.insert(analysis);
}
