/* ── Регресс: границы очереди в Зале ───────────────────────────
   Найденный дефект: список очереди рисовался целиком, сколько бы заданий в
   ней ни было. На 200 заданиях одна только очередь занимала ~19 600 px
   (≈ 26 экранов на 1440), и всё, ради чего Зал существует, — ночная карточка,
   критические события, материалы, показатели — уезжало за горизонт прокрутки.

   Правило, которое эти тесты защищают: Зал показывает ближайшие задания, а
   хвост НАЗЫВАЕТ себя числом и уводит в Планировщик. Скрытое не пропадает из
   внимания: строка отдельно считает, сколько из скрытого требует вмешательства. */

import assert from "node:assert/strict";
import test from "node:test";

import { QUEUE_VISIBLE_LIMIT, plural, queueOverflow, renderQueue } from "../render/sections.js";

const job = (i, extra = {}) => ({ id: `q${i}`, title: `Задание ${i}`, status: "ready", ...extra });
const queueOf = (n, extra = () => ({})) => Array.from({ length: n }, (_, i) => job(i, extra(i)));

/** renderQueue пишет в DOM — подменяем ровно те узлы, которых он касается. */
function renderToString(state) {
  const out = {};
  const stubs = {
    "#queue-meta": { set textContent(v) { out.meta = v; } },
    "#queue-body": { set innerHTML(v) { out.body = v; } }
  };
  const prev = globalThis.document;
  globalThis.document = { querySelector: (sel) => stubs[sel] || null };
  try {
    renderQueue(state);
  } finally {
    globalThis.document = prev;
  }
  return out;
}

test("очередь короче предела не порождает никакого хвоста", () => {
  for (const n of [0, 1, 3, QUEUE_VISIBLE_LIMIT]) {
    assert.equal(queueOverflow(queueOf(n)), null, `${n} заданий должны помещаться целиком`);
  }
});

test("хвост появляется ровно на первом лишнем задании и считает его", () => {
  const over = queueOverflow(queueOf(QUEUE_VISIBLE_LIMIT + 1));
  assert.deepEqual(over, { hidden: 1, blocked: 0 });
});

test("скрытые задания, требующие вмешательства, посчитаны отдельно", () => {
  // Заблокированные стоят в хвосте — именно их нельзя дать потерять из виду.
  const queue = queueOf(50, (i) => (i >= 20 && i % 5 === 0 ? { reason: "нет файла на принтере" } : {}));
  const over = queueOverflow(queue);
  assert.equal(over.hidden, 50 - QUEUE_VISIBLE_LIMIT);
  assert.equal(over.blocked, 6, "20,25,30,35,40,45 — шесть заблокированных за пределом показа");
});

test("Зал рисует не больше предела строк, а хвост называет число и ведёт в планировщик", () => {
  const { body, meta } = renderToString({ printers: [], queue: queueOf(200) });

  // Считаем сами строки списка: в разметке есть ещё пустое состояние колонки
  // «сейчас печатается», строка хвоста и карточка «ближайшее к запуску».
  const shown = (body.match(/<li class="row[\s\S]*?<\/li>/g) || [])
    .filter((li) => /row-title">Задание \d+</.test(li));
  assert.ok(shown.length <= QUEUE_VISIBLE_LIMIT,
    `в Зале не может быть 200 строк очереди, найдено ${shown.length}`);
  assert.equal(shown.length, QUEUE_VISIBLE_LIMIT, "ближайшие задания показаны целиком");
  assert.match(body, /row-more/, "хвост очереди показан отдельной строкой");
  assert.match(body, /Ещё 192 задания/, "хвост назван точным числом");
  assert.match(body, /data-goto="scheduler"/, "хвост ведёт туда, где очередью управляют");
  assert.match(meta, /200 в очереди/, "полный размер очереди по-прежнему честно назван в шапке");
});

test("хвост сообщает, сколько скрытых заданий требует внимания", () => {
  const queue = queueOf(12, (i) => (i === 10 ? { reason: "MicroSD не отвечает" } : {}));
  const { body } = renderToString({ printers: [], queue });
  assert.match(body, /Из них 1 требует внимания/);
});

test("на границе предела строка хвоста не рисуется вовсе", () => {
  const { body } = renderToString({ printers: [], queue: queueOf(QUEUE_VISIBLE_LIMIT) });
  assert.doesNotMatch(body, /row-more/);
});

test("пустая очередь по-прежнему даёт честное пустое состояние, а не хвост", () => {
  const { body } = renderToString({ printers: [], queue: [] });
  assert.match(body, /Очередь пуста/);
  assert.doesNotMatch(body, /row-more/);
});

test("склонение по числу заданий", () => {
  const f = (n) => plural(n, "задание", "задания", "заданий");
  assert.equal(f(1), "задание");
  assert.equal(f(2), "задания");
  assert.equal(f(5), "заданий");
  assert.equal(f(11), "заданий");
  assert.equal(f(21), "задание");
  assert.equal(f(112), "заданий");
  assert.equal(f(192), "задания");
});
