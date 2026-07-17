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
