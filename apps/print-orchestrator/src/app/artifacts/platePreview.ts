import fsp from "node:fs/promises";

import { NotFoundError, ValidationError } from "../../core/errors";
import { readPlates } from "../../domain/print/plateSelection";
import type { ArtifactAnalysis } from "../../domain/print/types";
import {
  PREVIEW_MAX_BYTES,
  sniffImage,
  type PreviewContentType
} from "./analyzers/threemfPlateAssets";
import { fileHandleSource, SafeZip, ZipSafetyError } from "./analyzers/zip";
import type { ArtifactContext } from "./context";

/**
 * Serving one build plate's thumbnail out of the uploaded 3MF.
 *
 * The bytes are not in the database — an analysis row is JSON, and a few hundred
 * kilobytes of PNG per plate would be paid for on every read of every artifact.
 * They are re-read from the content-addressed blob on demand, which makes this
 * the only place in the service that opens an untrusted archive *because a
 * client asked it to*. Two rules keep that safe, and neither is negotiable:
 *
 *   1. **The client names a plate, never a path.** The request carries an
 *      artifact id and a plate number. The archive entry comes from the stored
 *      analysis — written by the analyzer, which resolved it against the
 *      package's own metadata and verified the bytes were an image. There is no
 *      request shape that can make this read an entry of the caller's choosing,
 *      so there is no traversal, no `/etc/passwd`, no arbitrary-file-read
 *      primitive to defend against: the lookup simply has no user input in it.
 *   2. **The same {@link SafeZip} the analyzer used.** Every ZIP-bomb, ratio,
 *      traversal, duplicate-name and symlink guard applies identically, at the
 *      original configured limits — the preview path never relaxes them — plus
 *      this module's own {@link PREVIEW_MAX_BYTES} ceiling.
 *
 * And the type is re-derived from the signature on the way out, not trusted from
 * the analysis: even a doctored `data` column cannot make this serve an SVG or
 * an HTML document as `image/png`. Together with the `nosniff` header the API
 * already sets on every response, a preview cannot become a script.
 */

export interface PlatePreviewImage {
  data: Buffer;
  contentType: PreviewContentType;
  /** Weak validator for the browser cache — content-addressed, so genuinely stable. */
  etag: string;
}

export class PlatePreviewService {
  constructor(private readonly ctx: ArtifactContext) {}

  /**
   * The thumbnail for one plate, or a 404-shaped error naming what is missing.
   * `plateIndex` is the plate's own number, exactly as the plate list reports it.
   */
  async read(artifactId: string, plateIndex: number): Promise<PlatePreviewImage> {
    if (!Number.isInteger(plateIndex)) {
      throw new ValidationError("Номер пластины должен быть целым числом");
    }
    const repos = this.ctx.store.repositories;
    const artifact = repos.artifacts.getById(artifactId);
    if (!artifact) throw new NotFoundError(`Артефакт «${artifactId}»`);
    if (!artifact.source) throw new NotFoundError(`Файл артефакта «${artifactId}»`);

    const analysis: ArtifactAnalysis | null = repos.artifactAnalyses.latestForArtifact(artifactId);
    const plate = readPlates(analysis).find((p) => p.index === plateIndex);
    if (!plate) throw new NotFoundError(`Пластина №${plateIndex} артефакта «${artifactId}»`);

    // The entry name comes from the analysis the analyzer wrote, never from the
    // request. `readPlates` deliberately does not carry it (nothing *decides* on
    // it), so it is taken from the same record here, re-validated as a string.
    const entry = previewEntryOf(analysis, plateIndex);
    if (!entry) throw new NotFoundError(`Превью пластины №${plateIndex}`);

    const path = this.ctx.storage.resolvePath(artifact.source);
    const stat = await fsp.stat(path).catch(() => null);
    if (!stat) throw new NotFoundError(`Файл артефакта «${artifactId}»`);

    const handle = await fsp.open(path, "r");
    try {
      const limits = this.ctx.options.limits;
      const zip = await SafeZip.open(fileHandleSource(handle, stat.size), {
        maxEntries: limits.zipMaxEntries,
        maxEntryBytes: limits.zipMaxEntryBytes,
        maxTotalBytes: limits.zipMaxTotalBytes,
        maxRatio: limits.zipMaxRatio
      });
      // The archive may have been re-uploaded under the same artifact row since
      // the analysis; an entry that is no longer there is a missing preview, not
      // an error to shout about.
      const declared = zip.entries.find((e) => e.name === entry && !e.isDirectory);
      if (!declared || declared.uncompressedSize > PREVIEW_MAX_BYTES) {
        throw new NotFoundError(`Превью пластины №${plateIndex}`);
      }
      const data = await zip.read(entry, PREVIEW_MAX_BYTES);
      const image = sniffImage(data);
      if (!image) throw new NotFoundError(`Превью пластины №${plateIndex}`);

      return {
        data,
        contentType: image.contentType,
        etag: `"${artifact.sha256 ?? artifact.id}-p${plateIndex}"`
      };
    } catch (error) {
      // A hostile archive is not a server fault: it is a preview we will not
      // serve. The analysis already carries the finding that says so.
      if (error instanceof ZipSafetyError) throw new NotFoundError(`Превью пластины №${plateIndex}`);
      throw error;
    } finally {
      await handle.close();
    }
  }
}

/** The archive entry the analysis recorded for this plate's preview, if any. */
function previewEntryOf(analysis: ArtifactAnalysis | null, plateIndex: number): string | null {
  const plates = analysis?.data?.plates;
  if (!Array.isArray(plates)) return null;
  for (const raw of plates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    if (rec.index !== plateIndex) continue;
    const preview = rec.preview;
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) return null;
    const entry = (preview as Record<string, unknown>).entry;
    return typeof entry === "string" && entry.trim() ? entry : null;
  }
  return null;
}
