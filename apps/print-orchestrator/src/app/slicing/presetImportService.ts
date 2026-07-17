import { createHash } from "node:crypto";

import { ID_PREFIX, newId } from "../../domain/print/ids";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { AnalysisFinding, AuditEntityType, Metadata } from "../../domain/print/types";
import { checkProfileSelf } from "../../domain/slicing/compatibility";
import { dedupeFindings, finding } from "../../domain/slicing/findings";
import { resolveInheritance, type ByName, type ProfileNode } from "../../domain/slicing/inheritance";
import type {
  ProfileRevision,
  ProfileRevisionStatus,
  ProfileType
} from "../../domain/slicing/types";
import type {
  LoadedProfile,
  OrcaCatalogSource,
  SourceVerification
} from "../../infra/slicing/catalogSource";
import type { StoreLogger } from "../../shared/logger";

/**
 * Imports the vendored OrcaSlicer catalog into immutable {@link ProfileRevision}
 * rows.
 *
 * The flow, per the brief's "Проверка профилей":
 *   1. read the catalog + any `vendor/` system parents (the resolution universe);
 *   2. for each profile: verify its SHA-256 (immutability), parse it, resolve its
 *      inheritance chain, and run the per-profile self checks;
 *   3. derive a status — `invalid` (unparseable), `quarantined` (any blocker: a
 *      missing/cyclic/wrong-type parent, drifted content, or a self-contradiction),
 *      or `active` (resolves cleanly) — and **upsert by raw content hash**, so a
 *      re-import is idempotent and adding a `vendor/` parent re-evaluates and can
 *      un-quarantine a revision without ever rewriting its raw bytes.
 *
 * A quarantined revision is never activated and cannot be used in a profile set —
 * the guarantee that nothing slices against an unresolved profile.
 */

export interface ProfileImportOutcome {
  logicalId: string;
  type: ProfileType;
  name: string;
  status: ProfileRevisionStatus;
  warnings: AnalysisFinding[];
  blockers: AnalysisFinding[];
  /** Whether this pass inserted a new revision, changed an existing one, or left it. */
  change: "inserted" | "updated" | "unchanged";
}

export interface PresetImportResult {
  catalogVersion: number;
  slicer: string;
  orcaVersions: string[];
  totalProfiles: number;
  inserted: number;
  updated: number;
  unchanged: number;
  counts: Record<ProfileRevisionStatus, number>;
  /** Distinct parent names referenced but not resolvable (need `vendor/` profiles). */
  missingParents: string[];
  sourceIntegrity: { ok: boolean; sources: SourceVerification[] };
  profiles: ProfileImportOutcome[];
}

