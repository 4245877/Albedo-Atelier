import assert from "node:assert/strict";
import { test } from "node:test";

import { NotFoundError } from "../core/errors";
import { AUTOMATION_RULES, AutomationStore } from "./automationStore";

/*
 * The automation model is a small set of built-in behaviour toggles. Their
 * on/off state is real and persisted; flipping a switch is not a stub.
 */

test("exposes the built-in rules with their default state", () => {
  const store = new AutomationStore();
  const rules = store.list();
  assert.equal(rules.length, AUTOMATION_RULES.length);
  for (const rule of AUTOMATION_RULES) {
    const listed = rules.find((r) => r.id === rule.id);
    assert.ok(listed, `rule ${rule.id} is listed`);
    assert.equal(listed?.on, rule.defaultOn);
    assert.equal(store.isEnabled(rule.id), rule.defaultOn);
  }
});

test("toggle without an explicit value flips the rule and stamps last run", () => {
  const store = new AutomationStore();
  assert.equal(store.getLastRun(), null);

  const before = store.isEnabled("night-lights");
  const result = store.toggle("night-lights");
  assert.equal(result.on, !before);
  assert.equal(store.isEnabled("night-lights"), !before);
  assert.ok(store.getLastRun(), "last run is stamped after a toggle");
});

test("toggle with an explicit value sets it directly (idempotent)", () => {
  const store = new AutomationStore();
  store.toggle("night-queue", false);
  assert.equal(store.isEnabled("night-queue"), false);
  store.toggle("night-queue", false);
  assert.equal(store.isEnabled("night-queue"), false);
  store.toggle("night-queue", true);
  assert.equal(store.isEnabled("night-queue"), true);
});

test("an unknown rule id is a real NotFound, not a silent success", () => {
  const store = new AutomationStore();
  assert.throws(() => store.toggle("does-not-exist"), NotFoundError);
});

test("hydrates persisted state and round-trips through serialize", () => {
  const store = new AutomationStore({ states: { "night-lights": false }, lastRun: "23:10" });
  assert.equal(store.isEnabled("night-lights"), false);
  // A rule absent from persisted state falls back to its default.
  assert.equal(store.isEnabled("night-queue"), true);
  assert.equal(store.getLastRun(), "23:10");

  const serialized = store.serialize();
  assert.equal(serialized.states["night-lights"], false);
  assert.equal(serialized.states["night-queue"], true);
  assert.equal(serialized.lastRun, "23:10");
});

test("persist is invoked on toggle so the change survives a restart", () => {
  let saves = 0;
  const store = new AutomationStore({ states: {}, lastRun: null }, undefined, () => {
    saves += 1;
  });
  store.toggle("night-lights");
  assert.ok(saves >= 1, "the toggle was persisted");
});
