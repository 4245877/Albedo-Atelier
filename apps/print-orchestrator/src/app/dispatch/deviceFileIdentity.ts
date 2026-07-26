import type { DeviceArtifact } from "../../domain/print/types";

/**
 * **What the file on the printer must be**, and whether a tracked record still
 * describes it.
 *
 * A `DeviceArtifact` row is a statement about the past: "at 14:02 these bytes
 * were at this path on this machine". Everything the statement depends on can
 * change afterwards — the task can be re-sliced, the plan re-confirmed onto
 * another printer, a preset re-import can move the profile set, the operator can
 * withdraw the assignment. None of that touches the row, so without this check a
 * `VERIFIED` record keeps authorising a start of a file nobody would choose now.
 *
 * Staleness is therefore computed at **every** read that could lead to a start,
 * not only when something helpfully tells us to invalidate. The comparison is
 * one-directional and conservative: an expectation that genuinely does not know
 * a value (no slice yet, artifact without a recorded size) never *invents*
 * staleness — the other eligibility rules refuse an unknown on their own terms.
 * But a value that is known and differs is always stale.
 */

/** The identity a device file must have to be usable for a given dispatch. */
export interface DeviceFileExpectation {
  printerId: string;
  /** Normalized on-device path the dispatch would start. */
  remotePath: string;
  sliceVariantId: string | null;
  artifactId: string | null;
  artifactSha256: string | null;
  sizeBytes: number | null;
  /** The assignment the delivery belongs to; null when evaluating a bare task. */
  assignmentId: string | null;
  /** Profile revisions the executable was produced with (order-insensitive). */
  profileRevisionIds: readonly string[];
}

/** Metadata key under which a record remembers the profiles it was prepared for. */
export const PROFILE_REVISIONS_KEY = "profileRevisionIds";

/**
 * Why `record` no longer describes `expected`, or `null` when it still does.
 * The string is operator-facing and goes into `lastError` / the audit trail.
 */
export function stalenessOf(
  record: DeviceArtifact,
  expected: DeviceFileExpectation
): string | null {
  if (record.printerId !== expected.printerId) {
    return `файл подготовлен для принтера «${record.printerId}», а запуск на «${expected.printerId}»`;
  }
  if (record.remotePath !== expected.remotePath) {
    return `файл подготовлен по пути «${record.remotePath}», а ожидается «${expected.remotePath}»`;
  }
  if (expected.sliceVariantId !== null && record.sliceVariantId !== expected.sliceVariantId) {
    return `файл подготовлен по варианту слайсинга «${record.sliceVariantId ?? "—"}», текущий «${expected.sliceVariantId}»`;
  }
  if (expected.artifactId !== null && record.artifactId !== null && record.artifactId !== expected.artifactId) {
    return `файл подготовлен из артефакта «${record.artifactId}», текущий «${expected.artifactId}»`;
  }
  if (expected.artifactSha256 !== null) {
    if (record.artifactSha256 === null) {
      return "у подготовленного файла не записан хеш содержимого — идентичность недоказуема";
    }
    if (record.artifactSha256 !== expected.artifactSha256) {
      return "содержимое отличается от того, что было подготовлено (хеш не совпадает)";
    }
  }
  if (
    expected.sizeBytes !== null &&
    record.sizeBytes !== null &&
    record.sizeBytes !== expected.sizeBytes
  ) {
    return `размер подготовленного файла ${record.sizeBytes} ≠ ожидаемого ${expected.sizeBytes}`;
  }
  if (
    expected.assignmentId !== null &&
    record.assignmentId !== null &&
    record.assignmentId !== expected.assignmentId
  ) {
    return `файл подготовлен для другого назначения «${record.assignmentId}»`;
  }
  const recorded = readProfileRevisions(record);
  if (recorded !== null && !sameSet(recorded, expected.profileRevisionIds)) {
    return "профили печати изменились после подготовки файла";
  }
  return null;
}

/** The profile revisions a record was prepared under; `null` when it recorded none. */
export function readProfileRevisions(record: DeviceArtifact): string[] | null {
  const raw = record.metadata[PROFILE_REVISIONS_KEY];
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids.length > 0 ? ids : null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((id) => set.has(id));
}
