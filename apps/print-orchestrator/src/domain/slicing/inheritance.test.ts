import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveInheritance, type ByName, type ProfileNode } from "./inheritance";

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
