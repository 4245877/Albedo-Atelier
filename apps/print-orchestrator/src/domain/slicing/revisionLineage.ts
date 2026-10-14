import type { AnalysisFinding } from "../print/types";
import { finding } from "./findings";
import type { ProfileRevision } from "./types";

/**
 * Which resolution of a profile's bytes is the current one.
 *
 * A revision's effective settings — `resolvedJson`, the inheritance-merged
 * settings OrcaSlicer is handed, and the provenance that explains them — are
 * fixed the first time the revision has any. When the same bytes later resolve
 * differently (a parent preset was edited, a different vendor tree installed),
 * the importer records a NEW revision and marks the old one as superseded by it.
 *
 * The superseded revision is not withdrawn: a set approved on it keeps slicing
 * with exactly the settings that were approved, and every slice already cut
 * from it stays explained by them. It is only no longer offered for NEW sets or
 * new approvals — adopting the new settings is the operator's decision, made by
 * approving a set built on the new revision.
 */

/** Metadata key naming the revision whose resolution replaced this one's. */
export const SUPERSEDED_BY_KEY = "supersededBy";

/** Finding code a superseded revision carries (and a set built on one). */
export const SUPERSEDED_CODE = "profile_superseded";

/** The id of the revision that replaced this one's resolution, or null while it is current. */
export function supersededBy(rev: Pick<ProfileRevision, "metadata">): string | null {
  const value = rev.metadata?.[SUPERSEDED_BY_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The warning on a superseded revision itself. */
export function supersededFinding(current: Pick<ProfileRevision, "id">): AnalysisFinding {
  return finding(
    SUPERSEDED_CODE,
    `Каталог теперь разрешает этот профиль иначе — актуальные настройки в ревизии ${current.id}. ` +
      "Эта ревизия сохранена без изменений: утверждённые на ней наборы печатают прежними настройками"
  );
}

/**
 * Follows `supersededBy` links to the revision that is current now. Stops on a
 * missing link or a cycle (neither should exist; a lineage is append-only) and
 * returns the last revision reached.
 */
export function currentRevisionOf(
  rev: ProfileRevision,
  getById: (id: string) => ProfileRevision | null
): ProfileRevision {
  const seen = new Set<string>([rev.id]);
  let at = rev;
  for (let next = supersededBy(at); next !== null; next = supersededBy(at)) {
    if (seen.has(next)) break;
    const found = getById(next);
    if (!found) break;
    seen.add(next);
    at = found;
  }
  return at;
}
