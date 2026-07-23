import path from "node:path";

import { readPositiveInt, readPositiveNumber } from "./readers";
import { envVar, type EnvSource } from "./registry";

const MB = 1024 * 1024;

const VARS = {
  /**
   * Root of the content-addressed artifact blob store (`sha256/<prefix>/<hash>`),
   * kept next to the state file on the same mounted `/app/data` volume so
   * uploaded model/G-code bytes survive a restart. Never stored in SQLite — the
   * database keeps only the relative storage key.
   */
  storageRoot: envVar("ARTIFACT_STORAGE_ROOT", "uploads", (_n, raw) => raw || null),
  /**
   * Directory uploads are staged in before the atomic move into blob storage.
   * Defaults under the storage root so the rename stays on one filesystem
   * (atomic); an override on another device falls back to a copy.
   */
  tmpDir: envVar("UPLOAD_TMP_DIR", "uploads", (_n, raw) => raw || null),
  /** Maximum size of a single uploaded file (bytes). */
  maxFileBytes: envVar("MAX_UPLOAD_FILE_BYTES", "uploads", (n, raw) => readPositiveInt(n, raw, 200 * MB)),
  /** Maximum number of files the dashboard may add in one batch (advisory; enforced client-side). */
  maxFiles: envVar("MAX_UPLOAD_FILES", "uploads", (n, raw) => readPositiveInt(n, raw, 20)),
  /** Maximum combined size of one batch (advisory; enforced client-side). */
  maxTotalBytes: envVar("MAX_UPLOAD_TOTAL_BYTES", "uploads", (n, raw) => readPositiveInt(n, raw, 500 * MB)),
  /**
   * Hard SERVER-side cap on the total on-disk artifact store (dedup-aware sum of
   * distinct blob sizes). A new upload that would push past it is refused (413),
   * so a flood of uploads cannot fill the shared data volume. Distinct from the
   * advisory per-batch `maxTotalBytes` above.
   */
  maxStoredBytes: envVar("MAX_ARTIFACT_STORE_BYTES", "uploads", (n, raw) =>
    readPositiveInt(n, raw, 20 * 1024 * MB)
  ),
  /** Hard SERVER-side cap on the number of stored artifacts. */
  maxArtifactCount: envVar("MAX_ARTIFACT_COUNT", "uploads", (n, raw) => readPositiveInt(n, raw, 5000)),
  /**
   * Free-disk reserve (bytes): an upload is refused when the filesystem holding
   * the store has less than this available, so the service degrades safely
   * instead of filling the disk the JSON state + SQLite also live on.
   */
  minFreeDiskBytes: envVar("UPLOAD_MIN_FREE_DISK_BYTES", "uploads", (n, raw) =>
    readPositiveInt(n, raw, 512 * MB)
  ),
  /**
   * Cap on the number of analyses queued/running at once. Beyond it an upload is
   * refused (503) rather than growing an unbounded backlog that would keep the
   * event loop and disk busy — the "лимит общей очереди анализа" bound.
   */
  analysisMaxQueue: envVar("ANALYSIS_MAX_QUEUE", "uploads", (n, raw) => readPositiveInt(n, raw, 200)),
  /**
   * Default age cutoff (days) for the artifact retention sweep — only provably
   * unused artifacts older than this are reclaimed, and only when the operator
   * (or a cron) invokes the sweep endpoint; nothing is deleted spontaneously.
   */
  retentionDays: envVar("ARTIFACT_RETENTION_DAYS", "uploads", (n, raw) => readPositiveInt(n, raw, 30)),
  /** Per-file analysis wall-clock budget (ms) before it is failed as timed out. */
  analysisTimeoutMs: envVar("ANALYSIS_TIMEOUT_MS", "uploads", (n, raw) => readPositiveInt(n, raw, 30000)),
  /** How many files may be analysed concurrently by the in-process worker pool. */
  analysisConcurrency: envVar("ANALYSIS_CONCURRENCY", "uploads", (n, raw) => readPositiveInt(n, raw, 2)),
  /** ZIP (3MF) safety caps — see the SafeZip reader. */
  zipMaxEntries: envVar("UPLOAD_ZIP_MAX_ENTRIES", "uploads", (n, raw) => readPositiveInt(n, raw, 10000)),
  zipMaxEntryBytes: envVar("UPLOAD_ZIP_MAX_ENTRY_BYTES", "uploads", (n, raw) =>
    readPositiveInt(n, raw, 256 * MB)
  ),
  zipMaxTotalBytes: envVar("UPLOAD_ZIP_MAX_TOTAL_BYTES", "uploads", (n, raw) =>
    readPositiveInt(n, raw, 512 * MB)
  ),
  zipMaxRatio: envVar("UPLOAD_ZIP_MAX_RATIO", "uploads", (n, raw) => readPositiveNumber(n, raw, 200)),
  /** Maximum size of any single XML document parsed from a 3MF. */
  xmlMaxBytes: envVar("UPLOAD_XML_MAX_BYTES", "uploads", (n, raw) => readPositiveInt(n, raw, 64 * MB))
};

/**
 * Upload + analysis limits and locations. All numeric values are strictly
 * positive: an invalid override fails startup with a clear message
 * (see `readPositiveInt`); an unset one uses the documented default here.
 * Defaults are deliberately generous enough for real FDM slices yet bounded so a
 * hostile upload cannot exhaust disk, memory or CPU.
 */
export function buildUploadsConfig(source: EnvSource, stateDir: string) {
  const storageRoot = VARS.storageRoot.read(source) ?? path.resolve(stateDir, "artifacts");
  return {
    storageRoot,
    tmpDir: VARS.tmpDir.read(source) ?? path.join(storageRoot, ".tmp"),
    maxFileBytes: VARS.maxFileBytes.read(source),
    maxFiles: VARS.maxFiles.read(source),
    maxTotalBytes: VARS.maxTotalBytes.read(source),
    maxStoredBytes: VARS.maxStoredBytes.read(source),
    maxArtifactCount: VARS.maxArtifactCount.read(source),
    minFreeDiskBytes: VARS.minFreeDiskBytes.read(source),
    analysisMaxQueue: VARS.analysisMaxQueue.read(source),
    retentionDays: VARS.retentionDays.read(source),
    analysisTimeoutMs: VARS.analysisTimeoutMs.read(source),
    analysisConcurrency: VARS.analysisConcurrency.read(source),
    zipMaxEntries: VARS.zipMaxEntries.read(source),
    zipMaxEntryBytes: VARS.zipMaxEntryBytes.read(source),
    zipMaxTotalBytes: VARS.zipMaxTotalBytes.read(source),
    zipMaxRatio: VARS.zipMaxRatio.read(source),
    xmlMaxBytes: VARS.xmlMaxBytes.read(source)
  };
}
