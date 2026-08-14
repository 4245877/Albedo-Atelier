import fs from "node:fs";
import path from "node:path";

import { declaredType, type OrcaSettings } from "../../domain/slicing/orcaProfile";
import type { ProfileType } from "../../domain/slicing/types";

/**
 * The vendor-scoped index of OrcaSlicer **system** profiles — the inheritance
 * parents user presets are built on.
 *
 * Those parents are not part of an exported `.orca_printer` bundle: they live in
 * OrcaSlicer's own `resources/profiles/<Vendor>/{machine,process,filament}/…`, and
 * the deployment gets them from one or both of
 *
 *   1. `config/slicers/orca/vendor/` — operator-installed copies that ship inside
 *      the image (so a lean container with no OrcaSlicer mount still resolves), and
 *   2. the pinned slicer's own `resources/profiles` tree, when a runtime is mounted
 *      (`ORCA_SYSTEM_PROFILES_DIR`, derived from `ORCA_SLICER_CMD` by default) —
 *      the same bytes the CLI itself would use, so resolution cannot drift from it.
 *
 * Two properties this module exists to guarantee:
 *
 * **Vendor scoping.** A profile *name* is only unique within a vendor — the shipped
 * tree has 46 files named `fdm_machine_common`. Every entry therefore records the
 * vendor folder it came from, and {@link SystemProfileIndex.lookup} returns all of
 * them so the resolver can lock onto one vendor (or report the ambiguity) instead
 * of silently merging another brand's base settings into a Bambu profile.
 *
 * **Cost.** The tree is ~5.4k files / 56 MB. Building the index reads each file once
 * to learn its `name` (a targeted scan, no JSON object graph) and keeps only
 * `name → {vendor, file}`; the handful of profiles a chain actually needs are parsed
 * lazily on lookup and cached. Vendor manifests (`BBL.json`) and `machine_model`
 * definitions are skipped — they are not presets and must never enter the
 * resolution universe.
 */

/** A system profile located by the index, parsed on demand. */
export interface SystemProfile {
  type: ProfileType;
  name: string;
  inherits: string | null;
  settings: OrcaSettings;
  /** Vendor folder (`"BBL"`); null for a flat, unscoped operator file in `vendor/`. */
  vendor: string | null;
  /** Absolute path, for diagnostics. */
  file: string;
}

interface IndexEntry {
  name: string;
  vendor: string | null;
  file: string;
  /** Directory-implied type (`…/machine/x.json`), used when the file declares none. */
  dirType: ProfileType | null;
}

/** Matches the top-level `"name": "…"` of an Orca profile without parsing the file. */
const NAME_RE = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/** Keys that mark a vendor *manifest* (`BBL.json`) rather than a preset. */
const MANIFEST_KEYS = ["machine_model_list", "machine_list", "process_list", "filament_list"];

