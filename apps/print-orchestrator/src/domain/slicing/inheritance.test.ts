import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parentNameFromFinding,
  resolveInheritance,
  type ByName,
  type ProfileNode
} from "./inheritance";

function node(partial: Partial<ProfileNode> & Pick<ProfileNode, "name" | "type">): ProfileNode {
  return {
    logicalId: `${partial.type}:${partial.name}`,
    inherits: null,
    settings: {},
    ...partial
  };
}

/** Builds a `byName` lookup over a fixed set of nodes. */
function universe(nodes: ProfileNode[]): ByName {
  return (name) => nodes.filter((n) => n.name === name);
}

test("resolves a multi-level chain, child overriding parent overriding root", () => {
  const root = node({ name: "root", type: "process", settings: { a: "1", b: "1", c: "1" } });
  const mid = node({ name: "mid", type: "process", inherits: "root", settings: { b: "2", c: "2" } });
  const leaf = node({ name: "leaf", type: "process", inherits: "mid", settings: { c: "3" } });

  const result = resolveInheritance(leaf, universe([root, mid, leaf]));
  assert.equal(result.blockers.length, 0);
  assert.deepEqual(result.resolved, { a: "1", b: "2", c: "3" });
  assert.deepEqual(result.chain, ["root", "mid", "leaf"]);
  assert.equal(result.levels, 2);
});

test("a root profile (inherits empty) resolves to its own settings, 0 levels", () => {
  const root = node({ name: "base", type: "filament", inherits: "", settings: { filament_type: "PLA" } });
  const result = resolveInheritance(root, universe([root]));
  assert.equal(result.blockers.length, 0);
  assert.deepEqual(result.resolved, { filament_type: "PLA" });
  assert.equal(result.levels, 0);
});

test("a missing parent is a blocker and leaves the profile unresolved", () => {
  const leaf = node({ name: "user", type: "machine", inherits: "System 0.4 nozzle" });
  const result = resolveInheritance(leaf, universe([leaf]));
  assert.equal(result.resolved, null);
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].code, "missing_parent");
  assert.match(result.blockers[0].message, /System 0\.4 nozzle/);
});

test("a self-referential inherits is detected as a cycle", () => {
  const leaf = node({ name: "loop", type: "process", inherits: "loop" });
  const result = resolveInheritance(leaf, universe([leaf]));
  assert.equal(result.resolved, null);
  assert.equal(result.blockers[0].code, "inheritance_cycle");
});

test("an indirect cycle (a→b→a) is detected", () => {
  const a = node({ name: "a", type: "process", inherits: "b" });
  const b = node({ name: "b", type: "process", inherits: "a" });
  const result = resolveInheritance(a, universe([a, b]));
  assert.equal(result.resolved, null);
  assert.equal(result.blockers[0].code, "inheritance_cycle");
});

test("a parent of a different type is a blocker (wrong-type parent)", () => {
  const parent = node({ name: "shared", type: "filament" });
  const child = node({ name: "child", type: "process", inherits: "shared" });
  const result = resolveInheritance(child, universe([parent, child]));
  assert.equal(result.resolved, null);
  assert.equal(result.blockers[0].code, "wrong_type_parent");
});

test("a same-name parent of the right type is preferred over a wrong-type namesake", () => {
  const wrong = node({ name: "shared", type: "filament", settings: { x: "wrong" } });
  const right = node({ name: "shared", type: "process", inherits: "", settings: { x: "right" } });
  const child = node({ name: "child", type: "process", inherits: "shared" });
  const result = resolveInheritance(child, universe([wrong, right, child]));
  assert.equal(result.blockers.length, 0);
  assert.equal(result.resolved?.x, "right");
});

test("a whitespace-only inherits is treated as a root (no missing-parent blocker)", () => {
  const root = node({ name: "ws", type: "process", inherits: "   ", settings: { a: "1" } });
  const result = resolveInheritance(root, universe([root]));
  assert.equal(result.blockers.length, 0);
  assert.equal(result.levels, 0);
  assert.deepEqual(result.resolved, { a: "1" });
});

test("resolution does not mutate the input nodes' settings", () => {
  const root = node({ name: "root", type: "process", settings: { a: "1", b: "1" } });
  const leaf = node({ name: "leaf", type: "process", inherits: "root", settings: { b: "2" } });
  const rootSnapshot = JSON.parse(JSON.stringify(root.settings));
  const leafSnapshot = JSON.parse(JSON.stringify(leaf.settings));

  const result = resolveInheritance(leaf, universe([root, leaf]));
  // Result reflects the merge …
  assert.deepEqual(result.resolved, { a: "1", b: "2" });
  // … but neither source object was written through.
  assert.deepEqual(root.settings, rootSnapshot);
  assert.deepEqual(leaf.settings, leafSnapshot);
});

