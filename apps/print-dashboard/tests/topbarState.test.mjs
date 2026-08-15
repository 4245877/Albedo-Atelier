/* ── Регресс: шапка врала о связи на первом кадре ──────────────
   Найденный дефект — того же рода, что и зелёный статус у заблокированного
   задания, только в шапке, и врал он ДВАЖДЫ подряд:

     1. разметка index.html утверждала зелёным «Backend подключён» и «Сервис
        работает» ещё до единого запроса — то есть панель ручалась за связь,
        о которой ничего не знала;
     2. первый же вызов renderTopbar(null, false) красил шапку в тревожное
        «Backend безмолвствует» — хотя запрос был всего лишь НЕ ЗАВЕРШЁН. На
        медленном backend оператор несколько секунд смотрел на отказ, которого
        не было.

   Правило, которое эти тесты защищают: молчание и неизвестность — разные
   состояния. Пока первого ответа нет, шапка говорит «проверяю». */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderTopbar } from "../render/sections.js";

/** Подменяет две пилюли шапки и возвращает их состояние после отрисовки. */
function paint(state, reachable, opts) {
  const nodes = {};
  for (const id of ["#pill-service", "#pill-backend"]) {
    nodes[id] = { className: "", innerHTML: "", title: "" };
  }
  const prev = globalThis.document;
  globalThis.document = { querySelector: (sel) => nodes[sel] || null };
  try {
    renderTopbar(state, reachable, opts);
  } finally {
    globalThis.document = prev;
  }
  return nodes;
}

const OK_STATE = { service: { status: "ok", version: "v0.1.0" } };

test("до первого ответа шапка не утверждает ни связи, ни её отсутствия", () => {
  const { "#pill-backend": backend, "#pill-service": service } = paint(null, false, { settled: false });

  assert.doesNotMatch(backend.className, /pill-danger/, "незавершённый запрос — не отказ");
  assert.doesNotMatch(backend.className, /pill-ok/, "и не подтверждение связи");
  assert.match(backend.innerHTML, /Проверяю связь/);
  assert.doesNotMatch(service.className, /pill-ok|pill-danger/);
  assert.match(service.innerHTML, /Опрашиваю ферму/);
});

test("настоящий отказ по-прежнему красит шапку тревогой", () => {
  const { "#pill-backend": backend, "#pill-service": service } = paint(null, false, { settled: true });

  assert.match(backend.className, /pill-danger/);
  assert.match(backend.innerHTML, /Backend безмолвствует/);
  assert.match(service.className, /pill-warn/);
});

test("удачный ответ даёт зелёную связь", () => {
  const { "#pill-backend": backend, "#pill-service": service } = paint(OK_STATE, true, { settled: true });

  assert.match(backend.className, /pill-ok/);
  assert.match(backend.innerHTML, /Backend подключён/);
  assert.match(service.className, /pill-ok/);
  assert.match(service.innerHTML, /Служба безупречна/);
});

test("отказ после удачной загрузки не прячется за «проверяю»", () => {
  // settled уже true и состояние есть — связь оборвалась по-настоящему.
  const { "#pill-backend": backend } = paint(OK_STATE, false, { settled: true });
  assert.match(backend.className, /pill-danger/);
});

test("вызов без опций (совместимость) считает состояние определившимся", () => {
  const { "#pill-backend": backend } = paint(OK_STATE, true);
  assert.match(backend.className, /pill-ok/);
});

test("разметка первого кадра не ручается за связь зелёным", () => {
  const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  const topbar = html.slice(html.indexOf("<header"), html.indexOf("</header>"));

  assert.doesNotMatch(topbar, /id="pill-backend"[^>]*class="[^"]*pill-ok/, "зелёная связь до запроса недопустима");
  assert.doesNotMatch(topbar, /class="pill pill-ok" id="pill-/, "ни одна пилюля шапки не зелёная в разметке");
  assert.match(topbar, /id="pill-backend"/, "сама пилюля на месте");
  assert.match(topbar, /Проверяю связь/, "начальная подпись честно говорит о неизвестности");
});
