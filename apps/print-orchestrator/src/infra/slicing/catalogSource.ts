import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { declaredType, type OrcaSettings } from "../../domain/slicing/orcaProfile";
import type { ProfileType } from "../../domain/slicing/types";

/**
 * Reader for the vendored OrcaSlicer catalog under `config/slicers/orca` (see its
 * README). This is the sole on-disk source the {@link PresetImportService} imports
 * from — the runtime never reads the operator's `~/Presets`.
 *
 * It is deliberately read-only and defensive: it parses `catalog.v1.json`, loads
 * each referenced profile file, **recomputes** its SHA-256 and reports whether it
 * matches the catalog (the immutability check), and loads any operator-supplied
 * `vendor/` system profiles as additional inheritance parents. Nothing here mutates
 * the catalog or the DB.
 */

export interface CatalogSourceEntry {
  id: string;
  file: string;
  originalName: string;
  sha256: string;
  sizeBytes: number;
  bundleType: string | null;
  orcaVersion: string | null;
}

export interface CatalogProfileEntry {
  logicalId: string;
  type: ProfileType;
  name: string;
  file: string;
  sha256: string;
  sizeBytes: number;
  inherits: string | null;
  from: string | null;
  sources: string[];
}

export interface Catalog {
  catalogVersion: number;
  slicer: string;
  sources: CatalogSourceEntry[];
  profiles: CatalogProfileEntry[];
}

/** One profile file loaded from disk, with its content verified against the catalog. */
export interface LoadedProfile {
  logicalId: string;
  type: ProfileType;
  name: string;
  inherits: string | null;
  source: string | null;
  orcaVersion: string | null;
  /** Exact file text (byte-preserving for valid UTF-8 JSON). */
  raw: string;
  /** SHA-256 recomputed from the file bytes. */
  rawSha256: string;
  /** The SHA-256 the catalog recorded (for the immutability check). */
  expectedSha256: string;
  /** Parsed settings; null when the file did not parse as a JSON object. */
  settings: OrcaSettings | null;
  parseError: string | null;
}

/** A vendor (system) parent profile loaded from `vendor/`. */
export interface LoadedVendorProfile {
  type: ProfileType;
  name: string;
  inherits: string | null;
  settings: OrcaSettings;
}

export interface SourceVerification {
  id: string;
  file: string;
  ok: boolean;
  expectedSha256: string;
  actualSha256: string | null;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Infers a profile type from its payload when it carries no explicit `type`. */
function inferType(settings: OrcaSettings): ProfileType {
  const declared = declaredType(settings);
  if (declared) return declared;
  if ("printer_model" in settings || "printable_area" in settings || "printer_technology" in settings) {
    return "machine";
  }
  if ("filament_type" in settings || "filament_settings_id" in settings) return "filament";
  return "process";
}

function firstString(value: unknown): string | null {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

export class OrcaCatalogSource {
  /** Absolute path to the catalog root (`config/slicers/orca`). */
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Parses `catalog.v1.json`; throws a clear error if it is missing/malformed. */
  async readCatalog(): Promise<Catalog> {
    const file = path.join(this.root, "catalog.v1.json");
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch {
      throw new Error(`Каталог OrcaSlicer не найден: ${file}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Каталог OrcaSlicer повреждён (${file}): ${(error as Error).message}`);
    }
    const obj = parsed as Partial<Catalog>;
    return {
      catalogVersion: typeof obj.catalogVersion === "number" ? obj.catalogVersion : 1,
      slicer: typeof obj.slicer === "string" ? obj.slicer : "OrcaSlicer",
      sources: Array.isArray(obj.sources) ? (obj.sources as CatalogSourceEntry[]) : [],
      profiles: Array.isArray(obj.profiles) ? (obj.profiles as CatalogProfileEntry[]) : []
    };
  }

  /** Loads every catalog profile file, verifying its SHA-256 and parsing its JSON. */
  async loadProfiles(catalog: Catalog): Promise<LoadedProfile[]> {
    const out: LoadedProfile[] = [];
    for (const entry of catalog.profiles) {
      const abs = this.resolveInside(entry.file);
      let raw = "";
      let rawSha256 = "";
      let settings: OrcaSettings | null = null;
      let parseError: string | null = null;
      try {
        const buf = await fsp.readFile(abs);
        rawSha256 = sha256(buf);
        raw = buf.toString("utf8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          settings = parsed as OrcaSettings;
        } else {
          parseError = "профиль не является JSON-объектом";
        }
      } catch (error) {
        parseError = `не удалось прочитать/разобрать профиль: ${(error as Error).message}`;
      }
      out.push({
        logicalId: entry.logicalId,
        type: entry.type,
        name: entry.name,
        inherits: entry.inherits ?? null,
        source: entry.sources?.[0] ?? null,
        orcaVersion: this.orcaVersionForSource(catalog, entry.sources?.[0] ?? null),
        raw,
        rawSha256,
        expectedSha256: entry.sha256,
        settings,
        parseError
      });
    }
    return out;
  }

  /** Loads operator-supplied system parents from `vendor/` (recursively). */
  async loadVendorProfiles(): Promise<LoadedVendorProfile[]> {
    const dir = path.join(this.root, "vendor");
    const files = await this.walkJson(dir);
    const out: LoadedVendorProfile[] = [];
    for (const abs of files) {
      try {
        const parsed: unknown = JSON.parse(await fsp.readFile(abs, "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const settings = parsed as OrcaSettings;
        const name = firstString(settings.name);
        if (!name) continue;
        out.push({
          type: inferType(settings),
          name,
          inherits: firstString(settings.inherits),
          settings
        });
      } catch {
        // A malformed vendor file is skipped, not fatal.
      }
    }
    return out;
  }

  /** Verifies each source archive's bytes still hash to what the catalog recorded. */
  async verifySources(catalog: Catalog): Promise<SourceVerification[]> {
    const out: SourceVerification[] = [];
    for (const src of catalog.sources) {
      const abs = this.resolveInside(src.file);
      let actual: string | null = null;
      try {
        actual = sha256(await fsp.readFile(abs));
      } catch {
        actual = null;
      }
      out.push({
        id: src.id,
        file: src.file,
        expectedSha256: src.sha256,
        actualSha256: actual,
        ok: actual === src.sha256
      });
    }
    return out;
  }

  private orcaVersionForSource(catalog: Catalog, sourceId: string | null): string | null {
    if (!sourceId) return null;
    return catalog.sources.find((s) => s.id === sourceId)?.orcaVersion ?? null;
  }

  /** Resolves a catalog-relative path, refusing anything that escapes the root. */
  private resolveInside(rel: string): string {
    const abs = path.resolve(this.root, rel);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (abs !== this.root && !abs.startsWith(rootWithSep)) {
      throw new Error(`Путь вне каталога: «${rel}»`);
    }
    return abs;
  }

  private async walkJson(dir: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.walkJson(abs)));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        out.push(abs);
      }
    }
    return out.sort();
  }
}
