import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { PayloadTooLargeError, ValidationError } from "../../core/errors";

/**
 * Content-addressed blob storage for uploaded artifacts.
 *
 * The physical bytes live on disk, **never** in SQLite (no BLOB column, no JSON
 * blob) — the database keeps only an opaque relative *storage key*, never an
 * absolute filesystem path. The layout is
 *
 *     <root>/sha256/<first-2-hex>/<full-64-hex>
 *
 * so identical content lands on the same path and is stored exactly once
 * (`commit` reports whether the blob already existed). Uploads are written to a
 * temp file first, hashed while streaming, then **atomically renamed** into
 * place, so a partial/aborted upload never appears as a real blob and a crash
 * cannot leave a half-written content file.
 *
 * This class owns only the bytes; the {@link file://../../app/artifacts/artifactService.ts
 * ArtifactService} owns the database rows and decides when an orphaned blob may
 * be removed (never a blob another artifact still references).
 */

/** Result of streaming an upload to a temp file (not yet content-addressed). */
export interface StagedBlob {
  tempPath: string;
  sha256: string;
  sizeBytes: number;
}

/** Result of committing a staged blob into content-addressed storage. */
export interface CommittedBlob {
  /** Relative storage key persisted as `Artifact.source` (never an absolute path). */
  key: string;
  sha256: string;
  sizeBytes: number;
  /** True when a blob with this content already existed (nothing was written). */
  deduplicated: boolean;
}

export interface ArtifactStorageOptions {
  /** Root under which the `sha256/<prefix>/<hash>` tree lives. */
  root: string;
  /**
   * Directory temp uploads are staged in before the atomic move. Defaults to
   * `<root>/.tmp` so the rename stays on the same filesystem (atomic); an
   * override on another device falls back to a copy.
   */
  tmpDir?: string;
}

const KEY_PREFIX = "sha256";
/** A committed key must look exactly like `sha256/<2 hex>/<64 hex>` — nothing else is resolvable. */
const KEY_RE = /^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

export class ArtifactStorage {
  readonly root: string;
  readonly tmpDir: string;

  constructor(options: ArtifactStorageOptions) {
    this.root = path.resolve(options.root);
    this.tmpDir = options.tmpDir ? path.resolve(options.tmpDir) : path.join(this.root, ".tmp");
  }

  /** Creates the storage root and temp directory if they do not exist yet. */
  async init(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
  }

  /**
   * Streams `source` into a temp file, computing its SHA-256 and byte length on
   * the way. Enforces `maxBytes` while streaming so an over-limit upload is
   * stopped early rather than after the whole body lands. The temp file is
   * always cleaned up on any error (limit, aborted connection, read error);
   * `alreadyTruncated` lets a caller signal a limit the transport already hit
   * (e.g. `@fastify/multipart` marking the part truncated).
   */
  async stage(
    source: Readable,
    options: { maxBytes?: number; alreadyTruncated?: () => boolean } = {}
  ): Promise<StagedBlob> {
    await this.init();
    const tempPath = path.join(this.tmpDir, `${randomUUID()}.part`);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const maxBytes = options.maxBytes;

    const meter = async function* (src: Readable): AsyncGenerator<Buffer> {
      for await (const chunk of src) {
        const buf = chunk as Buffer;
        sizeBytes += buf.length;
        if (maxBytes !== undefined && sizeBytes > maxBytes) {
          throw new PayloadTooLargeError(
            `Файл превышает лимит ${maxBytes} байт`,
            { limitBytes: maxBytes }
          );
        }
        hash.update(buf);
        yield buf;
      }
    };

    try {
      await pipeline(source, meter, fs.createWriteStream(tempPath));
      // The transport (multipart) may have silently cut the stream at its own
      // limit; treat that as an over-limit upload rather than a valid short file.
      if (options.alreadyTruncated?.()) {
        throw new PayloadTooLargeError("Файл превышает лимит загрузки");
      }
      return { tempPath, sha256: hash.digest("hex"), sizeBytes };
    } catch (error) {
      await this.discard(tempPath);
      throw error;
    }
  }

  /**
   * Moves a staged temp file into content-addressed storage. If the target
   * already holds this content the temp file is discarded and
   * `deduplicated: true` is returned (the existing blob is trusted, not
   * overwritten). Otherwise the temp file is atomically renamed into place.
   */
  async commit(staged: StagedBlob): Promise<CommittedBlob> {
    const key = keyFor(staged.sha256);
    const dest = this.resolvePath(key);

    if (await pathExists(dest)) {
      await this.discard(staged.tempPath);
      return { key, sha256: staged.sha256, sizeBytes: staged.sizeBytes, deduplicated: true };
    }

    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(staged.tempPath, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        // Temp dir is on another filesystem — rename is not atomic across
        // devices, so copy then remove the temp. copyFile writes to a fresh
        // inode; a concurrent identical upload racing to the same dest is
        // idempotent (same bytes), so overwrite is safe.
        await fsp.copyFile(staged.tempPath, dest);
        await this.discard(staged.tempPath);
      } else if ((error as NodeJS.ErrnoException).code === "ENOENT" && (await pathExists(dest))) {
        // A concurrent upload of the same content won the race and created it.
        await this.discard(staged.tempPath);
        return { key, sha256: staged.sha256, sizeBytes: staged.sizeBytes, deduplicated: true };
      } else {
        await this.discard(staged.tempPath);
        throw error;
      }
    }
    return { key, sha256: staged.sha256, sizeBytes: staged.sizeBytes, deduplicated: false };
  }

  /** Removes a staged temp file; missing file is not an error. */
  async discard(tempPath: string): Promise<void> {
    await fsp.rm(tempPath, { force: true });
  }

  /**
   * Removes a committed blob by key — used only to clean up an orphan a failed
   * DB write left behind. The caller must have verified no artifact references
   * it; this never checks references itself.
   */
  async remove(key: string): Promise<void> {
    await fsp.rm(this.resolvePath(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return pathExists(this.resolvePath(key));
  }

  /**
   * Bytes currently available to an unprivileged writer on the filesystem that
   * holds the store, or `null` when it cannot be determined (statfs unsupported
   * on the platform). Used for the pre-upload free-disk reserve check.
   */
  async freeBytes(): Promise<number | null> {
    try {
      await this.init();
      const stat = await fsp.statfs(this.root);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch {
      return null;
    }
  }

  /** A read stream over a committed blob (for the analyzer). */
  createReadStream(key: string): Readable {
    return fs.createReadStream(this.resolvePath(key));
  }

  /**
   * The absolute on-disk path for a storage key — used internally and by the
   * analyzer. Rejects any key that is not a well-formed `sha256/<..>/<..>` (no
   * traversal, no absolute paths): the key is never derived from a user-supplied
   * file name, but this is defence in depth in case a corrupt row is read back.
   */
  resolvePath(key: string): string {
    if (!KEY_RE.test(key)) {
      throw new ValidationError(`Некорректный storage key: «${key}»`);
    }
    const abs = path.resolve(this.root, key);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (!abs.startsWith(rootWithSep)) {
      throw new ValidationError(`storage key вне хранилища: «${key}»`);
    }
    return abs;
  }
}

/** The relative storage key for a content hash: `sha256/<first2>/<full>`. */
export function keyFor(sha256: string): string {
  return `${KEY_PREFIX}/${sha256.slice(0, 2)}/${sha256}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
