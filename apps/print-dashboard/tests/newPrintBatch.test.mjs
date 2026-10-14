import assert from "node:assert/strict";
import { test } from "node:test";

import { BATCH_RESETS, MAX_BATCH, batchCandidates, resolveBatchFlow, toggleBatchFile } from "../features/newprint/batch.js";
import { batchHtml } from "../features/newprint/batchView.js";
import { lastRecipeFor, resolveFlow } from "../features/newprint/model.js";
import { newPrintHtml } from "../features/newprint/view.js";

/*
 * «Новая печать» пакетом: несколько моделей — один принтер, один рецепт. Тот же
 * путь, те же решения сервера; пакет меняет только форму. И «как в прошлый
 * раз» — принтер и рецепт последней нарезки той же модели, если их ещё можно
 * выбрать.
 */

const ready = (verdict, over = {}) => ({ state: "ready", verdict, warnings: [], blockers: [], ...over });
const model = (id, name, next = { kind: "slice", explanation: "нарезать" }) => ({
  artifact: { id, name, kind: "model" },
  analysis: ready("needs_preparation", { detectedFormat: "stl" }),
  status: { executable: false, next }
});
const A = model("art_a", "a.stl");
const B = model("art_b", "b.stl");
const NEEDS_UNITS = model("art_u", "u.stl", { kind: "confirm_scale", explanation: "STL не хранит единицы" });
const GCODE = {
  artifact: { id: "art_g", name: "part.gcode", kind: "gcode" },
  analysis: ready("schedulable", { detectedFormat: "gcode" }),
  status: { executable: true, next: { kind: "enqueue", explanation: "В очередь" } }
};
const K2 = { printerId: "k2", printerName: "Creality K2", model: "Creality K2", printerClass: null };
const SETS = [{ id: "set_k2", name: "K2 · PETG", approved: true, validation: "valid", printerId: "k2", printerClass: null, warnings: [] }];
const out = (id, state = "ready", verdict = "schedulable") => ({
  artifact: { id, name: `${id}.gcode`, kind: "gcode" },
  analysis: { state, verdict, warnings: [], blockers: [] }
});
const data = (over = {}) => ({ items: [A, B, NEEDS_UNITS, GCODE], coverage: [K2], sets: SETS, variants: [], outputs: [], ...over });

const steps = (sel, d = data()) => Object.fromEntries(resolveBatchFlow(sel, d).steps.map((s) => [s.id, s.state]));

test("only models go into a batch, and at most as many as the server accepts", () => {
  assert.deepEqual(batchCandidates(data().items).map((i) => i.artifact.id), ["art_a", "art_b", "art_u"]);
  assert.deepEqual(toggleBatchFile(["art_a"], "art_b"), ["art_a", "art_b"]);
  assert.deepEqual(toggleBatchFile(["art_a", "art_b"], "art_a"), ["art_b"]);
  const full = Array.from({ length: MAX_BATCH }, (_, i) => `art_${i}`);
  assert.equal(toggleBatchFile(full, "one_more").length, MAX_BATCH);
});

test("the batch walks the same six steps: models → printer → recipe → slice → result → launch", () => {
  assert.equal(resolveBatchFlow({}, data()).current, "file");
  // Chosen but not confirmed — still choosing.
  assert.equal(resolveBatchFlow({ artifactIds: ["art_a", "art_b"] }, data()).current, "file");
  const base = { artifactIds: ["art_a", "art_b"], filesConfirmed: true };
  assert.equal(resolveBatchFlow(base, data()).current, "printer");
  assert.equal(resolveBatchFlow({ ...base, printerId: "k2" }, data()).current, "recipe");
  const recipe = { ...base, printerId: "k2", setId: "set_k2" };
  assert.equal(resolveBatchFlow(recipe, data()).current, "slice");

  const sliced = { ...recipe, batchId: "sbt_1", variants: { art_a: "v_a", art_b: "v_b" } };
  const running = data({ variants: [{ id: "v_a", state: "running" }, { id: "v_b", state: "ready", outputArtifactId: "o_b" }] });
  assert.equal(resolveBatchFlow(sliced, running).current, "slice", "still slicing — the step is not done");
  const done = data({
    variants: [
      { id: "v_a", state: "ready", outputArtifactId: "o_a" },
      { id: "v_b", state: "ready", outputArtifactId: "o_b" }
    ],
    outputs: [out("o_a"), out("o_b")]
  });
  const flow = resolveBatchFlow(sliced, done);
  assert.equal(flow.current, "result");
  assert.equal(flow.promotable.length, 2);
  assert.equal(resolveBatchFlow({ ...sliced, tasks: { v_a: "t_a", v_b: "t_b" }, queued: true }, done).current, "launch");
});

test("a selected model with something left to do (units) holds the batch on the first step and asks once for all", () => {
  const sel = { artifactIds: ["art_a", "art_u"], filesConfirmed: true };
  const flow = resolveBatchFlow(sel, data());
  assert.equal(flow.current, "file");
  assert.deepEqual(flow.needsUnits.map((i) => i.artifact.id), ["art_u"]);
  const html = batchHtml({ flow, data: data(), ui: {} });
  assert.match(html, /data-np-action="batch-units"/);
  assert.match(html, /data-np-action="batch-files-done"[^>]*disabled/);
  assert.match(html, /нужны единицы/);
});

