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
 * ## ZIP64
 *
 * ZIP64 is **read normally**, not refused. Refusing it was a real bug: miniz —
 * the writer inside PrusaSlicer / OrcaSlicer / BambuStudio — emits a ZIP64
 * end-of-central-directory record with `0xFFFFFFFF` sentinels in the classic
 * headers regardless of size, so perfectly ordinary 150 KB `.3mf` files (every
 * OrcaSlicer calibration model, for instance) are ZIP64 archives. "ZIP64" says
 * nothing about how big or how hostile an archive is; it is just a header
 * layout. The bomb defence lives entirely in the {@link ZipLimits} — which are
 * applied to the resolved 64-bit sizes exactly as they were to the 32-bit ones —
 * so reading ZIP64 widens the format support without widening the attack
 * surface. What IS still refused: encrypted entries, multi-disk/spanned
 * archives, and any 64-bit value beyond `Number.MAX_SAFE_INTEGER`.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
/** A 32-bit field set to this defers to the ZIP64 record / extra field. */
const ZIP64_SENTINEL = 0xffffffff;
/** The 16-bit equivalent (entry count, disk number). */
const ZIP64_SENTINEL_16 = 0xffff;
/** Header id of the "ZIP64 extended information" extra field. */
const ZIP64_EXTRA_ID = 0x0001;
const EOCD_SIZE = 22;
const ZIP64_EOCD_MIN_SIZE = 56;
const ZIP64_LOCATOR_SIZE = 20;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
/**
 * Hard cap on the central directory read into memory at once. Generous for a
 * legitimate package (≈46 B + path per entry) but bounded, so a declared
 * multi-hundred-megabyte directory cannot be allocated on our word alone.
 */
const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * Operator-facing next steps. A refusal is only useful if it says what to do,
 * and the three refusal *classes* call for three different answers: the archive
 * carries something a 3MF never should (→ not a file to fix, get a clean one),
 * it is honestly too big (→ make it smaller), or it is damaged (→ re-export).
 */
const HINT_SUSPICIOUS =
  "Внутри архива есть путь или запись, которых не бывает в 3MF. Файл не принят из соображений безопасности — возьмите исходник из слайсера.";
const HINT_TOO_BIG =
  "В распакованном виде файл выходит за допустимый размер. Уменьшите модель, снизьте детализацию или разделите проект на несколько файлов.";
const HINT_MULTI_DISK = "Соберите файл в один архив — многотомные ZIP не читаются.";

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
    readonly code: string,
    /** Operator-facing next step, when there is a meaningful one. */
    readonly hint?: string
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
      const start = Math.max(0, Math.min(offset, buf.length));
      return buf.subarray(start, Math.max(start, Math.min(start + length, buf.length)));
    }
  };
}

