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

test("«Автоочередь» starts OFF, and a locked rule cannot be switched on — only off", () => {
  const locked = "автоочередь выключена при развёртывании (AUTO_QUEUE_ENABLED=false)";
  const store = new AutomationStore(undefined, undefined, undefined, (id) => (id === "auto-queue" ? locked : null));
  const rule = store.list().find((r) => r.id === "auto-queue");
  assert.equal(rule?.on, false, "off by default");
  assert.equal(rule?.locked, locked, "the reason travels with the rule");
  assert.throws(() => store.toggle("auto-queue", true), /AUTO_QUEUE_ENABLED=false/);
  assert.throws(() => store.toggle("auto-queue"), /нельзя включить/, "a flip from off is an enable");
  assert.equal(store.isEnabled("auto-queue"), false);
  assert.doesNotThrow(() => store.toggle("auto-queue", false), "switching off is always allowed");
  // Other rules are not affected by another rule's lock.
  assert.equal(store.list().find((r) => r.id === "night-lights")?.locked, undefined);
});

test("a rule stored ON from earlier counts as off while its deployment switch is off", () => {
  const store = new AutomationStore(
    { states: { "auto-queue": true }, lastRun: null },
    undefined,
    undefined,
    (id) => (id === "auto-queue" ? "выключена при развёртывании" : null)
  );
  assert.equal(store.isEnabled("auto-queue"), false);
});

test("the circuit breaker switches a rule off, persists it and says why in the feed", () => {
  let persisted = 0;
  const lines: string[] = [];
  const feed = { push: (_icon: string, text: string) => void lines.push(text) } as unknown as ConstructorParameters<
    typeof AutomationStore
  >[1];
  const store = new AutomationStore(undefined, feed, () => void (persisted += 1));
  store.toggle("auto-queue", true);
  const before = persisted;
  store.disarm("auto-queue", "исход запуска неизвестен");
  assert.equal(store.isEnabled("auto-queue"), false);
  assert.equal(persisted, before + 1, "a restart does not re-arm what tripped");
  assert.match(lines.at(-1) ?? "", /выключено автоматически: исход запуска неизвестен/);
  store.disarm("auto-queue", "again");
  assert.equal(persisted, before + 1, "disarming an off rule is a no-op");
});
