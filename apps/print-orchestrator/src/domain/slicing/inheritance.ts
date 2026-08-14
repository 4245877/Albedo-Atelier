import type { AnalysisFinding } from "../print/types";
import { finding } from "./findings";
import type { OrcaSettings } from "./orcaProfile";
import type { ProfileType } from "./types";

/**
 * OrcaSlicer inheritance resolution.
 *
 * A profile `inherits` a parent *by name* (same type), the parent may inherit its
 * own parent, and so on up to a root (`inherits: ""`/absent). The effective
 * settings are the whole chain shallow-merged root→leaf, so a child key overrides
 * the same key in any ancestor. This resolver walks that chain and reports, as
 * blockers, the ways it can break:
 *
 *   - **missing parent** — `inherits` names a profile that is nowhere available
 *     (the common case: an OrcaSlicer *system* parent that neither `vendor/` nor
 *     the pinned slicer's own profile tree provides);
 *   - **cycle** — the chain loops back on itself;
 *   - **wrong-type parent** — a profile with that name exists, but as a different
 *     type (e.g. a process inheriting a filament);
 *   - **ambiguous parent** — several OrcaSlicer *vendors* ship a profile under that
 *     exact name and nothing in the chain says which one is meant.
 *   - (multi-level chains are *not* an error — they resolve; `levels` reports depth.)
 *
 * ## Why vendors matter
 *
 * OrcaSlicer's system profiles are **vendor-scoped**, and their names are only
 * unique *within* a vendor: `resources/profiles` ships 46 different
 * `fdm_machine_common` (41 of them with distinct content), 27 `fdm_filament_common`,
 * two `fdm_bbl_3dp_001_common` (BBL's and OrcaArena's), and so on. Resolving a
 * parent by bare name across the whole tree therefore silently merges *another
 * printer brand's* base settings into a profile — the resolved JSON is what the
 * slicer is actually fed, so that is a wrong-G-code bug, not a cosmetic one.
 *
 * This resolver models that: every node carries its {@link ProfileNode.origin} and,
 * for system nodes, the {@link ProfileNode.vendor} folder it came from. Walking a
 * chain **locks onto the first vendor it enters** and resolves every further
 * ancestor inside that vendor (`Bambu Lab A1 0.4 PETG` → BBL's
 * `Bambu Lab A1 0.4 nozzle` → BBL's `fdm_bbl_3dp_001_common` → BBL's
 * `fdm_machine_common`, never Anker's or OrcaArena's). Unscoped operator files
 * (flat `vendor/*.json`) still resolve for any vendor, and a name that several
 * vendors claim *before* a lock is established is reported as `ambiguous_parent`
 * rather than guessed.
 *
 * Pure and side-effect free: it is given a `byName` lookup over the whole known
 * universe (catalog + system profiles) and returns a plain result the importer maps
 * onto a {@link ProfileRevision}'s status.
 */

/** Where a node came from: the imported catalog, or an OrcaSlicer system tree. */
export type ProfileOrigin = "catalog" | "system";

/** One profile in the resolution universe (raw settings, not yet merged). */
export interface ProfileNode {
  logicalId: string;
  type: ProfileType;
  name: string;
  inherits: string | null;
  settings: OrcaSettings;
  /** Defaults to `"catalog"` (an imported user preset). */
  origin?: ProfileOrigin;
  /**
   * The OrcaSlicer vendor folder a *system* node belongs to (`"BBL"`, `"Creality"`).
   * Null for catalog profiles and for unscoped operator files dropped flat into
   * `vendor/`, which deliberately match any vendor.
   */
  vendor?: string | null;
}

export interface ResolutionResult {
  /** Chain merged root→leaf; null when the chain could not be fully resolved. */
  resolved: OrcaSettings | null;
  /** Resolved profile names, root→leaf (only the portion that resolved). */
  chain: string[];
  /** Number of inheritance edges resolved (0 for a root profile). */
  levels: number;
  /** The vendor the chain locked onto, when it entered system profiles. */
  vendor: string | null;
  /** The parent name that could not be resolved; null when the chain resolved. */
  missingParent: string | null;
  warnings: AnalysisFinding[];
  blockers: AnalysisFinding[];
}

