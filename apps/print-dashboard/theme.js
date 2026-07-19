/* ═══════════════════════════════════════════════════════════════
   Смена облика зала · тьма ↔ свет
   Тёмная тема — тронная ночь Назарика (чёрные крылья, обсидиан).
   Светлая тема — соборный день (фарфоровая кожа, белое платье).
   Три режима хранятся в localStorage:
     auto  — по времени: тьма в ночное окно фермы, днём — свет (по умолчанию)
     light — вручную выбран свет
     dark  — вручную выбрана тьма
   Ночное окно для auto-режима определяет backend (NIGHT_PRINT_WINDOW): оно
   приходит в payload /api/dashboard как night.windowStart/windowEnd и
   передаётся сюда через setNightWindow(); ниже — единственный frontend-
   fallback на случай старого или мокового payload. Первичное применение
   (без мигания) делает встроенный скрипт в <head> по кэшу последнего
   фактического облика; здесь — переключатель, живое обновление и мета-цвет.
   ═══════════════════════════════════════════════════════════════ */

import { $, toast } from "./util.js";

const KEY = "albedo-theme";
/* Последний фактически применённый облик — его читает встроенный скрипт в
   <head> при следующей загрузке, чтобы не держать собственную копию окна. */
const EFFECTIVE_KEY = "albedo-theme-effective";
const MODES = ["auto", "light", "dark"];

/* Единственный fallback тёмного окна на фронте: зеркало backend-дефолта
   NIGHT_PRINT_WINDOW (21:30 – 07:30, см. shared/env.ts оркестратора).
   Действует только до первого удачного ответа /api/dashboard. */
const FALLBACK_DARK_FROM = 21 * 60 + 30; // 1290 · 21:30
const FALLBACK_DARK_TO = 7 * 60 + 30; //    450 · 07:30

let darkFrom = FALLBACK_DARK_FROM;
let darkTo = FALLBACK_DARK_TO;

/** "HH:MM" → минуты от полуночи; null, если строка не время. */
function parseHhmmToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Принять эффективное ночное окно фермы из payload backend
 * (`night.windowStart` / `night.windowEnd`, формат "HH:MM"). Непарсибельные
 * или отсутствующие значения возвращают fallback по умолчанию. Если окно
 * изменилось, облик в auto-режиме пересчитывается сразу.
 */
export function setNightWindow(start, end) {
  const from = parseHhmmToMinutes(start) ?? FALLBACK_DARK_FROM;
  const to = parseHhmmToMinutes(end) ?? FALLBACK_DARK_TO;
  if (from === darkFrom && to === darkTo) return;
  darkFrom = from;
  darkTo = to;
  syncEffective();
}

/* Цвет системной строки браузера (meta theme-color) под каждый облик. */
const META = { dark: "#0d0b14", light: "#f4eef4" };

/* Иконки режимов. Луна повторяет герб «ночной печати» — единый почерк. */
const ICON = {
  auto: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l2.8 1.7"/></svg>`,
  light: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3.8"/><path d="M10 1.7v2.2M10 16.1v2.2M1.7 10h2.2M16.1 10h2.2M4.1 4.1l1.6 1.6M14.3 14.3l1.6 1.6M15.9 4.1l-1.6 1.6M5.7 14.3l-1.6 1.6"/></svg>`,
  dark: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15.8 12.4A6.6 6.6 0 1 1 8.6 4.1a5.6 5.6 0 0 0 7.2 8.3Z"/></svg>`,
};

const LABEL = { auto: "Авто", light: "День", dark: "Ночь" };
const HINT = {
  auto: "тема авто по времени · нажмите — светлая",
  light: "тема светлая · нажмите — тёмная",
  dark: "тема тёмная · нажмите — авто",
};

let mode = readMode();

function readMode() {
  const v = localStorage.getItem(KEY);
  return MODES.includes(v) ? v : "auto";
}

/* Тьма ли сейчас по часам браузера. Семантика окна повторяет backend
   (isWithinLocalTimeWindow): окно через полночь, в пределах дня или
   вырожденное (start === end → всегда тьма). */
function isNightNow(d = new Date()) {
  const mins = d.getHours() * 60 + d.getMinutes();
  if (darkFrom === darkTo) return true;
  if (darkFrom < darkTo) return mins >= darkFrom && mins < darkTo;
  return mins >= darkFrom || mins < darkTo;
}

/* Фактический облик из режима: ручной — как выбран, авто — по времени. */
function resolve(m = mode) {
  if (m === "light" || m === "dark") return m;
  return isNightNow() ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Кэш для встроенного скрипта в <head>: при следующей загрузке он применит
  // последний фактический облик до прихода данных, без своей копии окна.
  localStorage.setItem(EFFECTIVE_KEY, theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", META[theme]);
}

function paintButton(btn) {
  if (!btn) return;
  const eff = resolve();
  btn.dataset.mode = mode;
  btn.dataset.effective = eff;
  btn.querySelector(".theme-toggle-icon").innerHTML = ICON[mode];
  btn.querySelector(".theme-toggle-label").textContent = LABEL[mode];
  btn.title = HINT[mode];
  btn.setAttribute("aria-label", `Тема: ${LABEL[mode]}. Переключить.`);
}

/* Последний применённый фактический облик — чтобы опрос и смена окна трогали
   DOM только при реальной смене тьмы/света. */
let lastEffective = null;

/** Пересчитать фактический облик и применить его, если он изменился. */
function syncEffective() {
  const eff = resolve();
  if (eff === lastEffective) return;
  lastEffective = eff;
  applyTheme(eff);
  paintButton($("#theme-toggle"));
}

function setMode(next, { announce = false } = {}) {
  mode = next;
  localStorage.setItem(KEY, mode);
  const eff = resolve();
  lastEffective = eff;
  applyTheme(eff);
  paintButton($("#theme-toggle"));
  if (announce) {
    const msg =
      mode === "auto"
        ? `Облик зала следует времени, Владыка · сейчас ${eff === "dark" ? "тьма" : "свет"}`
        : mode === "dark"
          ? "Зал окутан тьмой Назарика ☾"
          : "Зал озарён светом дня ☀";
    toast(msg);
  }
}

export function setupTheme() {
  const btn = $("#theme-toggle");
  if (btn) {
    paintButton(btn);
    btn.addEventListener("click", () => {
      setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length], { announce: true });
    });
  }

  // Живое авто-переключение на границах ночного окна. Опрос дешёвый; DOM
  // трогаем только когда фактический облик действительно сменился, поэтому
  // ручные режимы (light/dark) остаются неподвижны.
  syncEffective();
  setInterval(syncEffective, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncEffective();
  });
}
