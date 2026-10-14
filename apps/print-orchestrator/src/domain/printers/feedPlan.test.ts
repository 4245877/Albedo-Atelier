import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveFeedPlan, trayLabel, verifyPinnedFeed, type FeedTray } from "./feedPlan";

/*
 * CRITICAL-03: the spool a Bambu start draws from is matched to the job's own
 * filaments — never "the first loaded tray", never a silent substitution.
 */

const tray = (trayId: number, material: string | null, over: Partial<FeedTray> = {}): FeedTray => ({
  trayId,
  external: trayId === 254,
  material,
  color: null,
  active: false,
  ...over
});

const one = (material: string | null, color: string | null = null) => ({
  filaments: [{ index: 0, material, color }],
  slotCount: 1
});

test("the tray holding the job's material wins over a loaded tray of another material", () => {
  const plan = resolveFeedPlan({
    hasAms: true,
    trays: [tray(0, "PLA", { active: true }), tray(2, "PETG")],
    requirement: one("PETG")
  });
  assert.equal(plan.kind, "ams");
  if (plan.kind !== "ams") return;
  assert.deepEqual(plan.mapping, [2]);
  assert.deepEqual(plan.mapping2, [{ ams_id: 0, slot_id: 2 }]);
  assert.equal(plan.assignments[0].how, "exact");
});

test("material matching is case/spacing-insensitive but not family-fuzzy on its own", () => {
  const exact = resolveFeedPlan({ hasAms: true, trays: [tray(1, "petg")], requirement: one("PETG") });
  assert.equal(exact.kind, "ams");
  const family = resolveFeedPlan({ hasAms: true, trays: [tray(1, "PETG-CF")], requirement: one("PETG") });
  assert.equal(family.kind, "unresolved", "a CF composite is not silently taken for plain PETG");
  assert.equal(family.kind === "unresolved" && family.code, "AMS_MATERIAL_MISMATCH");
  assert.match(family.kind === "unresolved" ? family.message : "", /можно выбрать явно/);
});

test("a colour named by the job breaks a tie between same-material trays", () => {
  const plan = resolveFeedPlan({
    hasAms: true,
    trays: [tray(0, "PLA", { color: "#FF0000" }), tray(1, "PLA", { color: "#000000" })],
    requirement: one("PLA", "#000000FF")
  });
  assert.equal(plan.kind === "ams" && plan.mapping[0], 1);
  assert.equal(plan.kind === "ams" && plan.assignments[0].how, "color");
});

test("the tray currently feeding breaks a remaining tie for a single-filament job", () => {
  const plan = resolveFeedPlan({
    hasAms: true,
    trays: [tray(0, "PLA"), tray(1, "PLA", { active: true })],
    requirement: one("PLA")
  });
  assert.equal(plan.kind === "ams" && plan.mapping[0], 1);
  assert.equal(plan.kind === "ams" && plan.assignments[0].how, "active");
});

test("an unbreakable tie is AMBIGUOUS and lists the trays to choose from", () => {
  const plan = resolveFeedPlan({ hasAms: true, trays: [tray(0, "PLA"), tray(1, "PLA")], requirement: one("PLA") });
  assert.equal(plan.kind, "unresolved");
  if (plan.kind !== "unresolved") return;
  assert.equal(plan.code, "AMS_SLOT_AMBIGUOUS");
  assert.deepEqual(plan.choices[0].trays.map((t) => t.trayId), [0, 1]);
});

test("an operator choice resolves the ambiguity — within the same material family only", () => {
  const trays = [tray(0, "PLA"), tray(1, "PLA-MATTE"), tray(2, "PETG")];
  const ok = resolveFeedPlan({ hasAms: true, trays, requirement: one("PLA"), choice: { 0: 1 } });
  assert.equal(ok.kind === "ams" && ok.mapping[0], 1);
  assert.equal(ok.kind === "ams" && ok.assignments[0].how, "operator");

  const wrong = resolveFeedPlan({ hasAms: true, trays, requirement: one("PLA"), choice: { 0: 2 } });
  assert.equal(wrong.kind === "unresolved" && wrong.code, "AMS_MATERIAL_MISMATCH");

  const missing = resolveFeedPlan({ hasAms: true, trays, requirement: one("PLA"), choice: { 0: 9 } });
  assert.equal(missing.kind === "unresolved" && missing.code, "AMS_MATERIAL_MISMATCH");
});

test("unknown job material is unresolved — the source is never guessed", () => {
  const plan = resolveFeedPlan({ hasAms: true, trays: [tray(0, "PLA")], requirement: one(null) });
  assert.equal(plan.kind === "unresolved" && plan.code, "AMS_MATERIAL_UNKNOWN");
});

