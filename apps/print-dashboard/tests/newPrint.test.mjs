import assert from "node:assert/strict";
import { test } from "node:test";

import { fileHold, fileKind, printerChoices, recipesFor, resolveFlow, variantPromotable } from "../features/newprint/model.js";
import { newPrintHtml, stepsHtml } from "../features/newprint/view.js";

/*
 * «Новая печать» — один путь вместо четырёх разделов:
 *   Файл → Принтер → Рецепт → Слайсинг → Результат → Запуск.
 * Модель только читает ответы сервера (анализ, рецепты, вариант, задание) и
 * решает, какой шаг сейчас; правила допуска — на сервере. Проверяем, что путь
 * ведёт туда, куда должен, и не предлагает шагов, которых нет.
 */

const ready = (verdict, over = {}) => ({ state: "ready", verdict, warnings: [], blockers: [], ...over });

const STL = {
  artifact: { id: "art_stl", name: "cube.stl", kind: "model" },
  analysis: ready("needs_preparation", { detectedFormat: "stl" }),
  status: { executable: false, next: { kind: "slice", explanation: "Это модель — её нужно нарезать", taskId: "task_stl" } },
  task: { id: "task_stl", state: "DRAFT" }
};
const UNCONFIRMED_STL = {
  ...STL,
  status: { executable: false, next: { kind: "confirm_scale", explanation: "STL не хранит единицы", taskId: "task_stl" } }
};
const GCODE = {
  artifact: { id: "art_g", name: "part.gcode", kind: "gcode" },
  analysis: ready("schedulable", { detectedFormat: "gcode" }),
  status: { executable: true, next: { kind: "enqueue", explanation: "В очередь", taskId: "task_g" } },
  task: { id: "task_g", state: "DRAFT" }
};
const ANALYSING = { artifact: { id: "art_w", name: "wip.3mf" }, analysis: { state: "running" }, status: { next: { kind: "wait", explanation: "анализ" } } };

const K2 = { printerId: "creality-k2", printerName: "Creality K2", model: "Creality K2", printerClass: "K2-Farm" };
const A1 = { printerId: "bambu-a1", printerName: "Bambu Lab A1", model: "Bambu Lab A1", printerClass: null };

const SETS = [
  { id: "set_k2", name: "K2 · PETG", approved: true, validation: "valid", printerId: "creality-k2", printerClass: null, warnings: [] },
  { id: "set_class", name: "K2 farm · PLA", approved: true, validation: "warnings", printerId: null, printerClass: " k2-farm ", warnings: [{ message: "x" }] },
  { id: "set_draft", name: "черновик", approved: false, validation: "valid", printerId: "creality-k2", printerClass: null },
  { id: "set_blocked", name: "сломан", approved: true, validation: "blocked", printerId: "creality-k2", printerClass: null }
];

const data = (over = {}) => ({ items: [STL, UNCONFIRMED_STL, GCODE, ANALYSING], coverage: [K2, A1], sets: SETS, variants: [], outputs: [], ...over });

test("the file decides the path: a model is sliced, a G-code goes as it is, an unread file waits", () => {
  assert.equal(fileKind(STL), "model");
  assert.equal(fileKind(GCODE), "print");
  assert.equal(fileKind(ANALYSING), null);
  assert.equal(fileHold(UNCONFIRMED_STL)?.kind, "confirm_scale");
  assert.equal(fileHold(STL), null);
});

test("recipes for a printer: approved and not blocked, bound to it or to its class (as the server compares)", () => {
  assert.deepEqual(recipesFor(SETS, K2).map((s) => s.id), ["set_k2", "set_class"]);
  assert.deepEqual(recipesFor(SETS, A1), []);
  const choices = printerChoices([K2, A1], SETS, "model");
  assert.deepEqual(choices.map((c) => [c.printerId, c.recipes, c.usable]), [["creality-k2", 2, true], ["bambu-a1", 0, false]]);
  // A G-code needs no recipe: every printer is a candidate (the launch window judges it).
  assert.ok(printerChoices([K2, A1], SETS, "print").every((c) => c.usable));
});

test("the flow walks the six steps in order for a model", () => {
  const states = (sel, d = data()) => Object.fromEntries(resolveFlow(sel, d).steps.map((s) => [s.id, s.state]));
  assert.deepEqual(states({}), { file: "current", printer: "todo", recipe: "todo", slice: "todo", result: "todo", launch: "todo" });
  // A model whose units nobody stated is still on the file step.
  assert.equal(resolveFlow({ artifactId: "art_stl" }, data({ items: [UNCONFIRMED_STL] })).current, "file");
  assert.equal(resolveFlow({ artifactId: "art_stl" }, data()).current, "printer");
  // A printer with no recipe cannot be passed for a model.
  assert.equal(resolveFlow({ artifactId: "art_stl", printerId: "bambu-a1" }, data()).current, "printer");
  assert.equal(resolveFlow({ artifactId: "art_stl", printerId: "creality-k2" }, data()).current, "recipe");
  const sel = { artifactId: "art_stl", printerId: "creality-k2", setId: "set_k2" };
  assert.equal(resolveFlow(sel, data()).current, "slice");
  const running = data({ variants: [{ id: "v1", state: "running", sourceArtifactId: "art_stl" }] });
  assert.equal(resolveFlow({ ...sel, variantId: "v1" }, running).current, "slice");
  const done = data({ variants: [{ id: "v1", state: "ready", outputArtifactId: "out" }] });
  assert.equal(resolveFlow({ ...sel, variantId: "v1" }, done).current, "result");
  assert.equal(resolveFlow({ ...sel, variantId: "v1", taskId: "task_stl" }, done).current, "launch");
});

