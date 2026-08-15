/* ── Регресс P0: единая SVG-система вместо глифов и эмодзи ──────
   Найденный дефект: интерфейс использовал ~30 символов юникода (⚠ ⛔ ☀ ☾ ✕ ✓
   🗂 🖼 📁 🔴 🟢 …). Подключённые Inter/Cormorant покрывают лишь часть из них:
   где-то появлялся пустой квадрат, где-то ОС подставляла собственное цветное
   эмодзи — своего размера, цвета и базовой линии на каждой платформе. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ICON_NAMES, icon, spinner } from "../shared/icons.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("каждый значок — один SVG на общей сетке и общем весе линии", () => {
  for (const name of ICON_NAMES) {
    const svg = icon(name);
    assert.match(svg, /^<svg class="ico"/, `${name}: общий класс`);
    assert.match(svg, /viewBox="0 0 20 20"/, `${name}: общая сетка 20×20`);
    assert.match(svg, /stroke-width="1\.5"/, `${name}: общий вес линии`);
    assert.match(svg, /stroke="currentColor"/, `${name}: цвет только от контекста`);
  }
});

test("внутри значка нет собственных цветов — ни одного", () => {
  for (const name of ICON_NAMES) {
    const svg = icon(name);
    assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b/i, `${name}: жёстко заданный цвет`);
    assert.doesNotMatch(svg, /(fill|stroke)="(?!none|currentColor)[a-z]/i, `${name}: именованный цвет`);
  }
});

test("значок по умолчанию скрыт от скринридера, а с подписью — назван", () => {
  assert.match(icon("warn"), /aria-hidden="true"/);
  assert.match(icon("warn"), /focusable="false"/, "SVG не должен ловить Tab в IE-подобных движках");

  const titled = icon("warn", { title: "Предупреждение" });
  assert.match(titled, /role="img"/);
  assert.match(titled, /aria-label="Предупреждение"/);
  assert.doesNotMatch(titled, /aria-hidden/);
});

test("подпись значка экранируется, как любые внешние данные", () => {
  const svg = icon("warn", { title: '"><script>alert(1)</script>' });
  assert.ok(!svg.includes("<script>"), "разметка из подписи не должна исполняться");
  assert.match(svg, /&quot;&gt;&lt;script&gt;/);
});

test("неизвестное имя даёт печать Назарика, а не пустое место", () => {
  const svg = icon("такого-значка-нет");
  assert.match(svg, /^<svg/);
  assert.equal(svg, icon("sigil"));
});

test("индикатор ожидания — тот же набор и та же сетка", () => {
  assert.match(spinner(), /viewBox="0 0 20 20"/);
  assert.match(spinner(), /class="ico spin/);
  assert.match(spinner(), /stroke="currentColor"/);
});

/* Главная защита: сам исходник интерфейса больше не содержит глифов-картинок.
   Комментарии из проверки исключены — в тексте объяснений эти символы законны
   (о них там и идёт речь), а вот в разметке их быть не должно. */

/** Вырезает //-, /*-  и <!-- -->-комментарии, сохраняя нумерацию строк. */
function stripComments(source) {
  let out = "";
  let mode = "code"; // code | line | block | html | str
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    const keep = c === "\n" ? "\n" : " ";

    if (mode === "code") {
      if (c === "/" && next === "/") { mode = "line"; out += "  "; i++; continue; }
      if (c === "/" && next === "*") { mode = "block"; out += "  "; i++; continue; }
      if (c === "<" && source.startsWith("<!--", i)) { mode = "html"; out += "    "; i += 3; continue; }
      if (c === '"' || c === "'" || c === "`") { mode = "str"; quote = c; }
      out += c;
      continue;
    }
    if (mode === "str") {
      out += c;
      if (c === "\\") { out += source[++i] ?? ""; continue; }
      if (c === quote) mode = "code";
      continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += "\n"; continue; }
      out += " ";
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") { mode = "code"; out += "  "; i++; continue; }
      out += keep;
      continue;
    }
    if (mode === "html") {
      if (c === "-" && source.startsWith("-->", i)) { mode = "code"; out += "   "; i += 2; continue; }
      out += keep;
      continue;
    }
  }
  return out;
}

test("в разметке интерфейса не осталось глифов и эмодзи", () => {
  const PICTOGRAPHS = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F000}-\u{1F2FF}]/u;
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "tests" || entry.name === "smoke") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(entry.name)) files.push(full);
    }
  };
  walk(ROOT);

  const offenders = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const lines = stripComments(raw).split("\n");
    const rawLines = raw.split("\n");
    lines.forEach((line, i) => {
      if (PICTOGRAPHS.test(line)) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${rawLines[i].trim().slice(0, 80)}`);
      }
    });
  }

  assert.deepEqual(offenders, [], `глифы-эмодзи вернулись в разметку:\n${offenders.join("\n")}`);
});
