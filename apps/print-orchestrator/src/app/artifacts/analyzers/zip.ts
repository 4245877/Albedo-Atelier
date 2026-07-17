import type { FileHandle } from "node:fs/promises";
import zlib from "node:zlib";
import { promisify } from "node:util";

const inflateRaw = promisify(zlib.inflateRaw);

/**
 * A deliberately small, defensive ZIP central-directory reader built on Node's
 * own `zlib` — no third-party unzip library, so every ZIP-bomb / path-traversal
 * / symlink guard the brief asks for is enforced here, in code we control,
 * rather than trusted to a dependency's defaults.
 *
 * A `.3mf` is an untrusted ZIP. The reader:
 *   - reads only the End-Of-Central-Directory tail and the central directory
 *     (never the whole archive) via random access, so a huge upload is not
 *     slurped into memory to be inspected;
 *   - validates every entry from the *central directory* declarations **before**
 *     inflating anything — entry count, per-entry and total uncompressed size,
 *     and the compression ratio (the classic bomb signal);
 *   - rejects path traversal, absolute paths, backslashes, duplicate names and
 *     symlink entries (unix mode `S_IFLNK` in the external attributes);
 *   - inflates a single named entry on demand with a hard `maxOutputLength`
 *     cap, so even a mis-declared entry cannot expand without bound.
 *
 * ZIP64 and encrypted entries are refused rather than half-supported: a benign
 * 3MF never needs them, and pretending to handle them is where bomb defenses
 * usually leak.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_SENTINEL = 0xffffffff;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export interface ZipLimits {
  /** Maximum number of entries in the archive. */
  maxEntries: number;
  /** Maximum declared uncompressed size of any single entry. */
  maxEntryBytes: number;
  /** Maximum sum of declared uncompressed sizes across all entries. */
  maxTotalBytes: number;
  /** Maximum uncompressed/compressed ratio before an entry reads as a bomb. */
  maxRatio: number;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

/** A structured, machine-branchable ZIP-safety failure (→ analysis blocker). */
export class ZipSafetyError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "ZipSafetyError";
  }
}

/** Random-access byte source — a file handle in production, a Buffer in tests. */
export interface RandomAccessSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export function bufferSource(buf: Buffer): RandomAccessSource {
  return {
    size: buf.length,
    async read(offset: number, length: number): Promise<Buffer> {
      return buf.subarray(offset, offset + length);
    }
  };
}

export function fileHandleSource(handle: FileHandle, size: number): RandomAccessSource {
  return {
    size,
    async read(offset: number, length: number): Promise<Buffer> {
      const out = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(out, 0, length, offset);
      return out.subarray(0, bytesRead);
    }
  };
}

export class SafeZip {
  private constructor(
    private readonly source: RandomAccessSource,
    readonly entries: ZipEntry[]
  ) {}

  /**
   * Reads and validates the central directory. Throws {@link ZipSafetyError} on
   * any structural or bomb signal; a returned instance is safe to inspect.
   */
  static async open(source: RandomAccessSource, limits: ZipLimits): Promise<SafeZip> {
    const eocd = await findEocd(source);
    if (eocd.zip64) {
      throw new ZipSafetyError("ZIP64-архивы не поддерживаются", "zip_zip64");
    }
    if (eocd.entryCount > limits.maxEntries) {
      throw new ZipSafetyError(
        `Слишком много файлов в архиве: ${eocd.entryCount} > ${limits.maxEntries}`,
        "zip_too_many_entries"
      );
    }
    if (eocd.cdOffset + eocd.cdSize > source.size) {
      throw new ZipSafetyError("Повреждённый центральный каталог ZIP", "zip_corrupt");
    }

    const cd = await source.read(eocd.cdOffset, eocd.cdSize);
    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let total = 0;
    let offset = 0;

    for (let i = 0; i < eocd.entryCount; i++) {
      if (offset + 46 > cd.length || cd.readUInt32LE(offset) !== SIG_CENTRAL) {
        throw new ZipSafetyError("Повреждённый заголовок в каталоге ZIP", "zip_corrupt");
      }
      const flags = cd.readUInt16LE(offset + 8);
      const method = cd.readUInt16LE(offset + 10);
      const compressedSize = cd.readUInt32LE(offset + 20);
      const uncompressedSize = cd.readUInt32LE(offset + 24);
      const nameLen = cd.readUInt16LE(offset + 28);
      const extraLen = cd.readUInt16LE(offset + 30);
      const commentLen = cd.readUInt16LE(offset + 32);
      const externalAttrs = cd.readUInt32LE(offset + 38);
      const localHeaderOffset = cd.readUInt32LE(offset + 42);
      const nameBuf = cd.subarray(offset + 46, offset + 46 + nameLen);
      const name = nameBuf.toString("utf8");

      if (flags & FLAG_ENCRYPTED) {
        throw new ZipSafetyError(`Зашифрованная запись в архиве: «${name}»`, "zip_encrypted");
      }
      if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
        throw new ZipSafetyError("ZIP64-размеры не поддерживаются", "zip_zip64");
      }

      const unixMode = (externalAttrs >>> 16) & 0xffff;
      if ((unixMode & S_IFMT) === S_IFLNK) {
        throw new ZipSafetyError(`Символьная ссылка в архиве: «${name}»`, "zip_symlink");
      }

      assertSafeName(name);
      const isDirectory = name.endsWith("/");

      if (!isDirectory) {
        if (seen.has(name)) {
          throw new ZipSafetyError(`Дублирующийся путь в архиве: «${name}»`, "zip_duplicate");
        }
        seen.add(name);

        if (uncompressedSize > limits.maxEntryBytes) {
          throw new ZipSafetyError(
            `Запись «${name}» распаковывается в ${uncompressedSize} Б (лимит ${limits.maxEntryBytes})`,
            "zip_entry_too_large"
          );
        }
        total += uncompressedSize;
        if (total > limits.maxTotalBytes) {
          throw new ZipSafetyError(
            `Суммарный распакованный размер превышает ${limits.maxTotalBytes} Б`,
            "zip_total_too_large"
          );
        }
        // Ratio bomb: only meaningful once an entry is non-trivial, so a tiny
        // highly-compressible file does not trip it.
        if (
          compressedSize > 0 &&
          uncompressedSize > 64 * 1024 &&
          uncompressedSize / compressedSize > limits.maxRatio
        ) {
          throw new ZipSafetyError(
            `Подозрительный коэффициент сжатия у «${name}» (${Math.round(
              uncompressedSize / compressedSize
            )}:1)`,
            "zip_ratio"
          );
        }
      }

      entries.push({
        name,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        isDirectory
      });
      offset += 46 + nameLen + extraLen + commentLen;
    }

