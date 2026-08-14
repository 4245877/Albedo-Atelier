import { createHash } from "node:crypto";

import { ID_PREFIX, newId } from "../../domain/print/ids";
import { recordAuditEvent } from "../audit";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { AnalysisFinding, AuditEntityType, Metadata } from "../../domain/print/types";
import { checkProfileSelf } from "../../domain/slicing/compatibility";
import { dedupeFindings, finding } from "../../domain/slicing/findings";
import {
  parentNameFromFinding,
  resolveInheritance,
  type ByName,
  type ProfileNode
} from "../../domain/slicing/inheritance";
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
 *   1. read the catalog + the vendor-scoped system parents from `vendor/` and the
 *      pinned slicer's own profile tree (the resolution universe);
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
  /**
   * Stored revisions whose catalog entry is gone (an older staging), re-evaluated
   * against the current universe. They are not part of `counts`/`totalProfiles` —
   * those describe the catalog — but they ARE re-resolved, so installing a vendor
   * parent un-quarantines them too instead of leaving a stale verdict on the page.
   */
  orphans: ProfileImportOutcome[];
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
    const [loaded, system, sourceIntegrity] = await Promise.all([
      this.catalog.loadProfiles(catalog),
      this.catalog.loadSystemProfiles(),
      this.catalog.verifySources(catalog)
    ]);

    // The resolution universe: the catalog's own profiles, indexed eagerly, plus the
    // vendor-scoped system profiles, looked up (and parsed) lazily — the slicer's
    // tree holds thousands of presets and a chain touches a handful.
    const catalogNodes = new Map<string, ProfileNode[]>();
    for (const p of loaded) {
      if (!p.settings) continue;
      const node: ProfileNode = {
        logicalId: p.logicalId,
        type: p.type,
        name: p.name,
        inherits: p.inherits,
        settings: p.settings,
        origin: "catalog",
        vendor: null
      };
      const list = catalogNodes.get(p.name);
      if (list) list.push(node);
      else catalogNodes.set(p.name, [node]);
    }
    const byName: ByName = (name) => [
      ...(catalogNodes.get(name) ?? []),
      ...system.lookup(name).map(
        (v): ProfileNode => ({
          logicalId: `system:${v.vendor ?? "-"}:${v.type}:${v.name}`,
          type: v.type,
          name: v.name,
          inherits: v.inherits,
          settings: v.settings,
          origin: "system",
          vendor: v.vendor
        })
      )
    ];

    // Evaluate every profile (pure), then persist in one transaction.
    const evaluated = loaded.map((p) => this.evaluate(p, byName));
    // Revisions from an older catalog staging are re-evaluated too. Their verdict
    // otherwise freezes forever — a profile quarantined for a parent that has since
    // been installed would keep showing that stale blocker on the profiles page.
    const evaluatedOrphans = this.orphanProfiles(loaded).map((p) => this.evaluate(p, byName, true));

    const missingParents = new Set<string>();
    for (const e of [...evaluated, ...evaluatedOrphans]) {
      for (const b of e.blockers) {
        const parent = parentNameFromFinding(b);
        if (parent) missingParents.add(parent);
      }
    }

    const outcomes: ProfileImportOutcome[] = [];
    const orphanOutcomes: ProfileImportOutcome[] = [];
    this.store.transaction(() => {
      for (const e of evaluated) {
        outcomes.push(this.upsert(e, actor));
      }
      for (const e of evaluatedOrphans) {
        orphanOutcomes.push(this.upsert(e, actor));
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
      profiles: outcomes,
      orphans: orphanOutcomes
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
        orphansReevaluated: orphanOutcomes.length,
        sourceIntegrityOk: result.sourceIntegrity.ok
      }
    });
    this.options.logger?.info?.(
      { total: result.totalProfiles, active: counts.active, quarantined: counts.quarantined, invalid: counts.invalid, changed },
      "orca presets imported"
    );
    return result;
  }

  // ── Orphaned revisions ─────────────────────────────────────────────────────

  /**
   * Stored revisions the current catalog no longer lists, rebuilt from their own
   * immutable bytes so they can be re-resolved.
   *
   * A re-staged catalog leaves these behind (a renamed/removed preset, a bundle
   * replaced by a newer export). They stay usable — a slice reads `resolvedJson`
   * from the DB, not from disk — so freezing their verdict at whatever the universe
   * looked like on the day they were imported is simply wrong: the profiles page
   * would still show "parent missing" for a parent that has since been installed.
   * Their SHA is their own (nothing to drift against), and they get an explicit
   * warning that the catalog no longer carries them.
   */
  private orphanProfiles(loaded: readonly LoadedProfile[]): LoadedProfile[] {
    const catalogHashes = new Set(loaded.map((p) => p.rawSha256).filter(Boolean));
    const out: LoadedProfile[] = [];
    for (const rev of this.store.repositories.profileRevisions.list()) {
      if (!rev.rawSha256 || catalogHashes.has(rev.rawSha256)) continue;
      let settings: Record<string, unknown> | null = null;
      let parseError: string | null = null;
      try {
        const parsed: unknown = JSON.parse(rev.rawJson);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          settings = parsed as Record<string, unknown>;
        } else {
          parseError = "профиль не является JSON-объектом";
        }
      } catch (error) {
        parseError = `сохранённый профиль не разбирается: ${(error as Error).message}`;
      }
      out.push({
        logicalId: rev.logicalId,
        type: rev.type,
        name: rev.name,
        inherits: rev.inherits,
        source: rev.source,
        orcaVersion: rev.orcaVersion,
        raw: rev.rawJson,
        rawSha256: rev.rawSha256,
        // Its own hash: an orphan has no catalog entry to drift from.
        expectedSha256: rev.rawSha256,
        settings,
        parseError
      });
    }
    return out;
  }

  // ── Pure evaluation ────────────────────────────────────────────────────────

  private evaluate(
    p: LoadedProfile,
    byName: ByName,
    /** True for a revision the current catalog no longer lists (see {@link orphanProfiles}). */
    orphan = false
  ): {
    profile: LoadedProfile;
    status: ProfileRevisionStatus;
    resolvedJson: string | null;
    resolvedSha256: string | null;
    provenance: Metadata;
    warnings: AnalysisFinding[];
    blockers: AnalysisFinding[];
  } {
    const warnings: AnalysisFinding[] = [];
    const blockers: AnalysisFinding[] = [];

    if (orphan) {
      warnings.push(
        finding(
          "not_in_catalog",
          "Профиль остался от прежней версии каталога и больше в нём не значится — он по-прежнему пригоден (байты и разрешённые настройки хранятся в БД), но пере-стейджить каталог стоит осознанно"
        )
      );
    }

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
      return {
        profile: p,
        status: "invalid",
        resolvedJson: null,
        resolvedSha256: null,
        provenance: {},
        warnings,
        blockers
      };
    }

    const node: ProfileNode = {
      logicalId: p.logicalId,
      type: p.type,
      name: p.name,
      inherits: p.inherits,
      settings: p.settings,
      origin: "catalog",
      vendor: null
    };
    const resolution = resolveInheritance(node, byName);
    warnings.push(...resolution.warnings);
    blockers.push(...resolution.blockers);
    // The chain (and the vendor it locked onto) is the operator's answer to "what
    // exactly did this profile inherit?" — kept on the revision, not just in a log.
    const provenance: Metadata = {
      inheritanceChain: resolution.chain,
      inheritanceLevels: resolution.levels,
      vendor: resolution.vendor
    };

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
    return {
      profile: p,
      status,
      resolvedJson,
      resolvedSha256,
      provenance,
      warnings: dedupWarnings,
      blockers: dedupBlockers
    };
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
      blockers: e.blockers,
      // Provenance is refreshed on every pass: the same bytes can resolve through a
      // different chain once a vendor parent is installed.
      metadata: e.provenance
    };

    const existing = p.rawSha256 ? repos.profileRevisions.findByRawSha256(p.rawSha256) : null;
    if (existing) {
      const changed =
        existing.status !== base.status ||
        existing.resolvedSha256 !== base.resolvedSha256 ||
        JSON.stringify(existing.warnings) !== JSON.stringify(base.warnings) ||
        JSON.stringify(existing.blockers) !== JSON.stringify(base.blockers) ||
        JSON.stringify(existing.metadata) !== JSON.stringify(base.metadata);
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
      version: 1
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
    recordAuditEvent(this.store, () => this.now(), actor, {
      ...input,
      entityType: input.entityType ?? "profile_revision",
      entityId: input.entityId ?? "catalog"
    });
  }
}