test("a variant from an earlier print is never picked up by itself — only the one sliced on this path", () => {
  const old = data({ variants: [{ id: "old", state: "ready", sourceArtifactId: "art_stl", profileSetId: "set_k2", targetPrinterId: "creality-k2", outputArtifactId: "o" }] });
  const flow = resolveFlow({ artifactId: "art_stl", printerId: "creality-k2", setId: "set_k2" }, old);
  assert.equal(flow.variant, null);
  assert.equal(flow.current, "slice");
});

test("an already-sliced file skips recipe, slicing and result", () => {
  const flow = resolveFlow({ artifactId: "art_g", printerId: "bambu-a1" }, data());
  assert.deepEqual(
    flow.steps.map((s) => [s.id, s.state]),
    [["file", "done"], ["printer", "done"], ["recipe", "skipped"], ["slice", "skipped"], ["result", "skipped"], ["launch", "current"]]
  );
  const html = newPrintHtml({ flow, data: data(), ui: {} });
  assert.match(html, /Поставить в очередь и запустить/);
  assert.match(html, /Ручная печать не требует утверждать план/);
  assert.doesNotMatch(html, /data-np-step="recipe"/);
});

test("promotion is offered only for a ready variant whose G-code the server verified", () => {
  const v = { id: "v1", state: "ready", outputArtifactId: "out" };
  assert.equal(variantPromotable(v, ready("schedulable")), true);
  assert.equal(variantPromotable(v, ready("review")), false);
  assert.equal(variantPromotable(v, { state: "running" }), false);
  assert.equal(variantPromotable({ ...v, state: "failed" }, ready("schedulable")), false);
});

test("the page explains what is missing in place: units, a missing recipe, technical settings elsewhere", () => {
  const units = newPrintHtml({ flow: resolveFlow({ artifactId: "art_stl" }, data({ items: [UNCONFIRMED_STL] })), data: data(), ui: {} });
  assert.match(units, /data-np-units/);
  assert.match(units, /Подтвердить единицы/);

  const noRecipe = newPrintHtml({ flow: resolveFlow({ artifactId: "art_stl" }, data()), data: data(), ui: {} });
  assert.match(noRecipe, /нет утверждённого рецепта/);
  assert.match(noRecipe, /data-goto="slicing"/);
  // Technical sections are links out of the path, not steps of it.
  assert.match(noRecipe, /data-goto="scheduler"/);
});

test("after the job is queued, earlier steps cannot be edited — a second print starts afresh", () => {
  const done = data({ variants: [{ id: "v1", state: "ready", outputArtifactId: "out" }] });
  const flow = resolveFlow({ artifactId: "art_stl", printerId: "creality-k2", setId: "set_k2", variantId: "v1", taskId: "t" }, done);
  const html = newPrintHtml({ flow, data: done, ui: {} });
  assert.doesNotMatch(html, /data-np-action="edit"/);
  assert.match(html, /Начать новую печать/);
  assert.match(stepsHtml(flow), /aria-current="step"/);
});

test("шаг «Принтер»: рядом с каждым принтером — что он делает сейчас", async () => {
  const { printerStateNote } = await import("../features/newprint/model.js");
  assert.equal(printerStateNote(null), null);
  assert.deepEqual(printerStateNote({ status: "printing" }), { text: "печатает", tone: "info" });
  assert.deepEqual(printerStateNote({ status: "offline" }), { text: "нет связи", tone: "warn" });
  assert.deepEqual(printerStateNote({ status: "error" }), { text: "ошибка на принтере", tone: "error" });
  // `idle` — не «свободен», когда сервер говорит, что деталь ещё на столе.
  assert.deepEqual(
    printerStateNote({ status: "idle", readiness: { state: "needs_clearance", canAcceptJob: false, label: "Ждёт снятия детали" } }),
    { text: "Ждёт снятия детали", tone: "warn" }
  );
  assert.deepEqual(printerStateNote({ status: "idle", readiness: { state: "ready", canAcceptJob: true, label: "Готов" } }), { text: "свободен", tone: "ok" });
  assert.deepEqual(printerStateNote({ status: "idle" }), { text: "свободен", tone: "ok" }, "старый backend без readiness");
});
