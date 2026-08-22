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
import { inflateSync } from "node:zlib";

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

/* Первая строка пикселей исходника — та единственная величина, из-за которой
   кадру нужен воздух сверху. Разбирается сам PNG, а не память о нём: если
   картинку однажды переэкспортируют с полем над макушкой, тест скажет, что
   костыль в стилях больше не нужен. Файл палитровый, 8 бит, без чересстрочности
   — эти три условия проверяются явно, потому что на них держится разбор. */
function topRowHasInk(file) {
  const png = readFileSync(file);
  let off = 8; // сигнатура
  let ihdr = null; const idat = []; let trns = null;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    if (type === "tRNS") trns = data;
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    off += 12 + len;
  }
  assert.equal(ihdr.depth, 8, "разбор рассчитан на 8 бит на канал");
  assert.equal(ihdr.color, 3, "разбор рассчитан на палитровый PNG");
  assert.equal(ihdr.interlace, 0, "разбор рассчитан на построчный PNG");
  assert.ok(trns, "у палитры нет tRNS — фон файла непрозрачен целиком");
  const raw = inflateSync(Buffer.concat(idat));
  // Нужна ровно нулевая строка. Предыдущей строки нет (нули), поэтому все пять
  // фильтров PNG на ней сводятся к «нет фильтра» либо к Sub/Average по левому.
  const filter = raw[0];
  const row = Buffer.from(raw.subarray(1, 1 + ihdr.w));
  for (let x = 0; x < ihdr.w; x++) {
    const left = x > 0 ? row[x - 1] : 0;
    if (filter === 1) row[x] = (row[x] + left) & 0xff;              // Sub
    else if (filter === 3) row[x] = (row[x] + (left >> 1)) & 0xff;  // Average
    else if (filter === 4) row[x] = (row[x] + left) & 0xff;         // Paeth
  }
  return { size: [ihdr.w, ihdr.h], ink: row.some((i) => (trns[i] ?? 255) > 8) };
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

test("над макушкой есть воздух: в самом файле его нет", () => {
  // Измеренный факт, ради которого существует --portrait-headroom: тушь в
  // исходнике начинается с НУЛЕВОЙ строки (непрозрачный bbox — 0,0–720,968,
  // все 112 пустых строк лежат снизу). Значит `object-position: 50% 0` ставит
  // волосы ровно на границу кадра: замер давал жёсткую ступеньку +28 к каналу
  // по верхней грани дорожки в тёмной теме и +185 в светлой — на всех ширинах.
  const { size, ink } = topRowHasInk(at(`../${PORTRAIT}`));
  assert.deepEqual(size, [720, 1080], "пропорции файла изменились — кадр надо пересчитать");
  assert.ok(ink, "в файле появилось поле над макушкой: воздух в стилях больше не нужен");

  const portrait = rule(dashboardCss, ".aura-portrait");
  // object-fit кадрирует внутри уже отведённой коробки — без пересчёта раскладки,
  // а значит и без сдвигов первого экрана (CLS).
  assert.match(portrait, /object-fit:\s*cover/);
  // Смещение обязано быть ДЛИНОЙ: при `cover` картинка выше коробки, и длина —
  // это отступ её верхней грани от верхней грани коробки (лишнее срезается
  // снизу, из пустоты). Проценты значат совсем другое — они распределяют
  // переполнение, и любое значение, кроме 0%, режет макушку ещё глубже
  // (так и было с прежним `50% 8%`).
  const headroom = portrait.match(/--portrait-headroom:\s*(-?[\d.]+)px/);
  assert.ok(headroom, "воздух над макушкой задаётся --portrait-headroom в px");
  assert.ok(Number(headroom[1]) > 0, "нулевой воздух = волосы вплотную к границе");
  assert.match(portrait, /object-position:\s*50%\s+var\(--portrait-headroom\)/);
  assert.ok(!/object-position:[^;]*\d+%\s*;/.test(portrait),
    "проценты по вертикали распределяют переполнение, а не отступают от края");
  assert.ok(!/margin:\s*auto/.test(portrait), "вертикальное центрирование срезает макушку");
  assert.match(html, /width="720"\s*\n?\s*height="1080"|width="720" height="1080"/,
    "пропорции известны до загрузки файла");
  assert.match(html, /decoding="async"/, "декодирование не имеет права держать первый кадр");
});