test("a child key wins even when it overrides a parent value with an empty string", () => {
  // Documents the actual shallow-merge semantics: the leaf's own value replaces the
  // ancestor's, including a deliberate empty-string override (no special reset marker).
  const root = node({ name: "root", type: "filament", settings: { note: "inherited" } });
  const leaf = node({ name: "leaf", type: "filament", inherits: "root", settings: { note: "" } });
  const result = resolveInheritance(leaf, universe([root, leaf]));
  assert.equal(result.resolved?.note, "");
});

test("a shared ancestor reused by two leaves is not a false cycle and stays intact", () => {
  const root = node({ name: "root", type: "process", settings: { base: "1" } });
  const a = node({ name: "a", type: "process", inherits: "root", settings: { a: "1" } });
  const b = node({ name: "b", type: "process", inherits: "root", settings: { b: "1" } });
  const uni = universe([root, a, b]);

  const ra = resolveInheritance(a, uni);
  const rb = resolveInheritance(b, uni);
  assert.equal(ra.blockers.length, 0);
  assert.equal(rb.blockers.length, 0);
  assert.deepEqual(ra.resolved, { base: "1", a: "1" });
  assert.deepEqual(rb.resolved, { base: "1", b: "1" });
  assert.deepEqual(root.settings, { base: "1" });
});

test("a long acyclic chain resolves with the right depth and leaf-wins ordering", () => {
  const nodes: ProfileNode[] = [];
  const depth = 20;
  for (let i = 0; i <= depth; i += 1) {
    nodes.push(
      node({
        name: `p${i}`,
        type: "process",
        inherits: i === 0 ? "" : `p${i - 1}`,
        settings: { level: String(i), [`k${i}`]: String(i) }
      })
    );
  }
  const leaf = nodes[depth];
  const result = resolveInheritance(leaf, universe(nodes));
  assert.equal(result.blockers.length, 0);
  assert.equal(result.levels, depth);
  // `level` is set by every node → the leaf's value must win.
  assert.equal(result.resolved?.level, String(depth));
  // A key set only by the root survives to the resolved output.
  assert.equal(result.resolved?.k0, "0");
});

test("a duplicate same-type parent name is applied once, not twice, and is not a cycle", () => {
  // Two same-type nodes share the name "base"; the resolver takes the first match
  // and follows its chain — it must not double-apply or spuriously report a cycle.
  const base = node({ name: "base", type: "process", inherits: "", settings: { shared: "1" } });
  const baseDup = node({ name: "base", type: "process", inherits: "", settings: { shared: "2" } });
  const leaf = node({ name: "leaf", type: "process", inherits: "base", settings: { own: "1" } });
  const result = resolveInheritance(leaf, universe([base, baseDup, leaf]));
  assert.equal(result.blockers.length, 0);
  assert.equal(result.levels, 1);
  assert.deepEqual(result.resolved, { shared: "1", own: "1" });
});

// ── Vendor scoping ───────────────────────────────────────────────────────────
// OrcaSlicer system profile names are only unique WITHIN a vendor: the shipped
// tree has 46 different `fdm_machine_common`. These cover the rule that keeps a
// Bambu chain inside BBL instead of silently merging another brand's base.

/** A system (vendor-scoped) node, as the importer builds them from `vendor/`. */
function systemNode(
  vendor: string,
  partial: Partial<ProfileNode> & Pick<ProfileNode, "name" | "type">
): ProfileNode {
  return node({
    ...partial,
    logicalId: `system:${vendor}:${partial.type}:${partial.name}`,
    origin: "system",
    vendor
  });
}

test("a chain locks onto the first system vendor and resolves ancestors inside it", () => {
  // The real shape: user preset → BBL's A1 nozzle profile → BBL's common → BBL's
  // machine root, with same-named Anker/OrcaArena files present in the universe.
  const bblRoot = systemNode("BBL", { name: "fdm_machine_common", type: "machine", settings: { base: "bbl" } });
  const ankerRoot = systemNode("Anker", { name: "fdm_machine_common", type: "machine", settings: { base: "anker" } });
  const bblCommon = systemNode("BBL", {
    name: "fdm_bbl_3dp_001_common",
    type: "machine",
    inherits: "fdm_machine_common",
    settings: { common: "bbl" }
  });
  const arenaCommon = systemNode("OrcaArena", {
    name: "fdm_bbl_3dp_001_common",
    type: "machine",
    inherits: "fdm_machine_common",
    settings: { common: "arena" }
  });
  const nozzle = systemNode("BBL", {
    name: "Bambu Lab A1 0.4 nozzle",
    type: "machine",
    inherits: "fdm_bbl_3dp_001_common",
    settings: { nozzle_diameter: ["0.4"] }
  });
  const user = node({
    name: "Bambu Lab A1 0.4 PETG",
    type: "machine",
    inherits: "Bambu Lab A1 0.4 nozzle",
    settings: { printer_model: "Bambu Lab A1" }
  });

  const result = resolveInheritance(
    user,
    universe([ankerRoot, bblRoot, arenaCommon, bblCommon, nozzle, user])
  );
  assert.equal(result.blockers.length, 0);
  assert.equal(result.vendor, "BBL");
  assert.deepEqual(result.chain, [
    "fdm_machine_common",
    "fdm_bbl_3dp_001_common",
    "Bambu Lab A1 0.4 nozzle",
    "Bambu Lab A1 0.4 PETG"
  ]);
  // The BBL variants won on both ambiguous levels — never Anker's or OrcaArena's.
  assert.equal(result.resolved?.base, "bbl");
  assert.equal(result.resolved?.common, "bbl");
});

