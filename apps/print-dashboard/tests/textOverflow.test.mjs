/* ── Регресс: текст с backend растягивал страницу ──────────────
   Найденный дефект (замерен в браузере на реальном payload с длинными
   именами): бейдж и пилюля объявлены `white-space: nowrap` — это верно для
   коротких статусов («трудится», «пауза»), но тот же класс носят элементы с
   ТЕКСТОМ С BACKEND:

     • «<имя принтера>: <материал>» в ряду материалов;
     • «Для очереди нужно ещё 2340 г PETG-CF …» в потребностях очереди;
     • «Замечены отклонения — я уже занимаюсь ими» в пилюле hero.

   Одно длинное имя растягивало документ до 955 px при вьюпорте 320 и до
   1787 px при 1440 — настоящая горизонтальная прокрутка ВСЕЙ страницы; на
   телефоне пилюля hero вдобавок обрезалась посередине слова, то есть
   сообщение о неполадке становилось нечитаемым именно там, где важнее всего.

   Правило, которое эти тесты защищают: элемент не имеет права быть шире своего
   контейнера, а свободный текст обязан переноситься. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const css = readFileSync(fileURLToPath(new URL("../styles/components.css", import.meta.url)), "utf8");

/* Разбор без внешних зависимостей: пары «селекторы { тело }». Вложенные
   @media разбираются сами собой — их заголовок остаётся снаружи пары. */
const RULES = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean), body: m[2] }));

/** Тело правила, у которого есть ровно такой селектор. */
function rule(selector) {
  const found = RULES.filter((r) => r.selectors.includes(selector));
  assert.ok(found.length, `правило для «${selector}» не найдено`);
  return found.map((r) => r.body).join("\n");
}

test("бейдж не может стать шире своего контейнера", () => {
  const body = rule(".badge");
  assert.match(body, /max-width:\s*100%/, "предел ширины обязателен");
});

test("бейджи со свободным текстом переносятся по словам", () => {
  const body = rule(".night-facts .badge");
  assert.match(body, /white-space:\s*normal/, "текст с backend обязан переноситься");
  assert.match(body, /overflow-wrap:\s*anywhere/, "длинный неразрывный токен тоже");
  assert.ok(css.includes(".chip-line .badge"), "ряд чипов — главное место свободного текста");
});

test("пилюля ограничена шириной контейнера, а реплики hero переносятся", () => {
  assert.match(rule(".pill"), /max-width:\s*100%/);
  const hero = rule(".hero-pills .pill");
  assert.match(hero, /white-space:\s*normal/, "фраза целиком, а не обрезок");
  assert.match(hero, /overflow-wrap:\s*anywhere/);
});

test("короткий статусный бейдж по-прежнему держит одну строку", () => {
  // Перенос разрешён адресно — общее правило .badge остаётся nowrap, иначе
  // «запуск не подтверждён» ломался бы на три строки в каждой строке очереди.
  assert.match(rule(".badge"), /white-space:\s*nowrap/);
});
