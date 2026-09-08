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
  /**
   * The chosen build plate of a multi-plate project, or null for a file with one
   * plate. Two plates of one project are two different prints from *identical*
   * bytes, so without this the second slice would be handed the first plate's
   * cached G-code. Omitted from the key when null, so every single-plate key —
   * and therefore every cache entry written before plates existed — is unchanged.
   */
  plateIndex?: number | null;
  /**
   * The plate's 1-based **position** — the `--slice i` that produced the bytes.
   *
   * Both numbers are in the key because they answer different halves of "would
   * this run produce the same output". The index is the plate's identity, which
   * is what a cached entry is looked up *for*; the position is what the slicer
   * was actually told, and it is derived from the file by an analyzer that can
   * change its mind. Keying on identity alone means the same sha256 read by a
   * different analyzer version — the same bytes uploaded twice, analysed either
   * side of a deploy — hits a cache entry whose G-code is a different plate.
   */
  plateSliceIndex?: number | null;
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
    ...(parts.plateIndex === undefined || parts.plateIndex === null
      ? []
      : [`plate:${parts.plateIndex}@${parts.plateSliceIndex ?? parts.plateIndex}`]),
    `machine:${parts.machineResolvedSha256}`,
    `process:${parts.processResolvedSha256}`,
    `filament:${parts.filamentResolvedSha256}`,
    `orca:${parts.orcaVersion}`,
    `worker:${parts.workerVersion}`
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}