test("растворяются только те грани, по которым идёт срез", () => {
  // Растворять надо ровно там, где кадр режет по живому телу: нижняя грань
  // (всегда) и узкие полосы у бортов (ниже ~760-й строки исходника подол и
  // волосы доходят до краёв файла — на 901–1600 px это давало ступеньку до
  // 151 к каналу в светлой теме). Верх не растворяется вовсе: там воздух.
  // Прежняя радиальная маска размывала портрет со ВСЕХ сторон разом, и лицо
  // тонуло в фоне.
  const portrait = rule(dashboardCss, ".aura-portrait");
  assert.match(portrait, /mask-image:\s*\n?\s*linear-gradient\(180deg/, "срез снизу обязан растворяться");
  assert.match(portrait, /linear-gradient\(90deg/, "борта обязаны растворяться");
  assert.match(portrait, /-webkit-mask-image:/, "WebKit требует своего префикса");
  assert.ok(!/radial-gradient/.test(portrait), "круглая маска размывает портрет со всех сторон");
  // Два слоя маски обязаны ПЕРЕМНОЖАТЬСЯ. По умолчанию слои складываются, и
  // объединение двух растворений — это отсутствие растворения вовсе.
  assert.match(portrait, /mask-composite:\s*intersect/);
  assert.match(portrait, /-webkit-mask-composite:\s*source-in/, "у WebKit пересечение зовётся иначе");
  // Первая же остановка вертикального градиента обязана быть непрозрачной:
  // растворение начинается только у нижнего края, а не от самой макушки.
  assert.match(portrait, /linear-gradient\(180deg,\s*#000 0%/, "верх кадра обязан быть полностью непрозрачным");
  // Боковая полоса — узкая. Лицо и рога живут в средних 40% кадра; всё, что
  // шире десятой доли ширины с каждой стороны, начнёт съедать сам портрет.
  const fade = portrait.match(/--portrait-fade:\s*([\d.]+)%/);
  assert.ok(fade, "ширина боковой полосы задаётся --portrait-fade в процентах");
  assert.ok(Number(fade[1]) > 0 && Number(fade[1]) <= 10,
    `боковое растворение ${fade[1]}% — либо его нет, либо оно достаёт до лица`);
});

test("свечение гаснет ДО границы своей коробки", () => {
  // Корень той самой «рамки вокруг картинки». `contain: paint` у дорожки режет
  // всё по её краю, поэтому свечение обязано дойти до нуля раньше. Прежние
  // радиусы этого не делали: `64% 54% at 50% 46%` заезжает за борта на 14%
  // ширины и за верх на 8% высоты, на срезе оставалось ~9% сиреневого, и на
  // графите зала это читалось как +5…+10 к каналу по трём граням.
  assert.match(rule(dashboardCss, ".hero-aura"), /contain:\s*layout paint/,
    "без paint-containment декор выйдет на текст — но тогда и это правило теряет смысл");
  for (const [css, sel, where] of [
    [dashboardCss, ".aura-glow", "ночью"],
    [themeCss, ':root[data-theme="light"] .aura-glow', "днём"],
  ]) {
    const bg = rule(css, sel).match(/background:\s*([^;]+);/);
    assert.ok(bg, `${where}: у свечения нет фона`);
    const layers = [...bg[1].matchAll(/radial-gradient\(([^;]*?)\)(?=,\s*radial-gradient|\s*$)/g)];
    assert.ok(layers.length >= 2, `${where}: ожидались оба ореола`);
    for (const [, body] of layers) {
      assert.match(body, /^closest-side/,
        `${where}: размер обязан считаться от ближайшей грани, а не задаваться процентами`);
      const last = [...body.matchAll(/(\d+(?:\.\d+)?)%(?=\s*$)/g)].pop();
      assert.ok(last && Number(last[1]) < 100,
        `${where}: краска обязана кончиться внутри коробки, а не на её срезе (${body})`);
    }
  }
});

test("высота дорожки считается от ширины зала, а не от ширины окна", () => {
  // На 1500 px появляется спутник, зал скачком сужается с 1345 до 1141 px, а
  // vw продолжает расти: кадр портрета гулял по соотношению сторон от 0.68 до
  // 1.08 — то бюст, то почти квадрат. Пара «% ширины дорожки ↔ cqw её высоты»
  // считается от одной базы и держит кадр одинаковым на всех ширинах.
  assert.match(rule(dashboardCss, ".hero"), /container-type:\s*inline-size/,
    "без контейнера запросов cqw у дорожки станет ссылкой на чужой предок");
  const aura = rule(dashboardCss, ".hero-aura");
  assert.match(aura, /min-height:\s*clamp\([^;]*cqw/,
    "высота дорожки обязана считаться от ширины зала");
  assert.ok(!/min-height:\s*clamp\([^;]*\dvw/.test(aura),
    "vw не знает про спутника — именно от него кадр и гулял");
  assert.match(aura, /align-self:\s*stretch/,
    "это floor, а не высота: колонка текста выше — растягиваемся по ней");
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
