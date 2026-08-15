/* ── Регресс P0: причины блокировки должны быть видимыми ────────
   Найденный дефект: вердикт стоял чипом, а ПРИЧИНА жила только в `title="…"`.
   На телефоне и планшете подсказки по наведению не существует вовсе — то есть
   ответ на единственный важный вопрос («почему заблокировано?») был физически
   недоступен на устройстве, с которого чаще всего смотрят ферму. С клавиатуры
   до него тоже было не добраться. */

import assert from "node:assert/strict";
import test from "node:test";

import { compatibilityHtml } from "../features/scheduler/view.js";

const state = (over = {}) => ({
  matrix: {
    printers: [{ id: "k2", name: "Creality K2" }, { id: "a1", name: "Bambu A1" }],
    rows: [
      {
        taskId: "t1",
        title: "gear-housing",
        results: [
          {
            printerId: "k2",
            verdict: "blocked",
            blockers: [{ message: "MicroSD не отвечает" }, { message: "не хватает 90 г PLA" }],
            reviews: [{ message: "нет истории печати профиля" }],
            warnings: [{ message: "стол давно не калиброван" }],
            eta: null
          },
          { printerId: "a1", verdict: "compatible", blockers: [], reviews: [], warnings: [], eta: { seconds: 5340 } }
        ]
      }
    ]
  },
  ...over
});

test("первая причина видна прямо в ячейке, а не только в title", () => {
  const html = compatibilityHtml(state());
  assert.match(html, /class="mx-reason">MicroSD не отвечает</, "первая причина — видимый текст");
});

test("ячейка с причиной доступна с клавиатуры и пальцем", () => {
  const html = compatibilityHtml(state());
  assert.match(html, /<button type="button" class="mx-cell"/, "ячейка — настоящая кнопка");
  assert.match(html, /aria-expanded="false"/, "состояние раскрытия объявлено");
});

test("остальные причины пересчитаны, а не потеряны", () => {
  const html = compatibilityHtml(state());
  // Всего 4 причины: 2 блокера + 1 замечание + 1 предупреждение → «ещё 3».
  assert.match(html, /class="mx-more">ещё 3</);
});

test("подробности разложены на блокеры, замечания и предупреждения", () => {
  const html = compatibilityHtml(state());
  assert.match(html, /Блокеры/);
  assert.match(html, /Замечания/);
  assert.match(html, /Предупреждения/);
  assert.match(html, /не хватает 90 г PLA/, "второй блокер доступен в раскрытии");
  assert.match(html, /стол давно не калиброван/, "предупреждение тоже доступно");
});

test("title остаётся дополнительным источником, но уже не единственным", () => {
  const html = compatibilityHtml(state());
  assert.match(html, /title="MicroSD не отвечает · не хватает 90 г PLA/, "подсказка мышью сохранена");
});

test("совместимая ячейка без причин не превращается в кнопку впустую", () => {
  const html = compatibilityHtml(state());
  const cells = html.match(/class="mx-cell"/g) || [];
  assert.equal(cells.length, 1, "кнопка только там, где есть что раскрывать");
});

test("раскрытие строки помнится между перерисовками опроса", () => {
  const expanded = compatibilityHtml(state({ expandedMatrix: new Set(["t1"]) }));
  assert.doesNotMatch(expanded, /<tr class="mx-detail" data-detail="t1" hidden>/,
    "раскрытая строка остаётся раскрытой после тика опроса");

  const collapsed = compatibilityHtml(state());
  assert.match(collapsed, /<tr class="mx-detail" data-detail="t1" hidden>/);
});

test("имя задания — заголовок строки таблицы, а не рядовая ячейка", () => {
  const html = compatibilityHtml(state());
  assert.match(html, /<th scope="row" class="sch-cell-task">gear-housing<\/th>/);
  assert.match(html, /<th scope="col">Creality K2<\/th>/);
});
