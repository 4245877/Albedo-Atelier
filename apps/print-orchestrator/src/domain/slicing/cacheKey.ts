import { createHash } from "node:crypto";

/**
 * The inputs that fully determine a slice's output. Two slices with the same key
 * would produce byte-identical results, so a `ready` variant with a matching key
 * (and a surviving output blob) can be reused instead of re-running OrcaSlicer.
 *
 * Exactly the components the brief lists:
 *   source artifact SHA-256 + resolved profile hashes + OrcaSlicer version + worker version.
 */
export interface CacheKeyParts {
  sourceSha256: string;
  machineResolvedSha256: string;
  processResolvedSha256: string;
  filamentResolvedSha256: string;
  orcaVersion: string;
  workerVersion: string;
}

/** Deterministic cache key (hex SHA-256) over the slice's fully-resolved inputs. */
export function computeCacheKey(parts: CacheKeyParts): string {
  const material = [
    `source:${parts.sourceSha256}`,
    `machine:${parts.machineResolvedSha256}`,
    `process:${parts.processResolvedSha256}`,
    `filament:${parts.filamentResolvedSha256}`,
    `orca:${parts.orcaVersion}`,
    `worker:${parts.workerVersion}`
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}
