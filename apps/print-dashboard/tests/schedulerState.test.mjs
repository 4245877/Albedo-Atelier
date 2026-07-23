import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeSchedulerState } from "../render/scheduler.js";

/*
 * Слияние состояния планировщика при частичном отказе (render/scheduler.js).
 * Ключевая гарантия: сбойный источник (отсутствующий в результате) НЕ затирает
 * ранее загруженные данные пустым массивом — оператор не видит ложной пустоты;
 * ошибка живёт отдельным полем и сбрасывается следующим успешным опросом.
 */

const PREV = {
  queue: [{ task: { id: "t1" } }],
  matrix: { printers: [{ id: "p1" }], rows: [{ title: "r" }] },
  plans: [{ id: "pl1" }],
  plan: { plan: { id: "pl1" } },
  night: { window: "22:00–06:00" },
  loaded: true,
  error: null
};

test("a partial error keeps the last successful data instead of emptying it", () => {
  // queue-запрос упал (отсутствует в out), остальное пришло свежим.
  const out = {
    matrix: { printers: [], rows: [] },
    plans: [],
    plan: null,
    night: null,
    errors: [new Error("queue 500")]
  };
  const next = mergeSchedulerState(PREV, out);

  assert.deepEqual(next.queue, PREV.queue, "прежняя очередь сохранена, а не обнулена");
  assert.deepEqual(next.matrix, { printers: [], rows: [] }, "свежая матрица применена");
  assert.equal(next.error, "queue 500", "ошибка показана отдельно от данных");
  assert.equal(next.loaded, true);
});

test("a source missing from the result keeps its previous value", () => {
  // Ничего свежего (все источники сбойны/отсутствуют) — всё прежнее сохраняется.
  const next = mergeSchedulerState(PREV, { errors: [] });
  assert.deepEqual(next.queue, PREV.queue);
  assert.deepEqual(next.matrix, PREV.matrix);
  assert.deepEqual(next.plans, PREV.plans);
  assert.deepEqual(next.plan, PREV.plan);
  assert.deepEqual(next.night, PREV.night);
});

test("a fully successful poll refreshes data and clears the error", () => {
  const withError = { ...PREV, error: "queue 500" };
  const out = {
    queue: [{ task: { id: "t2" } }],
    matrix: { printers: [{ id: "p2" }], rows: [] },
    plans: [{ id: "pl2" }],
    plan: { plan: { id: "pl2" } },
    night: { window: "23:00–05:00" },
    errors: []
  };
  const next = mergeSchedulerState(withError, out);

  assert.deepEqual(next.queue, out.queue, "данные обновлены");
  assert.equal(next.error, null, "состояние ошибки сброшено после успеха");
});

test("night can legitimately become null (no window) without being treated as an error", () => {
  const out = { queue: PREV.queue, matrix: PREV.matrix, plans: PREV.plans, plan: PREV.plan, night: null, errors: [] };
  const next = mergeSchedulerState(PREV, out);
  assert.equal(next.night, null, "явный null применяется");
  assert.equal(next.error, null);
});