export function fileHandleSource(handle: FileHandle, size: number): RandomAccessSource {
  return {
    size,
    async read(offset: number, length: number): Promise<Buffer> {
      if (length <= 0 || offset < 0 || offset >= size) return Buffer.alloc(0);
      const want = Math.min(length, size - offset);
      const out = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(out, 0, want, offset);
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
    if (eocd.entryCount > limits.maxEntries) {
      throw new ZipSafetyError(
        `Слишком много файлов в архиве: ${eocd.entryCount} > ${limits.maxEntries}`,
        "zip_too_many_entries",
        HINT_TOO_BIG
      );
    }
    if (eocd.cdSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new ZipSafetyError(
        `Оглавление архива неправдоподобно велико (${eocd.cdSize} Б)`,
        "zip_corrupt"
      );
    }
    if (eocd.cdOffset + eocd.cdSize > source.size) {
      throw new ZipSafetyError("Повреждённый центральный каталог ZIP", "zip_corrupt");
    }

    const cd = await source.read(eocd.cdOffset, eocd.cdSize);
    if (cd.length < eocd.cdSize) {
      throw new ZipSafetyError("Центральный каталог ZIP обрывается", "zip_corrupt");
    }

    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let total = 0;
    let offset = 0;

    for (let i = 0; i < eocd.entryCount; i++) {
      const parsed = parseCentralEntry(cd, offset);
      total = assertEntrySafe(parsed.entry, { seen, total, limits, archiveSize: source.size });
      entries.push(parsed.entry);
      offset = parsed.next;
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
   * Resolves a part name case-insensitively and returns the archive's actual
   * spelling. OPC part names are compared case-insensitively by the packaging
   * spec, and writers do differ (`3D/3dmodel.model` vs `3D/3Dmodel.model`), so a
   * case-exact lookup would misjudge a valid package as "not a 3MF".
   */
  resolve(name: string): string | null {
    const wanted = name.toLowerCase();
    return this.entries.find((e) => !e.isDirectory && e.name.toLowerCase() === wanted)?.name ?? null;
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

    const local = await this.source.read(entry.localHeaderOffset, LOCAL_HEADER_SIZE);
    if (local.length < LOCAL_HEADER_SIZE || local.readUInt32LE(0) !== SIG_LOCAL) {
      throw new ZipSafetyError(`Повреждённый локальный заголовок «${name}»`, "zip_corrupt");
    }
    const nameLen = local.readUInt16LE(26);
    const extraLen = local.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + LOCAL_HEADER_SIZE + nameLen + extraLen;
    if (dataOffset + entry.compressedSize > this.source.size) {
      throw new ZipSafetyError(`Данные записи «${name}» выходят за пределы файла`, "zip_corrupt");
    }
    const compressed = await this.source.read(dataOffset, entry.compressedSize);
    if (compressed.length < entry.compressedSize) {
      throw new ZipSafetyError(`Данные записи «${name}» обрываются`, "zip_corrupt");
    }

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
      "zip_method",
      "Пересохраните файл в слайсере — он использует необычное сжатие внутри архива."
    );
  }
}

// ── Central directory ────────────────────────────────────────────────────────

/** Parses one central-directory record (resolving ZIP64 fields) at `offset`. */
function parseCentralEntry(cd: Buffer, offset: number): { entry: ZipEntry; next: number } {
  if (offset + CENTRAL_HEADER_SIZE > cd.length || cd.readUInt32LE(offset) !== SIG_CENTRAL) {
    throw new ZipSafetyError("Повреждённый заголовок в каталоге ZIP", "zip_corrupt");
  }
  const flags = cd.readUInt16LE(offset + 8);
  const method = cd.readUInt16LE(offset + 10);
  const nameLen = cd.readUInt16LE(offset + 28);
  const extraLen = cd.readUInt16LE(offset + 30);
  const commentLen = cd.readUInt16LE(offset + 32);
  const diskStart = cd.readUInt16LE(offset + 34);
  const externalAttrs = cd.readUInt32LE(offset + 38);
  const next = offset + CENTRAL_HEADER_SIZE + nameLen + extraLen + commentLen;
  if (next > cd.length) {
    throw new ZipSafetyError("Запись каталога ZIP выходит за его пределы", "zip_corrupt");
  }

  const name = cd.toString("utf8", offset + CENTRAL_HEADER_SIZE, offset + CENTRAL_HEADER_SIZE + nameLen);
  if (flags & FLAG_ENCRYPTED) {
    throw new ZipSafetyError(
      `Зашифрованная запись в архиве: «${name}»`,
      "zip_encrypted",
      "Сохраните файл без пароля — зашифрованные архивы не читаются."
    );
  }

  const extra = cd.subarray(
    offset + CENTRAL_HEADER_SIZE + nameLen,
    offset + CENTRAL_HEADER_SIZE + nameLen + extraLen
  );
  const sizes = resolveZip64Sizes(
    {
      compressedSize: cd.readUInt32LE(offset + 20),
      uncompressedSize: cd.readUInt32LE(offset + 24),
      localHeaderOffset: cd.readUInt32LE(offset + 42),
      diskStart
    },
    extra,
    name
  );

  const unixMode = (externalAttrs >>> 16) & 0xffff;
  if ((unixMode & S_IFMT) === S_IFLNK) {
    throw new ZipSafetyError(`Символьная ссылка в архиве: «${name}»`, "zip_symlink", HINT_SUSPICIOUS);
  }
  if (sizes.diskStart !== 0) {
    throw new ZipSafetyError(
      `Запись «${name}» лежит на другом томе многотомного архива`,
      "zip_multi_disk",
      HINT_MULTI_DISK
    );
  }
  assertSafeName(name);

  return {
    entry: {
      name,
      method,
      compressedSize: sizes.compressedSize,
      uncompressedSize: sizes.uncompressedSize,
      localHeaderOffset: sizes.localHeaderOffset,
      isDirectory: name.endsWith("/")
    },
    next
  };
}

interface EntryContext {
  seen: Set<string>;
  total: number;
  limits: ZipLimits;
  archiveSize: number;
}

/** Applies the bomb/duplicate/bounds guards to one entry; returns the new total. */
function assertEntrySafe(entry: ZipEntry, ctx: EntryContext): number {
  const { seen, limits } = ctx;
  if (entry.localHeaderOffset + LOCAL_HEADER_SIZE > ctx.archiveSize) {
    throw new ZipSafetyError(
      `Запись «${entry.name}» указывает за пределы файла`,
      "zip_corrupt"
    );
  }
  if (entry.isDirectory) return ctx.total;

  if (seen.has(entry.name)) {
    throw new ZipSafetyError(`Дублирующийся путь в архиве: «${entry.name}»`, "zip_duplicate");
  }
  seen.add(entry.name);

  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw new ZipSafetyError(
      `Запись «${entry.name}» распаковывается в ${entry.uncompressedSize} Б (лимит ${limits.maxEntryBytes})`,
      "zip_entry_too_large",
      HINT_TOO_BIG
    );
  }
  const total = ctx.total + entry.uncompressedSize;
  if (total > limits.maxTotalBytes) {
    throw new ZipSafetyError(
      `Суммарный распакованный размер превышает ${limits.maxTotalBytes} Б`,
      "zip_total_too_large",
      HINT_TOO_BIG
    );
  }
  // Ratio bomb: only meaningful once an entry is non-trivial, so a tiny
  // highly-compressible file does not trip it.
  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize > 64 * 1024 &&
    entry.uncompressedSize / entry.compressedSize > limits.maxRatio
  ) {
    throw new ZipSafetyError(
      `Подозрительный коэффициент сжатия у «${entry.name}» (${Math.round(
        entry.uncompressedSize / entry.compressedSize
      )}:1)`,
      "zip_ratio",
      HINT_SUSPICIOUS
    );
  }
  return total;
}

