import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import type { CameraFrame } from "../printers/camera";

/**
 * Durable metadata for one saved camera snapshot. The image bytes live as a
 * file under the snapshots directory; only this record is persisted in the JSON
 * state, so the state file stays small and its atomic write stays cheap.
 */
export interface SnapshotMeta {
  id: string;
  printerId: string;
  /** ISO-8601 capture time. */
  capturedAt: string;
  mime: string;
  bytes: number;
  /** File path relative to the snapshots directory (POSIX separators). */
  path: string;
  /** Printer/job state at capture time, when it was cheap to read; else null. */
  status: string | null;
  /** API path to fetch this snapshot's JPEG (relative to the orchestrator API). */
  url: string;
}

const DEFAULT_RETAIN_PER_PRINTER = 30;

function mimeToExt(mime: string): string {
  const normalized = mime.split(";")[0].trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  return "jpg";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Coerces an arbitrary parsed JSON value into a well-formed {@link SnapshotMeta},
 * or null when it is unusable. Tolerant like the rest of the state loader so a
 * hand-edited or partially-written file never crashes startup.
 */
export function normalizeSnapshotMeta(raw: unknown): SnapshotMeta | null {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const printerId = typeof raw.printerId === "string" ? raw.printerId : "";
  const capturedAt = typeof raw.capturedAt === "string" ? raw.capturedAt : "";
  const relPath = typeof raw.path === "string" ? raw.path : "";
  if (!id || !printerId || !capturedAt || !relPath) return null;

  return {
    id,
    printerId,
    capturedAt,
    mime: typeof raw.mime === "string" && raw.mime ? raw.mime : "image/jpeg",
    bytes:
      typeof raw.bytes === "number" && Number.isFinite(raw.bytes) && raw.bytes >= 0
        ? Math.floor(raw.bytes)
        : 0,
    path: relPath,
    status: typeof raw.status === "string" ? raw.status : null,
    url: typeof raw.url === "string" && raw.url ? raw.url : snapshotUrl(printerId, id)
  };
}

/** The stable API path a snapshot is served from. */
export function snapshotUrl(printerId: string, id: string): string {
  return `/api/printers/${encodeURIComponent(printerId)}/snapshots/${encodeURIComponent(id)}`;
}

/**
 * Long-term storage for camera snapshots. Image bytes are written as files under
 * {@link dir} (`<printerId>/<yyyy-mm-dd>/<id>.<ext>`); the metadata is held in
 * memory and persisted into the shared JSON state via {@link serialize}. Writes
 * are atomic (temp file + rename) and the metadata/event are only updated after
 * the file lands on disk, so a crash mid-write can never leave a dangling record.
 */
export class SnapshotStore {
  private metas: SnapshotMeta[];
  private readonly retainPerPrinter: number;

  constructor(
    private readonly dir: string,
    initial: SnapshotMeta[] = [],
    private readonly persist: () => void = () => {},
    options: { retainPerPrinter?: number } = {}
  ) {
    this.metas = [...initial];
    this.retainPerPrinter = Math.max(1, options.retainPerPrinter ?? DEFAULT_RETAIN_PER_PRINTER);
  }

  /** The persisted metadata slice, newest last (insertion order). */
  serialize(): SnapshotMeta[] {
    return [...this.metas];
  }

  /** All snapshots for a printer, newest first. */
  list(printerId: string): SnapshotMeta[] {
    return this.metas
      .filter((m) => m.printerId === printerId)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  /** The most recent snapshot for a printer, or undefined when there are none. */
  latest(printerId: string): SnapshotMeta | undefined {
    return this.list(printerId)[0];
  }

  /** One snapshot's metadata by id (scoped to its printer), or undefined. */
  get(printerId: string, id: string): SnapshotMeta | undefined {
    return this.metas.find((m) => m.printerId === printerId && m.id === id);
  }

  /** Absolute on-disk path for a snapshot's image file. */
  resolveFile(meta: SnapshotMeta): string {
    return path.resolve(this.dir, meta.path);
  }

  /** Reads a snapshot's image bytes from disk. */
  read(meta: SnapshotMeta): Promise<Buffer> {
    return fsp.readFile(this.resolveFile(meta));
  }

  /**
   * Persists a fresh camera frame as a snapshot: writes the image atomically,
   * then records and prunes the metadata. Returns the new record. Throws (before
   * any metadata is recorded) if the file cannot be written, so the caller's
   * event/feed side effects only happen on a real, saved image.
   */
  async save(
    printerId: string,
    frame: CameraFrame,
    options: { status?: string | null; now?: Date } = {}
  ): Promise<SnapshotMeta> {
    const now = options.now ?? new Date();
    const iso = now.toISOString();
    const day = iso.slice(0, 10); // yyyy-mm-dd
    const id = `${now.getTime()}-${randomBytes(4).toString("hex")}`;
    const ext = mimeToExt(frame.mime);
    const relPath = path.posix.join(printerId, day, `${id}.${ext}`);
    const abs = path.resolve(this.dir, relPath);

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, frame.data);
    await fsp.rename(tmp, abs);

    const meta: SnapshotMeta = {
      id,
      printerId,
      capturedAt: iso,
      mime: frame.mime.split(";")[0].trim().toLowerCase() || "image/jpeg",
      bytes: frame.data.byteLength,
      path: relPath,
      status: options.status ?? null,
      url: snapshotUrl(printerId, id)
    };

    this.metas.push(meta);
    await this.prune(printerId);
    this.persist();
    return meta;
  }

  /** Keeps only the newest {@link retainPerPrinter} snapshots per printer, deleting the rest. */
  private async prune(printerId: string): Promise<void> {
    const forPrinter = this.list(printerId); // newest first
    const stale = forPrinter.slice(this.retainPerPrinter);
    if (stale.length === 0) return;

    const staleIds = new Set(stale.map((m) => m.id));
    this.metas = this.metas.filter((m) => !(m.printerId === printerId && staleIds.has(m.id)));

    await Promise.all(
      stale.map((m) => fsp.rm(this.resolveFile(m), { force: true }).catch(() => undefined))
    );
  }
}
