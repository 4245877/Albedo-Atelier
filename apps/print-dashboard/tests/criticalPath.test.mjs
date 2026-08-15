/* ── Регресс: критический путь первой отрисовки ────────────────
   Замерено на сборке с живым backend (Chromium, 4× CPU throttle, 20 мс
   задержки, холодный кеш, медиана 7 прогонов):

     FCP            3164 → 1552 мс
     передано       704  → 355  КБ

   Две причины были устранены:

     1. nginx отдавал ВСЁ несжатым — gzip в образе по умолчанию выключен, а на
        критическом пути лежит ~230 КБ CSS и ~40 КБ HTML;
     2. workflows.css (83 КБ, треть всего CSS) блокировал первую отрисовку,
        хотя не красит на первом экране ни одного пикселя: он одевает панели
        «Работ» (скрыты, грузятся лениво) и окно запуска (открывается кликом).

   Эти проверки структурные — они не дают правкам молча вернуть прежнее.
   Сборщик для этого не понадобился и не должен понадобиться. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const html = read("../index.html");
const nginx = read("../nginx.conf")
  .split("\n").map((l) => l.replace(/#.*$/, "")).join("\n");

const head = html.slice(0, html.indexOf("</head>"));
/* Содержимое <noscript> не участвует в первой отрисовке при живом JS —
   исключаем его, иначе запасная ссылка читалась бы как блокирующая. */
const headScripted = head.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");

test("текстовые ответы отдаются сжатыми", () => {
  assert.match(nginx, /^\s*gzip\s+on;/m, "gzip включён");
  const types = /gzip_types([^;]*);/.exec(nginx);
  assert.ok(types, "перечень типов задан");
  for (const type of ["text/css", "application/javascript"]) {
    assert.ok(types[1].includes(type), `${type} обязан сжиматься — он на критическом пути`);
  }
  assert.doesNotMatch(nginx, /gzip_types[^;]*font\/woff2/, "woff2 уже сжат, повторное сжатие только вредит");
  assert.match(nginx, /gzip_vary\s+on;/, "Vary: Accept-Encoding для промежуточных кешей");
});

test("workflows.css не блокирует первую отрисовку", () => {
  const blocking = [...headScripted.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map((m) => m[0]);
  assert.ok(
    !blocking.some((l) => l.includes("workflows.css")),
    "самый большой файл набора не может стоять на пути первого кадра"
  );
  assert.match(head, /<link\s+rel="preload"\s+as="style"\s+href="\/styles\/workflows\.css"/,
    "он грузится параллельно с приоритетом стиля");
  assert.match(head, /onload="this\.onload=null;this\.rel='stylesheet'"/,
    "и становится обычным stylesheet по загрузке");
  assert.match(head, /<noscript><link rel="stylesheet" href="\/styles\/workflows\.css"/,
    "без JS «Работы» всё равно одеты");
});

test("стили первого экрана остаются блокирующими — их отсутствие видно глазом", () => {
  const blocking = [...headScripted.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map((m) => m[0]).join("\n");
  for (const file of ["tokens-base.css", "components.css", "dashboard.css", "theme.css"]) {
    assert.ok(blocking.includes(file), `${file} красит первый экран и обязан приехать до него`);
  }
});

test("порядок каскада сохранён: workflows подключается последним", () => {
  const order = ["tokens-base.css", "components.css", "dashboard.css", "theme.css", "modals.css", "workflows.css"];
  const positions = order.map((f) => head.indexOf(f));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `${order[i]} должен идти после ${order[i - 1]}`);
  }
});

test("решение о первом кадре принимается синхронно и не зависит от модулей", () => {
  const inlineScript = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
  assert.match(inlineScript, /classList\.add\("has-js"\)/, "пред-скрытие включается только при живом JS");
  assert.match(inlineScript, /reveal-all/, "страховка показа существует");
  assert.ok(html.indexOf("<script>") < html.indexOf("<title>"), "решение принимается до первой отрисовки");
});
