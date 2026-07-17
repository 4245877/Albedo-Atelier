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
 * blockers, the four ways it can break:
 *
 *   - **missing parent** — `inherits` names a profile that is nowhere available
 *     (the common case here: an OrcaSlicer *system* parent not yet in `vendor/`);
 *   - **cycle** — the chain loops back on itself;
 *   - **wrong-type parent** — a profile with that name exists, but as a different
 *     type (e.g. a process inheriting a filament);
 *   - (multi-level chains are *not* an error — they resolve; `levels` reports depth.)
 *
 * Pure and side-effect free: it is given a `byName` lookup over the whole known
 * universe (catalog + vendor) and returns a plain result the importer maps onto a
 * {@link ProfileRevision}'s status.
 */

/** One profile in the resolution universe (raw settings, not yet merged). */
export interface ProfileNode {
  logicalId: string;
  type: ProfileType;
  name: string;
  inherits: string | null;
  settings: OrcaSettings;
}

export interface ResolutionResult {
  /** Chain merged root→leaf; null when the chain could not be fully resolved. */
  resolved: OrcaSettings | null;
  /** Resolved profile names, root→leaf (only the portion that resolved). */
  chain: string[];
  /** Number of inheritance edges resolved (0 for a root profile). */
  levels: number;
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

  for (let guard = 0; guard <= MAX_DEPTH; guard += 1) {
    const parentName = normalizeInherits(current.inherits);
    if (parentName === null) {
      // Reached a root — the chain is fully resolved.
      const chain = chainLeafToRoot.map((n) => n.name).reverse();
      const resolved = mergeChain(chainLeafToRoot);
      return { resolved, chain, levels: chainLeafToRoot.length - 1, warnings, blockers };
    }

    if (parentName === current.name) {
      blockers.push(finding("inheritance_cycle", `Профиль «${current.name}» наследует сам себя`));
      return unresolved(chainLeafToRoot, warnings, blockers);
    }

    const candidates = byName(parentName);
    if (candidates.length === 0) {
      blockers.push(
        finding(
          "missing_parent",
          `Родительский профиль «${parentName}» не найден (нужен системный профиль OrcaSlicer в vendor/)`
        )
      );
      return unresolved(chainLeafToRoot, warnings, blockers);
    }

    const sameType = candidates.find((c) => c.type === node.type);
    if (!sameType) {
      blockers.push(
        finding(
          "wrong_type_parent",
          `Родитель «${parentName}» имеет тип «${candidates[0].type}», а не «${node.type}»`
        )
      );
      return unresolved(chainLeafToRoot, warnings, blockers);
    }

    if (visited.has(sameType.logicalId)) {
      blockers.push(
        finding("inheritance_cycle", `Цикл наследования через «${sameType.name}»`)
      );
      return unresolved(chainLeafToRoot, warnings, blockers);
    }

    visited.add(sameType.logicalId);
    chainLeafToRoot.push(sameType);
    current = sameType;
  }

  // Depth guard tripped without finding a root — treat as a cycle/too-deep chain.
  blockers.push(
    finding("inheritance_cycle", `Слишком глубокая или циклическая цепочка наследования у «${node.name}»`)
  );
  return unresolved(chainLeafToRoot, warnings, blockers);
}

function unresolved(
  chainLeafToRoot: ProfileNode[],
  warnings: AnalysisFinding[],
  blockers: AnalysisFinding[]
): ResolutionResult {
  return {
    resolved: null,
    chain: chainLeafToRoot.map((n) => n.name).reverse(),
    levels: chainLeafToRoot.length - 1,
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