/** Lookup over the known universe: every node carrying `name` (any type). */
export type ByName = (name: string) => readonly ProfileNode[];

const MAX_DEPTH = 32; // hard stop well beyond any real Orca chain (belt-and-braces vs. cycles)

export function resolveInheritance(node: ProfileNode, byName: ByName): ResolutionResult {
  const warnings: AnalysisFinding[] = [];
  const blockers: AnalysisFinding[] = [];

  // Walk child → root, collecting the chain and catching breaks.
  const chainLeafToRoot: ProfileNode[] = [node];
  const visited = new Set<string>([node.logicalId]);
  let current = node;
  // A chain that *starts* inside a vendor stays in it (re-resolving a system profile).
  let vendor: string | null = node.origin === "system" ? node.vendor ?? null : null;

  for (let guard = 0; guard <= MAX_DEPTH; guard += 1) {
    const parentName = normalizeInherits(current.inherits);
    if (parentName === null) {
      // Reached a root — the chain is fully resolved.
      const chain = chainLeafToRoot.map((n) => n.name).reverse();
      const resolved = mergeChain(chainLeafToRoot);
      return {
        resolved,
        chain,
        levels: chainLeafToRoot.length - 1,
        vendor,
        missingParent: null,
        warnings,
        blockers
      };
    }

    if (parentName === current.name) {
      blockers.push(finding("inheritance_cycle", `Профиль «${current.name}» наследует сам себя`));
      return unresolved(chainLeafToRoot, vendor, null, warnings, blockers);
    }

    const pick = pickParent(parentName, node.type, vendor, byName);
    if (pick.kind !== "ok") {
      blockers.push(parentProblemFinding(parentName, node.type, vendor, pick));
      return unresolved(
        chainLeafToRoot,
        vendor,
        pick.kind === "wrong_type" ? null : parentName,
        warnings,
        blockers
      );
    }

    const parent = pick.node;
    if (visited.has(parent.logicalId)) {
      blockers.push(finding("inheritance_cycle", `Цикл наследования через «${parent.name}»`));
      return unresolved(chainLeafToRoot, vendor, null, warnings, blockers);
    }

    // The first system profile the chain enters fixes the vendor for the rest of it.
    if (parent.origin === "system" && parent.vendor) vendor ??= parent.vendor;

    visited.add(parent.logicalId);
    chainLeafToRoot.push(parent);
    current = parent;
  }

  // Depth guard tripped without finding a root — treat as a cycle/too-deep chain.
  blockers.push(
    finding("inheritance_cycle", `Слишком глубокая или циклическая цепочка наследования у «${node.name}»`)
  );
  return unresolved(chainLeafToRoot, vendor, null, warnings, blockers);
}

// ── Parent selection ─────────────────────────────────────────────────────────

type ParentPick =
  | { kind: "ok"; node: ProfileNode }
  | { kind: "missing" }
  /** The name exists in system trees, but not in the vendor this chain is locked to. */
  | { kind: "other_vendor"; vendors: string[] }
  /** Several vendors ship this name and nothing says which is meant. */
  | { kind: "ambiguous"; vendors: string[] }
  | { kind: "wrong_type"; actualType: ProfileType };

/**
 * Picks the one parent a chain should follow, in strict precedence order:
 *
 *   1. a **catalog** profile (a user preset inheriting another user preset from the
 *      same bundle) — the operator's own files always win;
 *   2. inside a locked vendor: that vendor's own profile, else an **unscoped**
 *      operator file from `vendor/` (a deliberate override that fits any vendor);
 *   3. with no lock yet: an unscoped operator file, else the single vendor that
 *      ships the name — several distinct vendors is `ambiguous`, never a guess.
 */