test("an AMS printer with no tray report is AMS_STATE_UNKNOWN", () => {
  const plan = resolveFeedPlan({ hasAms: true, trays: null, requirement: one("PLA") });
  assert.equal(plan.kind === "unresolved" && plan.code, "AMS_STATE_UNKNOWN");
});

test("no AMS → the external spool; the material rule elsewhere judges it", () => {
  const plan = resolveFeedPlan({ hasAms: false, trays: [tray(254, "PETG")], requirement: one("PETG") });
  assert.equal(plan.kind, "external");
});

test("a job matched only to the external spool on an AMS printer feeds from it (use_ams off)", () => {
  const plan = resolveFeedPlan({
    hasAms: true,
    trays: [tray(0, "PLA"), tray(254, "TPU")],
    requirement: one("TPU")
  });
  assert.equal(plan.kind, "external");
});

test("mixed AMS + external feeding for one job is refused", () => {
  const plan = resolveFeedPlan({
    hasAms: true,
    trays: [tray(0, "PLA"), tray(254, "TPU")],
    requirement: {
      filaments: [
        { index: 0, material: "PLA", color: null },
        { index: 1, material: "TPU", color: null }
      ],
      slotCount: 2
    }
  });
  assert.equal(plan.kind === "unresolved" && plan.code, "AMS_FEED_UNSUPPORTED");
});

test("a multi-filament job maps each filament to its own tray, unused slots stay -1", () => {
  const plan = resolveFeedPlan({
    hasAms: true,
    trays: [tray(0, "PLA", { color: "#FFFFFF" }), tray(5, "PETG", { color: "#000000" })],
    requirement: {
      filaments: [
        { index: 0, material: "PLA", color: null },
        { index: 2, material: "PETG", color: null }
      ],
      slotCount: 3
    }
  });
  assert.equal(plan.kind, "ams");
  if (plan.kind !== "ams") return;
  assert.deepEqual(plan.mapping, [0, -1, 5]);
  assert.deepEqual(plan.mapping2, [
    { ams_id: 0, slot_id: 0 },
    { ams_id: 255, slot_id: 255 },
    { ams_id: 1, slot_id: 1 }
  ]);
});

test("tray ids of unverified unit layouts (AMS HT, 128+) are refused rather than sent", () => {
  const plan = resolveFeedPlan({ hasAms: true, trays: [tray(512, "PLA")], requirement: one("PLA") });
  assert.equal(plan.kind === "unresolved" && plan.code, "AMS_FEED_UNSUPPORTED");
});

test("a pinned plan is re-verified: a changed material or colour in the tray refuses", () => {
  const plan = resolveFeedPlan({
    hasAms: true,
    trays: [tray(1, "PETG", { color: "#112233" })],
    requirement: one("PETG")
  });
  assert.equal(verifyPinnedFeed(plan, [tray(1, "PETG", { color: "#112233" })], true), null);
  assert.match(verifyPinnedFeed(plan, [tray(1, "PLA", { color: "#112233" })], true) ?? "", /теперь PLA/);
  assert.match(verifyPinnedFeed(plan, [tray(1, "PETG", { color: "#FFFFFF" })], true) ?? "", /цвет/);
  assert.match(verifyPinnedFeed(plan, [], true) ?? "", /больше не виден/);
  assert.match(verifyPinnedFeed(plan, null, false) ?? "", /AMS больше не сообщается/);
});

test("trays are named the way an operator reads them", () => {
  assert.equal(trayLabel({ trayId: 2, external: false }), "AMS 1 · лоток 3");
  assert.equal(trayLabel({ trayId: 7, external: false }), "AMS 2 · лоток 4");
  assert.equal(trayLabel({ trayId: 254, external: true }), "внешняя катушка");
});

test("a multi-filament job never maps two filaments onto one tray by itself", () => {
  const trays = [tray(0, "PLA", { active: true }), tray(1, "PETG")];
  const plan = resolveFeedPlan({
    hasAms: true,
    trays,
    requirement: {
      filaments: [
        { index: 0, material: "PLA", color: null },
        { index: 1, material: "PLA", color: null }
      ],
      slotCount: 2
    }
  });
  assert.equal(plan.kind === "unresolved" && plan.code, "AMS_SLOT_AMBIGUOUS");
  // An operator may knowingly choose a one-spool print of a two-filament job.
  const chosen = resolveFeedPlan({
    hasAms: true,
    trays,
    requirement: {
      filaments: [
        { index: 0, material: "PLA", color: null },
        { index: 1, material: "PLA", color: null }
      ],
      slotCount: 2
    },
    choice: { 0: 0, 1: 0 }
  });
  assert.equal(chosen.kind === "ams" && chosen.mapping.join(","), "0,0");
});
