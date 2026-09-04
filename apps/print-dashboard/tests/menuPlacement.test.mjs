/* ── Регресс: меню «⋯» обрезалось карточкой принтера ────────────
   Найденный дефект. Кнопка «Ещё действия» стоит в правом нижнем углу
   карточки, а панель меню была `position: absolute` ВНУТРИ неё. Карточка
   объявлена `overflow: hidden` (иначе кадр камеры вылезает из скруглённого
   угла) — то есть панель, раскрывающаяся вниз от последнего ряда карточки,
   срезалась ровно по её нижней границе. Вторая половина той же беды:
   `.printer-card:hover` получает `transform`, а это собственный стековый
   контекст, и `z-index: 60` панели переставал что-либо значить относительно
   соседних карточек — уцелевший кусок уходил под соседа.

   Сопутствующие недочёты прежнего расчёта направления:
     • сторона выбиралась по замеру ДО применения класса и больше не
       проверялась — панель, развёрнутая влево, могла уйти за левый край;
     • список выше вьюпорта не получал предела высоты и просто уходил за край;
     • при смене размера окна позиция не пересчитывалась.

   Здесь проверяется чистая геометрия (shared/menu.js → placeMenu) и то, что
   стиль панели больше не зависит от обрезающего предка. */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { placeMenu } from "../shared/menu.js";

const EDGE = 8;
const GAP = 6;

/** Прямоугольник кнопки «⋯» по её левому верхнему углу. */
const btn = (left, top, w = 34, h = 30) => ({ left, top, right: left + w, bottom: top + h });
const panel = (width = 260, height = 220) => ({ width, height });
const view = (width = 1440, height = 900) => ({ width, height });

/** Итоговая рамка панели с учётом предела высоты. */
function box(p, size) {
  const height = Math.min(size.height, p.maxHeight);
  return { left: p.left, top: p.top, right: p.left + size.width, bottom: p.top + height, height };
}

test("обычная карточка: меню раскрывается вниз, под кнопкой", () => {
  const b = btn(700, 400);
  const p = placeMenu(b, panel(), view());
  assert.equal(p.side, "down");
  assert.equal(p.top, b.bottom + GAP);
  assert.ok(p.maxHeight >= 220, "места хватает — предел высоты не режет список");
});

test("карточка у нижнего края: меню разворачивается вверх и не лезет за верх", () => {
  const b = btn(700, 830);
  const size = panel();
  const p = placeMenu(b, size, view());
  assert.equal(p.side, "up");
  assert.equal(box(p, size).bottom, b.top - GAP, "нижняя грань — над кнопкой");
  assert.ok(p.top >= EDGE, "верхняя грань внутри экрана");
});

test("кнопка у правого края: панель не выходит за правую кромку", () => {
  const size = panel(300);
  const p = placeMenu(btn(1390, 300), size, view());
  assert.ok(box(p, size).right <= 1440 - EDGE, `правая грань ${box(p, size).right} за кромкой`);
});

test("кнопка у левого края узкого экрана: панель не уходит в минус", () => {
  const size = panel(260);
  const p = placeMenu(btn(10, 300), size, view(360, 740));
  assert.ok(p.left >= EDGE, `левая грань ${p.left} за кромкой`);
  assert.ok(box(p, size).right <= 360 - EDGE, "и правая грань внутри экрана");
});

test("список длиннее экрана: панель получает предел высоты, а не уезжает за край", () => {
  const size = panel(260, 1200);
  const p = placeMenu(btn(700, 400), size, view(1440, 900));
  assert.ok(p.maxHeight < size.height, "предел высоты выставлен — панель прокручивается сама");
  const r = box(p, size);
  assert.ok(r.top >= EDGE && r.bottom <= 900 - EDGE, `рамка ${r.top}…${r.bottom} вне экрана`);
});

test("низкий вьюпорт: выбирается сторона с бОльшим запасом", () => {
  // Кнопка в верхней трети телефона в альбомной ориентации: сверху 60 px,
  // снизу — почти весь экран. Вверх раскрываться здесь нечему.
  const p = placeMenu(btn(300, 60), panel(260, 400), view(740, 360));
  assert.equal(p.side, "down");
  assert.ok(p.maxHeight > 200);
});

test("панель шире всего экрана прижимается к левой кромке", () => {
  const p = placeMenu(btn(300, 200), panel(400), view(360, 740));
  assert.equal(p.left, EDGE);
});

/* Сплошной перебор: где бы ни стояла кнопка и какой бы длины ни был список,
   панель обязана остаться внутри экрана. Прежняя реализация проверяла только
   правый и нижний края, и то один раз — до применения класса. */
test("панель всегда внутри экрана: перебор положений кнопки и размеров списка", () => {
  const views = [view(1440, 900), view(1024, 768), view(390, 844), view(360, 640), view(740, 360)];
  for (const v of views) {
    for (const size of [panel(232, 96), panel(260, 220), panel(320, 520), panel(300, 2000)]) {
      for (let x = 0; x <= v.width - 34; x += 37) {
        for (let y = 0; y <= v.height - 30; y += 29) {
          const p = placeMenu(btn(x, y), size, v);
          const r = box(p, size);
          const where = `экран ${v.width}×${v.height}, кнопка ${x},${y}, панель ${size.width}×${size.height}`;
          assert.ok(r.left >= EDGE, `левая грань за кромкой: ${where}`);
          assert.ok(r.top >= EDGE, `верхняя грань за кромкой: ${where}`);
          assert.ok(r.bottom <= v.height - EDGE + 0.001, `нижняя грань за кромкой: ${where}`);
          if (size.width <= v.width - 2 * EDGE) {
            assert.ok(r.right <= v.width - EDGE + 0.001, `правая грань за кромкой: ${where}`);
          }
          assert.ok(r.height > 0, `панель схлопнулась: ${where}`);
        }
      }
    }
  }
});

/* ── Стили: панель не имеет права зависеть от обрезающего предка ── */

const css = readFileSync(fileURLToPath(new URL("../styles/components.css", import.meta.url)), "utf8");
const RULES = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean), body: m[2] }));

function rule(selector) {
  const found = RULES.filter((r) => r.selectors.includes(selector));
  assert.ok(found.length, `правило для «${selector}» не найдено`);
  return found.map((r) => r.body).join("\n");
}

test("панель меню позиционируется от вьюпорта, а не от карточки", () => {
  const body = rule(".menu");
  assert.match(body, /position:\s*fixed/, "position: absolute снова обрезался бы карточкой");
  assert.match(body, /overflow-y:\s*auto/, "длинный список обязан прокручиваться сам");
});

test("меню лежит над скрымом модального окна, но под подтверждением и уведомлениями", () => {
  const z = Number(/z-index:\s*(\d+)/.exec(rule(".menu"))?.[1]);
  assert.ok(z > 200, `меню открывают из окна принтера — ${z} оказалось бы за скрымом`);
  assert.ok(z < 250, `окно подтверждения (250) обязано перекрывать меню, а не наоборот (${z})`);
});
