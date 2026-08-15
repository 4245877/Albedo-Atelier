/* ── Регресс P0: ложный статус задания ─────────────────────────
   Найденный дефект: задание с `status: "ready"` И блокирующей причиной
   («MicroSD не отвечает — файл не удалось записать») показывалось зелёным
   «готово к запуску», причина уходила в приглушённую подпись через тире, а
   рядом стояла заметная кнопка запуска. Оператор видел зелёное и жал запуск,
   который был невозможен изначально.

   Правило, которое эти тесты защищают: видимый статус объекта определяется
   САМЫМ СЕРЬЁЗНЫМ его актуальным состоянием. */

import assert from "node:assert/strict";
import test from "node:test";

import { queueJobStatus, queueRow, renderQueue } from "../render/sections.js";

const printers = [{ id: "k2", name: "Creality K2 Plus" }];

test("«готово» с блокирующей причиной перестаёт быть готовым", () => {
  const st = queueJobStatus({
    id: "t1",
    status: "ready",
    reason: "MicroSD не отвечает — файл не удалось записать на принтер"
  });

  assert.equal(st.blocked, true, "задание не может считаться запускаемым");
  assert.notEqual(st.badge, "badge-idle", "зелёный бейдж готовности недопустим");
  assert.equal(st.badge, "badge-blocked");
  assert.match(st.label, /требует внимания/);
  assert.match(st.reason, /MicroSD/, "причина сохранена целиком");
});

test("зелёное «готово к запуску» остаётся только у по-настоящему готового", () => {
  const st = queueJobStatus({ id: "t2", status: "ready" });
  assert.equal(st.blocked, false);
  assert.equal(st.badge, "badge-idle");
  assert.match(st.label, /готово к запуску/);
  assert.equal(st.reason, "");
});

test("пустая или пробельная причина не превращает готовое в заблокированное", () => {
  for (const reason of ["", "   ", null, undefined]) {
    const st = queueJobStatus({ id: "t3", status: "ready", reason });
    assert.equal(st.blocked, false, `reason=${JSON.stringify(reason)} не должен блокировать`);
  }
});

test("причина рисуется отдельной заметной строкой, а не хвостом подписи", () => {
  const html = queueRow(
    { id: "t1", status: "ready", title: "gear.3mf", printer: "k2", reason: "MicroSD не отвечает" },
    printers
  );

  assert.match(html, /class="row-reason"/, "у причины своя строка");
  // Прежняя разметка приклеивала причину к .row-sub через « — ».
  assert.doesNotMatch(html, /row-sub">[^<]*— MicroSD/, "причина больше не хвост приглушённой подписи");
  assert.match(html, /row-blocked/, "строка помечена как заблокированная");
});

test("у заблокированного задания действие ведёт разбираться, а не запускать", () => {
  const html = queueRow(
    { id: "t1", status: "ready", title: "gear.3mf", reason: "MicroSD не отвечает" },
    printers
  );
  assert.match(html, /data-act="launch"/, "кнопка ведёт в окно запуска-разбора");
  assert.doesNotMatch(html, />Запустить печать</, "но НЕ обещает запуск");
  assert.match(html, />Разобраться</);
});

test("статусы review и unconfirmed сохраняют свою семантику и свои причины", () => {
  const review = queueJobStatus({ id: "r", status: "review" });
  assert.equal(review.blocked, true);
  assert.equal(review.badge, "badge-paused");

  const unconfirmed = queueJobStatus({ id: "u", status: "unconfirmed" });
  assert.equal(unconfirmed.blocked, true);
  assert.equal(unconfirmed.badge, "badge-amethyst");
  assert.match(unconfirmed.actionLabel, /Разобраться с запуском/);
  assert.ok(unconfirmed.reason.length > 0, "у неподтверждённого всегда есть объяснение");
});

test("главной кнопкой раздела становится только реально запускаемое задание", () => {
  // Первое в очереди «готово», но заблокировано; второе — действительно готово.
  const calls = {};
  const state = {
    printers: [],
    queue: [
      { id: "blocked", status: "ready", title: "a.3mf", reason: "MicroSD не отвечает" },
      { id: "fine", status: "ready", title: "b.3mf" }
    ]
  };
  // renderQueue пишет в DOM — подменяем ровно те узлы, которых он касается.
  const stubs = { "#queue-meta": { set textContent(v) { calls.meta = v; } }, "#queue-body": { set innerHTML(v) { calls.body = v; } } };
  const doc = { querySelector: (sel) => stubs[sel] || null };
  const prevDoc = globalThis.document;
  globalThis.document = doc;
  try {
    renderQueue(state);
  } finally {
    globalThis.document = prevDoc;
  }

  assert.match(calls.body, /data-task="fine"[\s\S]*Запустить печать|Запустить печать[\s\S]*data-task="fine"/,
    "карточка «ближайшее к запуску» указывает на незаблокированное задание");
  assert.doesNotMatch(
    calls.body,
    /class="next-job"[\s\S]*data-task="blocked"[\s\S]*Запустить печать/,
    "заблокированное задание не становится главной кнопкой раздела"
  );
});