test("a parent claimed by several vendors with no lock yet is ambiguous, not guessed", () => {
  const a = systemNode("Anker", { name: "fdm_filament_common", type: "filament", settings: { base: "anker" } });
  const b = systemNode("BBL", { name: "fdm_filament_common", type: "filament", settings: { base: "bbl" } });
  const user = node({ name: "My PLA", type: "filament", inherits: "fdm_filament_common" });

  const result = resolveInheritance(user, universe([a, b, user]));
  assert.equal(result.resolved, null);
  assert.equal(result.blockers[0].code, "ambiguous_parent");
  assert.match(result.blockers[0].message, /Anker, BBL/);
  assert.equal(result.missingParent, "fdm_filament_common");
});

test("a vendor-locked chain refuses a parent that only another vendor ships", () => {
  const bblNozzle = systemNode("BBL", {
    name: "Bambu Lab A1 0.4 nozzle",
    type: "machine",
    inherits: "fdm_machine_common"
  });
  const ankerRoot = systemNode("Anker", { name: "fdm_machine_common", type: "machine" });
  const user = node({ name: "user", type: "machine", inherits: "Bambu Lab A1 0.4 nozzle" });

  const result = resolveInheritance(user, universe([bblNozzle, ankerRoot, user]));
  assert.equal(result.resolved, null);
  assert.equal(result.blockers[0].code, "missing_parent");
  assert.match(result.blockers[0].message, /только у вендоров Anker/);
  assert.match(result.blockers[0].message, /вендору BBL/);
});

test("an unscoped operator file in vendor/ resolves for a vendor-locked chain", () => {
  // A flat `vendor/*.json` drop-in is a deliberate override and fits any vendor.
  const bblNozzle = systemNode("BBL", {
    name: "Bambu Lab A1 0.4 nozzle",
    type: "machine",
    inherits: "fdm_machine_common",
    settings: { nozzle_diameter: ["0.4"] }
  });
  const loose = node({
    name: "fdm_machine_common",
    type: "machine",
    logicalId: "system:-:machine:fdm_machine_common",
    origin: "system",
    vendor: null,
    settings: { base: "operator" }
  });
  const user = node({ name: "user", type: "machine", inherits: "Bambu Lab A1 0.4 nozzle" });

  const result = resolveInheritance(user, universe([bblNozzle, loose, user]));
  assert.equal(result.blockers.length, 0);
  assert.equal(result.resolved?.base, "operator");
  assert.equal(result.vendor, "BBL");
});

test("a catalog profile wins over a same-named system profile", () => {
  // The operator's own bundle is authoritative for its own names.
  const system = systemNode("BBL", { name: "Base", type: "filament", settings: { who: "system" } });
  const own = node({ name: "Base", type: "filament", settings: { who: "catalog" } });
  const leaf = node({ name: "leaf", type: "filament", inherits: "Base" });

  const result = resolveInheritance(leaf, universe([system, own, leaf]));
  assert.equal(result.resolved?.who, "catalog");
  assert.equal(result.vendor, null);
});

test("a missing parent names the profile type and reports it as missingParent", () => {
  const leaf = node({ name: "user", type: "process", inherits: "0.08mm SuperDetail @Creality K2 0.2 nozzle" });
  const result = resolveInheritance(leaf, universe([leaf]));
  assert.equal(result.missingParent, "0.08mm SuperDetail @Creality K2 0.2 nozzle");
  assert.match(result.blockers[0].message, /\(process\)/);
  assert.equal(parentNameFromFinding(result.blockers[0]), "0.08mm SuperDetail @Creality K2 0.2 nozzle");
});

test("parentNameFromFinding ignores findings that are not about a parent", () => {
  assert.equal(parentNameFromFinding({ code: "nozzle_missing", message: "«0.4»" }), null);
});