    return new SafeZip(source, entries);
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name && !e.isDirectory);
  }

  find(predicate: (name: string) => boolean): ZipEntry | undefined {
    return this.entries.find((e) => !e.isDirectory && predicate(e.name));
  }

  /**
   * Inflates one named entry, hard-capping the decompressed output at
   * `min(maxBytes, entry.uncompressedSize)` so a mis-declared entry still cannot
   * expand past the cap. Reads the entry's bytes via the local header (the
   * authoritative data location), not by trusting the central-directory offset
   * blindly.
   */
  async read(name: string, maxBytes: number): Promise<Buffer> {
    const entry = this.entries.find((e) => e.name === name && !e.isDirectory);
    if (!entry) throw new ZipSafetyError(`Записи «${name}» нет в архиве`, "zip_missing_entry");

    const cap = Math.min(maxBytes, entry.uncompressedSize || maxBytes);
    if (entry.uncompressedSize > maxBytes) {
      throw new ZipSafetyError(
        `Запись «${name}» слишком большая для разбора (${entry.uncompressedSize} Б)`,
        "zip_entry_too_large"
      );
    }

    const local = await this.source.read(entry.localHeaderOffset, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== SIG_LOCAL) {
      throw new ZipSafetyError(`Повреждённый локальный заголовок «${name}»`, "zip_corrupt");
    }
    const nameLen = local.readUInt16LE(26);
    const extraLen = local.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;
    const compressed = await this.source.read(dataOffset, entry.compressedSize);

    if (entry.method === METHOD_STORE) {
      return compressed.subarray(0, cap);
    }
    if (entry.method === METHOD_DEFLATE) {
      try {
        return await inflateRaw(compressed, { maxOutputLength: cap });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          throw new ZipSafetyError(
            `Запись «${name}» распаковывается больше лимита ${cap} Б`,
            "zip_entry_too_large"
          );
        }
        throw new ZipSafetyError(`Не удалось распаковать «${name}»`, "zip_inflate_failed");
      }
    }
    throw new ZipSafetyError(
      `Неподдерживаемый метод сжатия ${entry.method} у «${name}»`,
      "zip_method"
    );
  }
}

/** Rejects traversal, absolute, backslash and null-byte entry names. */
function assertSafeName(name: string): void {
  if (name.length === 0) {
    throw new ZipSafetyError("Пустое имя записи в архиве", "zip_bad_name");
  }
  if (name.includes("\0")) {
    throw new ZipSafetyError("Нулевой байт в имени записи", "zip_bad_name");
  }
  if (name.includes("\\")) {
    throw new ZipSafetyError(`Обратный слэш в имени записи: «${name}»`, "zip_bad_name");
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new ZipSafetyError(`Абсолютный путь в архиве: «${name}»`, "zip_absolute_path");
  }
  const segments = name.split("/");
  if (segments.some((seg) => seg === "..")) {
    throw new ZipSafetyError(`Выход за пределы каталога (path traversal): «${name}»`, "zip_traversal");
  }
}

interface EocdInfo {
  entryCount: number;
  cdSize: number;
  cdOffset: number;
  zip64: boolean;
}

/** Scans the archive tail for the End-Of-Central-Directory record. */
async function findEocd(source: RandomAccessSource): Promise<EocdInfo> {
  const maxTail = Math.min(source.size, 22 + 0xffff); // EOCD + max comment
  if (maxTail < 22) {
    throw new ZipSafetyError("Файл слишком мал для ZIP-архива", "zip_corrupt");
  }
  const tail = await source.read(source.size - maxTail, maxTail);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      const entryCount = tail.readUInt16LE(i + 10);
      const cdSize = tail.readUInt32LE(i + 12);
      const cdOffset = tail.readUInt32LE(i + 16);
      const zip64 =
        cdOffset === ZIP64_SENTINEL ||
        cdSize === ZIP64_SENTINEL ||
        entryCount === 0xffff ||
        hasZip64Locator(tail, i);
      return { entryCount, cdSize, cdOffset, zip64 };
    }
  }
  throw new ZipSafetyError("Не найден каталог ZIP (не ZIP-файл?)", "zip_not_zip");
}

function hasZip64Locator(tail: Buffer, eocdIndex: number): boolean {
  const locatorIndex = eocdIndex - 20;
  return locatorIndex >= 0 && tail.readUInt32LE(locatorIndex) === SIG_ZIP64_LOCATOR;
}
