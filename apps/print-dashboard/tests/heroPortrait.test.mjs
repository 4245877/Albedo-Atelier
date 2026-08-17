/* ── Регресс: портрет надзирательницы пропал из зала ───────────
   Что случилось: при редизайне первого экрана скетч Альбедо
   (assets/hero-overseer-sketch.png) заменили абстрактным SVG — крыло, рога,
   печать — и удалили сам файл. Причина замены была технической: прежний
   медальон был позиционирован абсолютно поверх ВСЕГО hero и наезжал на плитки
   показателей на 50–56 px. Но лечили не то: мешало не изображение, а его
   место в раскладке.

   Правильное решение — оставить портрет и отдать декору собственную колонку
   сетки. Эти тесты держат обе половины решения, потому что каждая из них
   молчаливо ломается:

     · файл легко потерять снова (COPY assets в Dockerfile, ссылка в разметке);
     · портрет легко «вернуть» абсолютным позиционированием поверх текста —
       и тогда он снова ляжет на цифры.

   Проверяется текст файлов, а не браузер: у панели нет сборщика, и разметка
   со стилями — это и есть артефакт, который уезжает в образ. */

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const html = readFileSync(at("../index.html"), "utf8");
const dashboardCss = readFileSync(at("../styles/dashboard.css"), "utf8");
const themeCss = readFileSync(at("../styles/theme.css"), "utf8");
const dockerfile = readFileSync(at("../Dockerfile"), "utf8");

const PORTRAIT = "assets/hero-overseer-sketch.png";

/* Тот же разбор «селекторы { тело }», что и в textOverflow: без зависимостей,
   вложенные @media остаются снаружи пар. */
function rulesOf(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .map((m) => ({ selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean), body: m[2] }));
}

function rule(css, selector) {
  const found = rulesOf(css).filter((r) => r.selectors.includes(selector));
  assert.ok(found.length, `правило для «${selector}» не найдено`);
  return found.map((r) => r.body).join("\n");
}

test("файл портрета лежит в репозитории и уезжает в образ", () => {
  const file = at(`../${PORTRAIT}`);
  assert.ok(existsSync(file), "assets/hero-overseer-sketch.png удалён из репозитория");
  assert.ok(statSync(file).size > 10000, "файл на месте, но пустой — картинки не будет");
  assert.match(dockerfile, /COPY assets /, "без COPY assets портрет не попадёт в nginx");
});

test("hero показывает именно этот портрет, а не силуэт", () => {
  assert.match(html, new RegExp(`src="/${PORTRAIT}"`), "разметка обязана ссылаться на файл");
  assert.match(html, /class="aura-portrait"/);
  // Абстрактный SVG-заменитель не должен вернуться ни в одном из своих кусков.
  for (const gone of ["aura-figure", "aura-wing", "aura-horns", "aura-sigil"]) {
    assert.ok(!html.includes(gone), `${gone} — часть прежней замены персонажа`);
    assert.ok(!dashboardCss.includes(gone), `${gone} остался в стилях`);
    assert.ok(!themeCss.includes(gone), `${gone} остался в светлой теме`);
  }
});

test("портрет живёт в своей колонке и не может лечь на текст", () => {
  // Декор — отдельная дорожка сетки: она и есть гарантия неперекрытия.
  assert.match(rule(dashboardCss, ".hero"), /grid-template-columns:[^;]*clamp\(/);
  assert.ok(html.indexOf('class="hero-body"') < html.indexOf('class="hero-aura"'),
    "порядок колонок: данные, затем декор");
  // Картинка позиционирована ОТНОСИТЕЛЬНО колонки, а не всего зала.
  assert.match(rule(dashboardCss, ".hero-aura"), /position:\s*relative/);
  assert.match(rule(dashboardCss, ".hero-aura"), /pointer-events:\s*none/);
  const portrait = rule(dashboardCss, ".aura-portrait");
  assert.match(portrait, /position:\s*absolute/);
  assert.match(portrait, /inset:\s*0/, "выйти за колонку нечем: все стороны прибиты к ней");
});

test("кадр прижат к верхней грани: макушка и рога не срезаются", () => {
  const portrait = rule(dashboardCss, ".aura-portrait");
  // object-fit кадрирует внутри уже отведённой коробки — без пересчёта раскладки,
  // а значит и без сдвигов первого экрана (CLS).
  assert.match(portrait, /object-fit:\s*cover/);
  // Верх кадра — верх файла. `object-position: 50% 8%` срезал верхнюю прядь, а
  // `margin: auto` центрировал картинку по высоте и добавлял к срезу ещё.
  assert.match(portrait, /object-position:\s*50%\s+0(%|\b)/,
    "кадр обязан начинаться с макушки, а не с середины волос");
  assert.ok(!/margin:\s*auto/.test(portrait), "вертикальное центрирование срезает макушку");
  assert.match(html, /width="720"\s*\n?\s*height="1080"|width="720" height="1080"/,
    "пропорции известны до загрузки файла");
  assert.match(html, /decoding="async"/, "декодирование не имеет права держать первый кадр");
});

test("растворяется только нижний срез, а не все четыре стороны", () => {
  // Фон в самом файле прозрачен — прямоугольник кадра растворять не нужно.
  // Растворять нужно ровно одно место: нижнюю грань, где обрезка идёт по телу.
  // Прежняя радиальная маска размывала портрет со ВСЕХ сторон разом, и лицо
  // тонуло в фоне.
  const portrait = rule(dashboardCss, ".aura-portrait");
  assert.match(portrait, /mask-image:\s*linear-gradient\(\s*180deg/, "срез снизу обязан растворяться");
  assert.match(portrait, /-webkit-mask-image:\s*linear-gradient/, "WebKit требует своего префикса");
  assert.ok(!/radial-gradient/.test(portrait), "круглая маска размывает портрет со всех сторон");
  // Первая же остановка градиента обязана быть непрозрачной: растворение
  // начинается только у нижнего края, а не от самой макушки.
  const stops = portrait.match(/mask-image:\s*linear-gradient\(([^;]*)\);/)[1];
  assert.match(stops, /#000 0%/, "верх кадра обязан быть полностью непрозрачным");
});

test("портрет виден в обеих темах и замирает при просьбе о покое", () => {
  assert.match(rule(dashboardCss, ".aura-portrait"), /--portrait-opacity:\s*0?\.\d+/);
  assert.match(rule(themeCss, ':root[data-theme="light"] .aura-portrait'), /--portrait-opacity/,
    "днём тушь по фарфору требует своей прозрачности");
  // Дыхание — только opacity: transform на palette-PNG с маской и фильтром
  // Firefox растрирует заново каждый кадр (под это держали @supports-фоллбек).
  const breathe = dashboardCss.match(/@keyframes portrait-breathe\s*\{[\s\S]*?\n\}/);
  assert.ok(breathe, "анимация дыхания не найдена");
  assert.ok(!/transform/.test(breathe[0]), "дыхание обязано быть только прозрачностью");
  const reduced = dashboardCss.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n\}\n/);
  assert.match(reduced[0], /\.aura-portrait/, "покой обязан останавливать и портрет");
});