test("the result: one row per model; a refused or failed model is named, the ready ones are queued together", () => {
  const sel = {
    artifactIds: ["art_a", "art_b"],
    filesConfirmed: true,
    printerId: "k2",
    setId: "set_k2",
    batchId: "sbt_1",
    variants: { art_a: "v_a" },
    refused: { art_b: "Артефакт не является исходной моделью" }
  };
  const d = data({ variants: [{ id: "v_a", state: "ready", outputArtifactId: "o_a", orcaEtaS: 600 }], outputs: [out("o_a")] });
  const flow = resolveBatchFlow(sel, d);
  assert.equal(flow.current, "result");
  const html = batchHtml({ flow, data: d, ui: {} });
  assert.match(html, /a\.stl/);
  assert.match(html, /G-code проверен/);
  assert.match(html, /b\.stl[\s\S]*не готова/);
  assert.match(html, /Поставить готовые в очередь \(1\)/);
  assert.doesNotMatch(html, /data-np-action="batch-promote"[^>]*disabled/);

  // A G-code still under analysis keeps the button shut — nothing unchecked is queued.
  const pending = data({ variants: [{ id: "v_a", state: "ready", outputArtifactId: "o_a" }], outputs: [out("o_a", "running", null)] });
  const waiting = batchHtml({ flow: resolveBatchFlow(sel, pending), data: pending, ui: {} });
  assert.match(waiting, /data-np-action="batch-promote"[^>]*disabled/);
});

test("after queuing, each print is launched on its own — and the earlier steps can no longer be changed", () => {
  const sel = {
    artifactIds: ["art_a"],
    filesConfirmed: true,
    printerId: "k2",
    setId: "set_k2",
    batchId: "sbt_1",
    variants: { art_a: "v_a" },
    tasks: { v_a: "task_a" },
    queued: true
  };
  const d = data({ variants: [{ id: "v_a", state: "ready", outputArtifactId: "o_a" }], outputs: [out("o_a")] });
  const html = batchHtml({ flow: resolveBatchFlow(sel, d), data: d, ui: {} });
  assert.match(html, /data-np-action="launch-task" data-id="task_a"/);
  assert.doesNotMatch(html, /data-np-action="edit"/);
});

test("changing the models keeps the selection but resets everything after it", () => {
  assert.equal("artifactIds" in BATCH_RESETS.file, false, "«Изменить» must not drop the chosen models");
  assert.equal(BATCH_RESETS.file.filesConfirmed, false);
  assert.equal(BATCH_RESETS.file.batchId, null);
});

test("«как в прошлый раз»: the printer and recipe of this model's last ready slice, while both can still be chosen", () => {
  const variants = [
    { id: "v_old", sourceArtifactId: "art_a", state: "ready", targetPrinterId: "k2", profileSetId: "set_k2", createdAt: "2026-10-01T00:00:00Z" },
    { id: "v_gone", sourceArtifactId: "art_a", state: "ready", targetPrinterId: "k2", profileSetId: "set_removed", createdAt: "2026-10-10T00:00:00Z" },
    { id: "v_failed", sourceArtifactId: "art_a", state: "failed", targetPrinterId: "k2", profileSetId: "set_k2", createdAt: "2026-10-12T00:00:00Z" }
  ];
  assert.deepEqual(lastRecipeFor("art_a", variants, SETS, [K2]), {
    printerId: "k2",
    setId: "set_k2",
    printerName: "Creality K2",
    setName: "K2 · PETG"
  });
  assert.equal(lastRecipeFor("art_b", variants, SETS, [K2]), null, "another model's slices say nothing");
  assert.equal(lastRecipeFor("art_a", variants, [], [K2]), null, "an unapproved recipe is not offered");

  const d = data({ variants });
  const html = newPrintHtml({ flow: resolveFlow({ artifactId: "art_a" }, d), data: d, ui: {} });
  assert.match(html, /data-np-action="same-as-last" data-printer="k2" data-set="set_k2"/);
  assert.match(html, /Как в прошлый раз: «Creality K2» · «K2 · PETG»/);
});

test("the single path offers the batch; the batch offers the way back", () => {
  const single = newPrintHtml({ flow: resolveFlow({}, data()), data: data(), ui: {} });
  assert.match(single, /data-np-action="mode-batch"/);
  const batch = batchHtml({ flow: resolveBatchFlow({}, data()), data: data(), ui: {} });
  assert.match(batch, /data-np-action="mode-single"/);
  assert.match(batch, /data-np-batch-toggle="art_a"/);
  assert.doesNotMatch(batch, /data-np-batch-toggle="art_g"/, "a G-code needs no slicing — it is not a batch model");
  assert.match(batch, /type="file" data-np-upload multiple/);
});