interface CentralSizes {
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  diskStart: number;
}

/**
 * Replaces every `0xFFFFFFFF`/`0xFFFF` sentinel with the 64-bit value from the
 * ZIP64 extended-information extra field (header id `0x0001`). Per APPNOTE the
 * field carries **only** the members that were sentinelled, in the fixed order
 * uncompressed → compressed → local-header-offset → disk, so the read position
 * advances conditionally.
 */
function resolveZip64Sizes(raw: CentralSizes, extra: Buffer, name: string): CentralSizes {
  const needsUncompressed = raw.uncompressedSize === ZIP64_SENTINEL;
  const needsCompressed = raw.compressedSize === ZIP64_SENTINEL;
  const needsOffset = raw.localHeaderOffset === ZIP64_SENTINEL;
  const needsDisk = raw.diskStart === ZIP64_SENTINEL_16;
  if (!needsUncompressed && !needsCompressed && !needsOffset && !needsDisk) return raw;

  const field = findExtraField(extra, ZIP64_EXTRA_ID);
  if (!field) {
    throw new ZipSafetyError(
      `Запись «${name}»: отсутствует ZIP64-описание размеров`,
      "zip_corrupt"
    );
  }

  const out = { ...raw };
  let p = 0;
  const take = (what: string): number => {
    if (p + 8 > field.length) {
      throw new ZipSafetyError(`Запись «${name}»: обрезанное ZIP64-поле (${what})`, "zip_corrupt");
    }
    const value = field.readBigUInt64LE(p);
    p += 8;
    if (value > MAX_SAFE) {
      throw new ZipSafetyError(
        `Запись «${name}»: недопустимо большое значение ZIP64 (${what})`,
        "zip_entry_too_large",
        HINT_TOO_BIG
      );
    }
    return Number(value);
  };

  if (needsUncompressed) out.uncompressedSize = take("распакованный размер");
  if (needsCompressed) out.compressedSize = take("сжатый размер");
  if (needsOffset) out.localHeaderOffset = take("смещение записи");
  if (needsDisk) {
    if (p + 4 > field.length) {
      throw new ZipSafetyError(`Запись «${name}»: обрезанное ZIP64-поле (том)`, "zip_corrupt");
    }
    out.diskStart = field.readUInt32LE(p);
  }
  return out;
}