function pickParent(
  name: string,
  type: ProfileType,
  vendor: string | null,
  byName: ByName
): ParentPick {
  const all = byName(name);
  if (all.length === 0) return { kind: "missing" };

  const typed = all.filter((c) => c.type === type);
  if (typed.length === 0) return { kind: "wrong_type", actualType: all[0].type };

  const catalog = typed.filter((c) => (c.origin ?? "catalog") === "catalog");
  if (catalog.length > 0) return { kind: "ok", node: catalog[0] };

  const unscoped = typed.filter((c) => !c.vendor);
  if (vendor) {
    const sameVendor = typed.filter((c) => c.vendor === vendor);
    if (sameVendor.length > 0) return { kind: "ok", node: sameVendor[0] };
    if (unscoped.length > 0) return { kind: "ok", node: unscoped[0] };
    return { kind: "other_vendor", vendors: distinctVendors(typed) };
  }
  if (unscoped.length > 0) return { kind: "ok", node: unscoped[0] };

  const vendors = distinctVendors(typed);
  if (vendors.length > 1) return { kind: "ambiguous", vendors };
  return { kind: "ok", node: typed[0] };
}

function distinctVendors(nodes: readonly ProfileNode[]): string[] {
  return [...new Set(nodes.map((n) => n.vendor).filter((v): v is string => !!v))].sort();
}

/**
 * The operator-facing blocker for an unusable parent. Every message names the
 * parent in «…» **first** so {@link parentNameFromFinding} can recover it from a
 * stored revision, and says *where we looked* — the difference between "install the
 * system profiles" and "this preset was exported from a different OrcaSlicer/vendor
 * and its parent does not exist here" is the whole diagnosis.
 */
function parentProblemFinding(
  parentName: string,
  type: ProfileType,
  vendor: string | null,
  pick: Exclude<ParentPick, { kind: "ok" }>
): AnalysisFinding {
  switch (pick.kind) {
    case "wrong_type":
      return finding(
        "wrong_type_parent",
        `Родитель «${parentName}» имеет тип «${pick.actualType}», а не «${type}»`
      );
    case "other_vendor":
      return finding(
        "missing_parent",
        `Родительский профиль «${parentName}» (${type}) есть только у вендоров ${pick.vendors.join(", ")}, ` +
          `а цепочка наследования принадлежит вендору ${vendor} — смешивать системные профили разных вендоров нельзя`
      );
    case "ambiguous":
      return finding(
        "ambiguous_parent",
        `Родительский профиль «${parentName}» (${type}) есть у нескольких вендоров OrcaSlicer (${pick.vendors.join(", ")}) — ` +
          `неясно, какой имеется в виду; положите нужный в vendor/ явно`
      );
    default:
      return finding(
        "missing_parent",
        `Родительский профиль «${parentName}» (${type}) не найден` +
          (vendor ? ` у вендора ${vendor}` : "") +
          ` — нужен системный профиль OrcaSlicer (vendor/ или resources/profiles закреплённой сборки); ` +
          `если его там нет, пресет экспортирован из другой версии/сборки OrcaSlicer`
      );
  }
}

/**
 * Recovers the parent name from a stored `missing_parent`/`ambiguous_parent`
 * finding — the single place that knows the message convention, shared by the
 * import result and the runtime report so the two can never disagree.
 */
export function parentNameFromFinding(f: AnalysisFinding): string | null {
  if (f.code !== "missing_parent" && f.code !== "ambiguous_parent") return null;
  return /«([^»]+)»/.exec(f.message)?.[1] ?? null;
}

function unresolved(
  chainLeafToRoot: ProfileNode[],
  vendor: string | null,
  missingParent: string | null,
  warnings: AnalysisFinding[],
  blockers: AnalysisFinding[]
): ResolutionResult {
  return {
    resolved: null,
    chain: chainLeafToRoot.map((n) => n.name).reverse(),
    levels: chainLeafToRoot.length - 1,
    vendor,
    missingParent,
    warnings,
    blockers
  };
}

/** Shallow-merges a leaf→root chain into effective settings (child overrides parent). */
function mergeChain(chainLeafToRoot: readonly ProfileNode[]): OrcaSettings {
  const merged: OrcaSettings = {};
  // Apply root first, then each descendant, so the leaf's keys win.
  for (let i = chainLeafToRoot.length - 1; i >= 0; i -= 1) {
    Object.assign(merged, chainLeafToRoot[i].settings);
  }
  return merged;
}

/** An empty/whitespace `inherits` means "root"; anything else is a parent name. */
function normalizeInherits(inherits: string | null): string | null {
  if (inherits === null) return null;
  const trimmed = inherits.trim();
  return trimmed === "" ? null : trimmed;
}
