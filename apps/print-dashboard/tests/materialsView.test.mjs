/* ── Регресс: «учёт не подключён» вместо остатков ───────────────
   Найденный дефект: секция «Материалы» всегда показывала «учёт не подключён»
   и «Остатки материалов мне пока неведомы», потому что backend отдавал
   filament: []. После подключения склада fulfillment у секции появилось
   четыре РАЗНЫХ положения дел, и главное правило этих тестов:

   пустая полка, ненастроенный склад и молчащий склад — три разные вещи,
   и ни одна из них не смеет выглядеть как другая. */

import assert from "node:assert/strict";
import test from "node:test";

import { renderMaterials } from "../render/sections.js";

function source(over = {}) {
  return {
    kind: "fulfillment",
    ok: true,
    pending: false,
    stale: false,
    updatedAt: "2026-08-17T12:00:00.000Z",
    error: null,
    ...over
  };
}

function materials(over = {}) {
  return {
    filament: [],
    resin: [],
    mismatch: [],
    queueNeeds: [],
    loaded: [],
    source: source(),
    ...over
  };
}

const PETG = {
  name: "PETG Чорний",
  swatch: "#26262b",
  have: 9.47,
  unit: "кг",
  full: 1,
  low: false,
  status: "ok",
  grams: 9469
};

const TPU = {
  name: "TPU Чорний",
  swatch: "#26262b",
  have: 0,
  unit: "кг",
  full: 1,
  low: true,
  status: "critical",
  grams: 0
};

function renderToString(state) {
  const out = {};
  const stubs = {
    "#materials-meta": { set textContent(v) { out.meta = v; } },
    "#materials-body": { set innerHTML(v) { out.body = v; } }
  };
  const prev = globalThis.document;
  globalThis.document = { querySelector: (sel) => stubs[sel] || null };
  try {
    renderMaterials({ printers: [], ...state });
  } finally {
    globalThis.document = prev;
  }
  return out;
}

test("остатки со склада наконец рисуются, а не подменяются заглушкой", () => {
  const out = renderToString({ materials: materials({ filament: [PETG, TPU] }) });

  assert.match(out.body, /PETG Чорний/);
  assert.match(out.body, /9\.47 кг/);
  assert.doesNotMatch(out.body, /учёт склада ещё не подключён/);
  assert.equal(out.meta, "1 заканчиваются");
});

test("полка в норме говорит именно это, а не молчит числом", () => {
  const out = renderToString({ materials: materials({ filament: [PETG] }) });
  assert.equal(out.meta, "остатки в норме");
});

test("нулевая позиция читается как критическая, а не как «мало»", () => {
  // При 0 кг полоса схлопывается в scaleX(0) и её цвет не виден — сигнал несёт
  // только число, поэтому оно обязано быть в критическом тоне.
  const out = renderToString({ materials: materials({ filament: [TPU] }) });

  assert.match(out.body, /class="mat-item mat-low mat-crit"/);
  assert.match(out.body, /class="level mat-level crit"/);
});

test("цвет уровня берётся из вердикта склада, а не из доли остатка", () => {
  // 0 кг при пороге 1 кг: доля = 0, и старая эвристика тоже дала бы crit —
  // поэтому проверяем обратный случай: склад назвал позицию low при доле 1.0.
  const full = { ...PETG, status: "low", low: true };
  const out = renderToString({ materials: materials({ filament: [full] }) });

  assert.match(out.body, /class="level mat-level low"/, "вердикт склада важнее доли");
  assert.doesNotMatch(out.body, /class="level mat-level crit"/);
});

test("ненастроенный склад признаётся прямо и называет переменную", () => {
  const out = renderToString({ materials: materials({ source: source({ kind: "none", ok: false }) }) });

  assert.equal(out.meta, "учёт не подключён");
  assert.match(out.body, /FULFILLMENT_API_URL/);
});

test("молчащий склад — это НЕ пустая полка: причина названа", () => {
  const out = renderToString({
    materials: materials({ source: source({ ok: false, error: "склад вернул 502" }) })
  });

  assert.equal(out.meta, "склад безмолвствует");
  assert.match(out.body, /склад вернул 502/);
  assert.doesNotMatch(out.body, /не подключён/, "выключенная интеграция и обрыв связи — разные беды");
});

test("настоящая пустая полка не притворяется обрывом связи", () => {
  const out = renderToString({ materials: materials() });

  assert.match(out.body, /полки пусты/);
  assert.doesNotMatch(out.body, /безмолвствует/);
});

test("устаревшие остатки показываются, но с оговоркой", () => {
  const out = renderToString({
    materials: materials({ filament: [PETG], source: source({ stale: true }) })
  });

  assert.equal(out.meta, "данные склада устарели");
  assert.match(out.body, /9\.47 кг/, "последние известные цифры не прячем");
  assert.match(out.body, /последние известные остатки/, "но и за свежую правду не выдаём");
});

test("колонка «Смола» не рисуется, пока склад её не ведёт", () => {
  const out = renderToString({ materials: materials({ filament: [PETG] }) });

  assert.doesNotMatch(out.body, /Смола/, "пустая колонка читалась бы как «смолы нет»");
  assert.match(out.body, /Филамент/);
});

test("заправка берётся со склада, когда он знает привязку катушки", () => {
  const out = renderToString({
    printers: [{ id: "k2", name: "Creality K2", material: "PLA", swatch: "#fff" }],
    materials: materials({
      filament: [PETG],
      loaded: [
        {
          printer: "Creality K2",
          slot: "AMS-слот 1",
          material: "PETG",
          colorName: "Чорний",
          swatch: "#26262b",
          updatedAt: "2026-07-13T14:11:05.266Z"
        }
      ]
    })
  });

  assert.match(out.body, /В принтерах \(по складу\)/);
  assert.match(out.body, /Creality K2 · AMS-слот 1: PETG Чорний/);
  assert.doesNotMatch(out.body, /по конфигурации/);
});

test("без данных склада о катушках честно откатываемся к конфигурации", () => {
  const out = renderToString({
    printers: [{ id: "k2", name: "Creality K2", material: "PLA", swatch: "#fff" }],
    materials: materials({ filament: [PETG] })
  });

  assert.match(out.body, /В принтерах \(по конфигурации\)/);
  assert.match(out.body, /Creality K2: PLA/);
});