/** Walks the `id(2) size(2) data` extra-field TLVs, bounded, and returns one payload. */
function findExtraField(extra: Buffer, wantedId: number): Buffer | null {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (p + 4 + size > extra.length) return null; // truncated → treat as absent
    if (id === wantedId) return extra.subarray(p + 4, p + 4 + size);
    p += 4 + size;
  }
  return null;
}

/** Rejects traversal, absolute, backslash and null-byte entry names. */
function assertSafeName(name: string): void {
  if (name.length === 0) {
    throw new ZipSafetyError("Пустое имя записи в архиве", "zip_bad_name", HINT_SUSPICIOUS);
  }
  if (name.includes("\0")) {
    throw new ZipSafetyError("Нулевой байт в имени записи", "zip_bad_name", HINT_SUSPICIOUS);
  }
  if (name.includes("\\")) {
    throw new ZipSafetyError(`Обратный слэш в имени записи: «${name}»`, "zip_bad_name", HINT_SUSPICIOUS);
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new ZipSafetyError(`Абсолютный путь в архиве: «${name}»`, "zip_absolute_path", HINT_SUSPICIOUS);
  }
  const segments = name.split("/");
  if (segments.some((seg) => seg === "..")) {
    throw new ZipSafetyError(`Выход за пределы каталога (path traversal): «${name}»`, "zip_traversal", HINT_SUSPICIOUS);
  }
}

// ── End of central directory (classic + ZIP64) ───────────────────────────────

interface EocdInfo {
  entryCount: number;
  cdSize: number;
  cdOffset: number;
  /** True when the archive's directory was located through the ZIP64 record. */
  zip64: boolean;
}

/**
 * Scans the archive tail for the End-Of-Central-Directory record, then — when
 * the ZIP64 locator sits directly in front of it — follows that to the ZIP64
 * EOCD record for the authoritative 64-bit counts and offsets.
 */