export class PresetImportService {
  constructor(
    private readonly store: PrintQueueStore,
    private readonly catalog: OrcaCatalogSource,
    private readonly options: { now?: () => Date; logger?: StoreLogger } = {}
  ) {}

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  /** Reads and imports the whole catalog; safe to call repeatedly (idempotent). */
  async import(actor = "system"): Promise<PresetImportResult> {
    const catalog = await this.catalog.readCatalog();
    const [loaded, vendor, sourceIntegrity] = await Promise.all([
      this.catalog.loadProfiles(catalog),
      this.catalog.loadVendorProfiles(),
      this.catalog.verifySources(catalog)
    ]);

    // Build the resolution universe (catalog + vendor), keyed by profile name.
    const nodes: ProfileNode[] = [];
    for (const p of loaded) {
      if (p.settings) {
        nodes.push({ logicalId: p.logicalId, type: p.type, name: p.name, inherits: p.inherits, settings: p.settings });
      }
    }
    for (const v of vendor) {
      nodes.push({ logicalId: `${v.type}:${v.name}`, type: v.type, name: v.name, inherits: v.inherits, settings: v.settings });
    }
    const byName = indexByName(nodes);

    // Evaluate every profile (pure), then persist in one transaction.
    const evaluated = loaded.map((p) => this.evaluate(p, byName));
    const missingParents = new Set<string>();
    for (const e of evaluated) {
      for (const b of e.blockers) {
        if (b.code === "missing_parent") {
          const m = /«([^»]+)»/.exec(b.message);
          if (m) missingParents.add(m[1]);
        }
      }
    }

    const outcomes: ProfileImportOutcome[] = [];
    this.store.transaction(() => {
      for (const e of evaluated) {
        outcomes.push(this.upsert(e, actor));
      }
    });

    const counts: Record<ProfileRevisionStatus, number> = { active: 0, quarantined: 0, invalid: 0 };
    for (const o of outcomes) counts[o.status] += 1;
    const changed = outcomes.filter((o) => o.change !== "unchanged").length;

    const result: PresetImportResult = {
      catalogVersion: catalog.catalogVersion,
      slicer: catalog.slicer,
      orcaVersions: [...new Set(catalog.sources.map((s) => s.orcaVersion).filter((v): v is string => !!v))],
      totalProfiles: loaded.length,
      inserted: outcomes.filter((o) => o.change === "inserted").length,
      updated: outcomes.filter((o) => o.change === "updated").length,
      unchanged: outcomes.filter((o) => o.change === "unchanged").length,
      counts,
      missingParents: [...missingParents].sort(),
      sourceIntegrity: { ok: sourceIntegrity.every((s) => s.ok), sources: sourceIntegrity },
      profiles: outcomes
    };

    this.recordAudit(actor, {
      action: "presets_imported",
      detail: {
        total: result.totalProfiles,
        inserted: result.inserted,
        updated: result.updated,
        active: counts.active,
        quarantined: counts.quarantined,
        invalid: counts.invalid,
        missingParents: result.missingParents,
        sourceIntegrityOk: result.sourceIntegrity.ok
      }
    });
    this.options.logger?.info?.(
      { total: result.totalProfiles, active: counts.active, quarantined: counts.quarantined, invalid: counts.invalid, changed },
      "orca presets imported"
    );
    return result;
  }

  // ── Pure evaluation ────────────────────────────────────────────────────────

