import { capabilitiesOf } from "../capabilities";
import type { PrinterConfig } from "../config";
import { PRINTABLE_EXTENSIONS } from "./path";

/**
 * The **name a prepared file takes on the printer**.
 *
 * The queue used to hand the printer the artifact's own name (`cube.gcode`), and
 * the device slot is keyed by `(printerId, remotePath)`. Two unrelated tasks
 * whose models happen to share a name therefore collided on one slot: preparing
 * the second overwrote the first one's bytes on the device *and* re-pointed the
 * single tracked record, so the first assignment kept reporting `VERIFIED` for a
 * file that now held someone else's geometry. That is the "подмена файла с тем
 * же именем" failure, and it is not detectable after the fact — the name matched
 * and the size may well have too.
 *
 * The fix is to make the name carry the content identity: `<stem>-<sha8><ext>`.
 * Two files share a slot **iff** they share a content hash, in which case they
 * are the same bytes and sharing is correct. Everything else about the name is
 * defensive: the stem is sanitized to a conservative character set, cannot start
 * with a dot, and is truncated so the whole name fits the filesystem limit.
 *
 * Pure and total: given the same artifact it always returns the same name, which
 * is what makes "prepare" idempotent across restarts.
 */

/** Characters kept verbatim; everything else collapses to "_". */
const SAFE_CHAR = /[\p{L}\p{N}._-]/u;
/** How much of the content hash goes into the name (32 bits — collision-free in a farm). */
const HASH_CHARS = 8;
/** Bytes the stem may occupy; leaves room for "-<sha8>" + extension inside 200. */
const MAX_STEM_BYTES = 120;

export interface DeviceFileNameInput {
  /** The artifact's own file name (`cube.gcode`); may be dirty or empty. */
  name: string | null | undefined;
  /** The artifact's content hash — the identity the name encodes. */
  sha256: string | null | undefined;
}

/**
 * A safe, unique, deterministic on-device file name for an artifact.
 *
 * Returns a bare file name (never a path): callers that want a subdirectory
 * prepend it themselves and re-validate with `normalizeStartablePath`.
 */
export function buildDeviceFileName(
  input: DeviceFileNameInput,
  printer?: PrinterConfig | null
): string {
  const raw = (input.name ?? "").trim();
  // Only the base name matters — a caller-supplied "a/b/../c.gcode" contributes
  // nothing but its last segment, so traversal cannot survive into the result.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const stripped = stripKnownExtension(base, printer);
  const stem = sanitizeStem(stripped);
  const suffix = hashSuffix(input.sha256);
  // With a printer in scope the extension is the TARGET device's, not the
  // artifact's: the same sliced G-code becomes `x.gcode` on Klipper and
  // `x.gcode.3mf` on a Bambu, because that is the container each one starts.
  // Without one, the artifact's own declared extension is preserved (and only a
  // missing/unknown one defaults to `.gcode`), so a caller with no target device
  // still gets a startable, unsurprising name.
  const extension = printer
    ? capabilitiesOf(printer).deviceFileExtension
    : declaredExtension(base) ?? ".gcode";
  return `${truncateBytes(stem, MAX_STEM_BYTES)}${suffix}${extension}`;
}

/**
 * Whether `name` is the name {@link buildDeviceFileName} would produce for this
 * artifact. Used to tell "the operator picked their own path" from "the system
 * generated this one" without re-deriving naming rules at the call site.
 */
export function isGeneratedDeviceFileName(
  name: string,
  input: DeviceFileNameInput,
  printer?: PrinterConfig | null
): boolean {
  return (name.split("/").pop() ?? name) === buildDeviceFileName(input, printer);
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * `base` with any recognised printable extension removed.
 *
 * Both the default G-code set and the target adapter's own set are considered,
 * longest match first, so an artifact named `part.gcode` retargeted at a Bambu
 * becomes `part-<sha8>.gcode.3mf` rather than `part.gcode-<sha8>.gcode.3mf`.
 */
/** The printable extension `base` declares (lower-cased), or null when it declares none. */
function declaredExtension(base: string): string | null {
  const lower = base.toLowerCase();
  for (const ext of PRINTABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

function stripKnownExtension(base: string, printer?: PrinterConfig | null): string {
  const lower = base.toLowerCase();
  const known = [
    ...(printer ? capabilitiesOf(printer).startableExtensions : []),
    ...PRINTABLE_EXTENSIONS
  ].sort((a, b) => b.length - a.length);
  for (const ext of known) {
    if (lower.endsWith(ext)) return base.slice(0, base.length - ext.length);
  }
  return base;
}

/**
 * A conservative stem: unsafe characters collapse to "_", leading dots are
 * dropped (no hidden files, no "..", no name Moonraker's listing filters out),
 * and an empty result becomes "print" so the name is never just the hash.
 */
function sanitizeStem(stem: string): string {
  let out = "";
  let lastWasFiller = false;
  for (const char of stem) {
    if (SAFE_CHAR.test(char)) {
      out += char;
      lastWasFiller = false;
    } else if (!lastWasFiller) {
      out += "_";
      lastWasFiller = true;
    }
  }
  out = out.replace(/^[._-]+/, "").replace(/[._\-\s]+$/, "");
  return out || "print";
}

/** `-<first 8 hex>` of the content hash; "" when the artifact has no hash at all. */
function hashSuffix(sha256: string | null | undefined): string {
  const hex = (sha256 ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? `-${hex.slice(0, HASH_CHARS)}` : "";
}

/** Truncates on a character boundary so the UTF-8 byte length fits `limit`. */
function truncateBytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let out = "";
  for (const char of value) {
    if (Buffer.byteLength(out + char, "utf8") > limit) break;
    out += char;
  }
  return out || "print";
}