async function findEocd(source: RandomAccessSource): Promise<EocdInfo> {
  const maxTail = Math.min(source.size, EOCD_SIZE + 0xffff); // EOCD + max comment
  if (maxTail < EOCD_SIZE) {
    throw new ZipSafetyError("Файл слишком мал для ZIP-архива", "zip_corrupt");
  }
  const tailStart = source.size - maxTail;
  const tail = await source.read(tailStart, maxTail);

  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    // A true EOCD ends the file: its comment must run exactly to EOF. Without
    // this check, `PK\x05\x06` bytes inside compressed data can be mistaken for
    // the record and send the reader to a nonsense offset.
    if (i + EOCD_SIZE + tail.readUInt16LE(i + 20) !== tail.length) continue;

    if (tail.readUInt16LE(i + 4) !== 0 || tail.readUInt16LE(i + 6) !== 0) {
      throw new ZipSafetyError(
        "Многотомный ZIP-архив не поддерживается",
        "zip_multi_disk",
        HINT_MULTI_DISK
      );
    }

    const classic = {
      entryCount: tail.readUInt16LE(i + 10),
      cdSize: tail.readUInt32LE(i + 12),
      cdOffset: tail.readUInt32LE(i + 16)
    };
    const zip64 = await readZip64Eocd(source, tail, tailStart, i);
    if (zip64) return { ...zip64, zip64: true };

    // Sentinels with no ZIP64 record to resolve them is a broken archive, not a
    // format we decline — say so as corruption rather than as "unsupported".
    if (
      classic.cdOffset === ZIP64_SENTINEL ||
      classic.cdSize === ZIP64_SENTINEL ||
      classic.entryCount === ZIP64_SENTINEL_16
    ) {
      throw new ZipSafetyError(
        "Архив помечен как ZIP64, но не содержит ZIP64-оглавления",
        "zip_corrupt"
      );
    }
    return { ...classic, zip64: false };
  }
  throw new ZipSafetyError("Не найден каталог ZIP (не ZIP-файл?)", "zip_not_zip");
}

/**
 * Follows the ZIP64 end-of-central-directory **locator** (which, when present,
 * sits in the 20 bytes immediately before the classic EOCD) to the ZIP64 EOCD
 * record and returns its 64-bit directory description. `null` when there is no
 * locator — i.e. an ordinary 32-bit archive.
 */
async function readZip64Eocd(
  source: RandomAccessSource,
  tail: Buffer,
  tailStart: number,
  eocdIndex: number
): Promise<{ entryCount: number; cdSize: number; cdOffset: number } | null> {
  const locatorIndex = eocdIndex - ZIP64_LOCATOR_SIZE;
  if (locatorIndex < 0 || tail.readUInt32LE(locatorIndex) !== SIG_ZIP64_LOCATOR) return null;

  if (tail.readUInt32LE(locatorIndex + 4) !== 0 || tail.readUInt32LE(locatorIndex + 16) > 1) {
    throw new ZipSafetyError(
      "Многотомный ZIP-архив не поддерживается",
      "zip_multi_disk",
      HINT_MULTI_DISK
    );
  }

  const recordOffset = readU64(tail, locatorIndex + 8, "смещение ZIP64-оглавления");
  if (recordOffset + ZIP64_EOCD_MIN_SIZE > source.size) {
    throw new ZipSafetyError("ZIP64-оглавление указывает за пределы файла", "zip_corrupt");
  }
  // A locator inside the tail we already hold is served from it; otherwise read.
  const local = recordOffset - tailStart;
  const record =
    local >= 0 && local + ZIP64_EOCD_MIN_SIZE <= tail.length
      ? tail.subarray(local, local + ZIP64_EOCD_MIN_SIZE)
      : await source.read(recordOffset, ZIP64_EOCD_MIN_SIZE);

  if (record.length < ZIP64_EOCD_MIN_SIZE || record.readUInt32LE(0) !== SIG_ZIP64_EOCD) {
    throw new ZipSafetyError("Повреждённое ZIP64-оглавление", "zip_corrupt");
  }
  if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
    throw new ZipSafetyError(
      "Многотомный ZIP-архив не поддерживается",
      "zip_multi_disk",
      HINT_MULTI_DISK
    );
  }

  return {
    entryCount: readU64(record, 32, "число записей"),
    cdSize: readU64(record, 40, "размер оглавления"),
    cdOffset: readU64(record, 48, "смещение оглавления")
  };
}

/** Reads a 64-bit little-endian field, refusing anything past `Number.MAX_SAFE_INTEGER`. */
function readU64(buf: Buffer, offset: number, what: string): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > MAX_SAFE) {
    throw new ZipSafetyError(`Недопустимо большое значение ZIP64 (${what})`, "zip_corrupt");
  }
  return Number(value);
}
