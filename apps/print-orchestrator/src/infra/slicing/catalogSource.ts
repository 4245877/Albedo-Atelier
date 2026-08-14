import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import type { OrcaSettings } from "../../domain/slicing/orcaProfile";
import type { ProfileType } from "../../domain/slicing/types";
import { SystemProfileIndex, type SystemProfile } from "./systemProfiles";

/**
 * Reader for the vendored OrcaSlicer catalog under `config/slicers/orca` (see its
 * README). This is the sole on-disk source the {@link PresetImportService} imports
 * from — the runtime never reads the operator's `~/Presets`.
 *
 * It is deliberately read-only and defensive: it parses `catalog.v1.json`, loads
 * each referenced profile file, **recomputes** its SHA-256 and reports whether it
 * matches the catalog (the immutability check), and indexes the OrcaSlicer *system*
 * profiles that the user presets inherit from. Nothing here mutates the catalog or
 * the DB.
 *
 * System parents come from `vendor/` **and** — when the deployment mounts an
 * OrcaSlicer runtime — that slicer's own `resources/profiles` tree
 * ({@link OrcaCatalogSource} `systemRoots`), so the parents used for resolution are
 * the very ones the CLI ships. See {@link SystemProfileIndex} for the vendor-scoping
 * rules that keep 46 same-named `fdm_machine_common` files apart.
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

/** A vendor (system) parent profile available as an inheritance parent. */
export type LoadedVendorProfile = SystemProfile;

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

export class OrcaCatalogSource {
  /** Absolute path to the catalog root (`config/slicers/orca`). */
  readonly root: string;
  /**
   * Extra OrcaSlicer system-profile trees searched after `vendor/` — normally the
   * pinned slicer's `resources/profiles`. Empty in a lean deployment, where
   * `vendor/` alone must carry the parents.
   */
  readonly systemRoots: readonly string[];

  constructor(root: string, systemRoots: readonly string[] = []) {
    this.root = path.resolve(root);
    this.systemRoots = systemRoots.map((r) => path.resolve(r));
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

  /**
   * Indexes the system (parent) profiles available to this deployment: the
   * operator's `vendor/` first, then any configured slicer tree. The index is
   * rebuilt on every import so dropping a parent into `vendor/` and re-importing
   * un-quarantines the revisions that needed it.
   */
  async loadSystemProfiles(): Promise<SystemProfileIndex> {
    return SystemProfileIndex.build([path.join(this.root, "vendor"), ...this.systemRoots]);
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
}