  private evaluate(
    p: LoadedProfile,
    byName: ByName
  ): {
    profile: LoadedProfile;
    status: ProfileRevisionStatus;
    resolvedJson: string | null;
    resolvedSha256: string | null;
    warnings: AnalysisFinding[];
    blockers: AnalysisFinding[];
  } {
    const warnings: AnalysisFinding[] = [];
    const blockers: AnalysisFinding[] = [];

    // Integrity: the file must still hash to what the catalog recorded.
    if (p.rawSha256 && p.expectedSha256 && p.rawSha256 !== p.expectedSha256) {
      blockers.push(
        finding(
          "content_drift",
          `Содержимое профиля изменилось: SHA-256 ${p.rawSha256.slice(0, 12)}… ≠ каталог ${p.expectedSha256.slice(0, 12)}…`
        )
      );
    }

    if (!p.settings) {
      blockers.push(finding("unparseable", p.parseError ?? "профиль не читается"));
      return { profile: p, status: "invalid", resolvedJson: null, resolvedSha256: null, warnings, blockers };
    }

    const node: ProfileNode = {
      logicalId: p.logicalId,
      type: p.type,
      name: p.name,
      inherits: p.inherits,
      settings: p.settings
    };
    const resolution = resolveInheritance(node, byName);
    warnings.push(...resolution.warnings);
    blockers.push(...resolution.blockers);

    const self = checkProfileSelf({
      type: p.type,
      name: p.name,
      inherits: p.inherits,
      raw: p.settings,
      resolved: resolution.resolved
    });
    warnings.push(...self.warnings);
    blockers.push(...self.blockers);

    let resolvedJson: string | null = null;
    let resolvedSha256: string | null = null;
    if (resolution.resolved) {
      resolvedJson = JSON.stringify(resolution.resolved);
      resolvedSha256 = createHash("sha256").update(resolvedJson).digest("hex");
    }

    const dedupWarnings = dedupeFindings(warnings);
    const dedupBlockers = dedupeFindings(blockers);
    // Blocker ⇒ quarantined; content otherwise usable ⇒ active.
    const status: ProfileRevisionStatus = dedupBlockers.length > 0 ? "quarantined" : "active";
    return { profile: p, status, resolvedJson, resolvedSha256, warnings: dedupWarnings, blockers: dedupBlockers };
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private upsert(
    e: ReturnType<PresetImportService["evaluate"]>,
    actor: string
  ): ProfileImportOutcome {
    const repos = this.store.repositories;
    const p = e.profile;
    const iso = this.now();
    const base = {
      logicalId: p.logicalId,
      type: p.type,
      name: p.name,
      inherits: p.inherits,
      status: e.status,
      resolvedJson: e.resolvedJson,
      resolvedSha256: e.resolvedSha256,
      orcaVersion: p.orcaVersion,
      source: p.source,
      warnings: e.warnings,
      blockers: e.blockers
    };

    const existing = p.rawSha256 ? repos.profileRevisions.findByRawSha256(p.rawSha256) : null;
    if (existing) {
      const changed =
        existing.status !== base.status ||
        existing.resolvedSha256 !== base.resolvedSha256 ||
        JSON.stringify(existing.warnings) !== JSON.stringify(base.warnings) ||
        JSON.stringify(existing.blockers) !== JSON.stringify(base.blockers);
      if (!changed) {
        return { logicalId: p.logicalId, type: p.type, name: p.name, status: existing.status, warnings: existing.warnings, blockers: existing.blockers, change: "unchanged" };
      }
      const updated = repos.profileRevisions.update({ ...existing, ...base, updatedAt: iso });
      this.recordAudit(actor, {
        entityId: updated.id,
        action: "profile_reevaluated",
        from: existing.status,
        to: updated.status,
        detail: { logicalId: p.logicalId }
      });
      return { logicalId: p.logicalId, type: p.type, name: p.name, status: updated.status, warnings: updated.warnings, blockers: updated.blockers, change: "updated" };
    }

    const revision: ProfileRevision = {
      id: newId(ID_PREFIX.profileRevision),
      ...base,
      rawJson: p.raw,
      rawSha256: p.rawSha256,
      createdAt: iso,
      updatedAt: iso,
      version: 1,
      metadata: {}
    };
    repos.profileRevisions.insert(revision);
    this.recordAudit(actor, {
      entityId: revision.id,
      action: "profile_imported",
      to: revision.status,
      detail: { logicalId: p.logicalId, type: p.type }
    });
    return { logicalId: p.logicalId, type: p.type, name: p.name, status: revision.status, warnings: revision.warnings, blockers: revision.blockers, change: "inserted" };
  }

  private recordAudit(
    actor: string,
    input: { entityType?: AuditEntityType; entityId?: string; action: string; from?: string; to?: string; detail?: Metadata }
  ): void {
    this.store.repositories.audit.insert({
      id: newId(ID_PREFIX.auditEvent),
      at: this.now(),
      entityType: input.entityType ?? "profile_revision",
      entityId: input.entityId ?? "catalog",
      action: input.action,
      fromState: input.from ?? null,
      toState: input.to ?? null,
      actor,
      detail: input.detail ?? {}
    });
  }
}

/** Groups nodes by their profile `name` for the inheritance `byName` lookup. */
function indexByName(nodes: readonly ProfileNode[]): ByName {
  const map = new Map<string, ProfileNode[]>();
  for (const n of nodes) {
    const list = map.get(n.name);
    if (list) list.push(n);
    else map.set(n.name, [n]);
  }
  return (name) => map.get(name) ?? [];
}
