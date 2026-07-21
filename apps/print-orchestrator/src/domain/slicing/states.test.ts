import assert from "node:assert/strict";
import { test } from "node:test";

import { assertTransition, canTransition, isTerminal } from "../print/states";
import { SLICE_VARIANT_TRANSITIONS } from "./states";
import type { SliceVariantState } from "./types";

const ALL: SliceVariantState[] = ["pending", "running", "ready", "failed", "blocked"];

// Every legal edge, per the documented lifecycle (mirrors ARTIFACT_ANALYSIS with a
// `blocked` terminal): a worker runs a pending variant, finishes it, or refuses it;
// any terminal may be re-queued to `pending`; `running → pending` is crash recovery.
const LEGAL: Array<[SliceVariantState, SliceVariantState]> = [
  ["pending", "running"],
  ["pending", "blocked"],
  ["pending", "failed"],
  ["running", "ready"],
  ["running", "failed"],
  ["running", "blocked"],
  ["running", "pending"],
  ["ready", "pending"],
  ["failed", "pending"],
  ["blocked", "pending"]
];

test("every documented legal transition is permitted", () => {
  for (const [from, to] of LEGAL) {
    assert.ok(canTransition(SLICE_VARIANT_TRANSITIONS, from, to), `${from} → ${to} must be legal`);
    assert.doesNotThrow(() => assertTransition("вариант слайсинга", SLICE_VARIANT_TRANSITIONS, from, to));
  }
});

test("a self-transition is always allowed (idempotent 'set to X')", () => {
  for (const s of ALL) {
    assert.ok(canTransition(SLICE_VARIANT_TRANSITIONS, s, s));
  }
});

test("every non-legal, non-self edge is rejected by the guard", () => {
  const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
  for (const from of ALL) {
    for (const to of ALL) {
      if (from === to) continue;
      if (legalSet.has(`${from}->${to}`)) continue;
      assert.ok(!canTransition(SLICE_VARIANT_TRANSITIONS, from, to), `${from} → ${to} must be illegal`);
      assert.throws(() => assertTransition("вариант слайсинга", SLICE_VARIANT_TRANSITIONS, from, to));
    }
  }
});

test("a pending variant can never jump straight to ready — it must run first", () => {
  assert.ok(!canTransition(SLICE_VARIANT_TRANSITIONS, "pending", "ready"));
});

test("a terminal variant can only re-enter via pending (never straight back to running/ready)", () => {
  for (const terminal of ["ready", "failed", "blocked"] as const) {
    assert.deepEqual([...SLICE_VARIANT_TRANSITIONS[terminal]], ["pending"]);
    // The only non-self edge out of a terminal is → pending.
    for (const to of ALL) {
      if (to === terminal || to === "pending") continue;
      assert.ok(!canTransition(SLICE_VARIANT_TRANSITIONS, terminal, to), `${terminal} → ${to} must be illegal`);
    }
  }
});

test("no slice state is a dead end — every terminal is re-runnable (has an outgoing edge)", () => {
  for (const s of ALL) {
    assert.ok(!isTerminal(SLICE_VARIANT_TRANSITIONS, s), `${s} must be re-runnable`);
  }
});