function firstString(value: unknown): string | null {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

/** Maps an OrcaSlicer profile directory name onto a profile type. */
function typeOfDir(dir: string): ProfileType | null {
  const d = dir.toLowerCase();
  if (d === "machine" || d === "printer") return "machine";
  if (d === "process" || d === "print") return "process";
  if (d === "filament") return "filament";
  return null;
}

/**
 * The type of a system profile file: its own `type` first, then the directory it
 * sits in, then a payload guess. Returns null for anything that is not one of the
 * three preset kinds — notably `machine_model` definitions, which carry a printer's
 * marketing name (`"Bambu Lab A1"`) and would otherwise pollute the name index.
 */
export function systemProfileType(settings: OrcaSettings, dirType: ProfileType | null): ProfileType | null {
  const declared = declaredType(settings);
  if (declared) return declared;
  // An explicit but non-preset `type` (machine_model, …) is a deliberate skip.
  if (firstString(settings.type)) return null;
  if (dirType) return dirType;
  if ("printer_model" in settings || "printable_area" in settings || "printer_technology" in settings) {
    return "machine";
  }
  if ("filament_type" in settings || "filament_settings_id" in settings) return "filament";
  if ("layer_height" in settings || "print_settings_id" in settings) return "process";
  return null;
}

/** True for a vendor bundle manifest (`BBL.json`) — a catalogue, not a preset. */
export function isVendorManifest(settings: OrcaSettings): boolean {
  return MANIFEST_KEYS.some((k) => Array.isArray(settings[k]));
}

export class SystemProfileIndex {
  /** name → every file shipping that name (across roots and vendors). */
  private readonly byName = new Map<string, IndexEntry[]>();
  private readonly parsed = new Map<string, SystemProfile | null>();

  private constructor(readonly roots: readonly string[]) {}

  /**
   * Scans `roots` in order and indexes every `.json` profile by name. Earlier roots
   * win a (vendor, name) collision, so an operator's `vendor/` copy takes precedence
   * over the same profile in the mounted slicer tree. A missing root is not an
   * error — deployments legitimately have only one of the two.
   */
  static async build(roots: readonly string[]): Promise<SystemProfileIndex> {
    const index = new SystemProfileIndex(roots);
    for (const root of roots) {
      const abs = path.resolve(root);
      for (const file of walkJson(abs)) {
        const rel = path.relative(abs, file);
        const segments = rel.split(path.sep);
        // `<Vendor>/…/x.json` is vendor-scoped; a file sitting directly in the root
        // is an unscoped operator drop-in (and, in a slicer tree, a manifest).
        const vendor = segments.length >= 2 ? segments[0] : null;
        const dirType = segments.length >= 2 ? typeOfDir(segments[segments.length - 2]) : null;
        const name = readProfileName(file);
        if (!name) continue;
        index.add({ name, vendor, file, dirType });
      }
    }
    return index;
  }

  /** Builds an index over already-parsed profiles (tests, in-memory fixtures). */
  static fromProfiles(profiles: readonly SystemProfile[]): SystemProfileIndex {
    const index = new SystemProfileIndex([]);
    for (const p of profiles) {
      index.add({ name: p.name, vendor: p.vendor, file: p.file, dirType: p.type });
      index.parsed.set(p.file, p);
    }
    return index;
  }

  private add(entry: IndexEntry): void {
    const list = this.byName.get(entry.name);
    if (!list) {
      this.byName.set(entry.name, [entry]);
      return;
    }
    // First root wins for the same (vendor, name): vendor/ overrides the slicer tree.
    if (list.some((e) => e.vendor === entry.vendor)) return;
    list.push(entry);
  }

  /** Every indexed name (diagnostics / tests). */
  get size(): number {
    return this.byName.size;
  }

  /**
   * Every system profile shipping `name`, parsed on demand. Files whose real `name`
   * does not match the index (or that are not presets at all) are dropped here — the
   * index scan is deliberately cheap and this is where it is verified.
   */
  lookup(name: string): SystemProfile[] {
    const entries = this.byName.get(name);
    if (!entries) return [];
    const out: SystemProfile[] = [];
    for (const entry of entries) {
      const profile = this.load(entry);
      if (profile && profile.name === name) out.push(profile);
    }
    return out;
  }

  private load(entry: IndexEntry): SystemProfile | null {
    const cached = this.parsed.get(entry.file);
    if (cached !== undefined) return cached;
    const profile = readSystemProfileSync(entry.file, entry.vendor, entry.dirType);
    this.parsed.set(entry.file, profile);
    return profile;
  }
}

/** Parses one system profile file; null when it is not a usable preset. */
export function parseSystemProfile(
  text: string,
  file: string,
  vendor: string | null,
  dirType: ProfileType | null
): SystemProfile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const settings = parsed as OrcaSettings;
  if (isVendorManifest(settings)) return null;
  const name = firstString(settings.name);
  if (!name) return null;
  const type = systemProfileType(settings, dirType);
  if (!type) return null;
  return { type, name, inherits: firstString(settings.inherits), settings, vendor, file };
}

function readSystemProfileSync(
  file: string,
  vendor: string | null,
  dirType: ProfileType | null
): SystemProfile | null {
  try {
    // Synchronous by necessity: this runs inside the pure resolver's `byName`
    // callback. Only the few files a chain actually walks are ever read.
    return parseSystemProfile(fs.readFileSync(file, "utf8"), file, vendor, dirType);
  } catch {
    return null;
  }
}

/**
 * Reads just the `name` of a profile file, without building a JSON object graph.
 *
 * Deliberately synchronous: the scan visits ~5.4k files, and awaiting each read
 * separately costs an order of magnitude more wall-clock (~4.3 s) than reading them
 * straight through (~0.4 s) — this runs during boot, so that difference matters.
 * The extracted name is verified against the real parsed profile in
 * {@link SystemProfileIndex.lookup} before anything uses it.
 */
function readProfileName(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const m = NAME_RE.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

function walkJson(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJson(abs));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) out.push(abs);
  }
  return out;
}
