/* ═══════════════════════════════════════════════════════════════
   Смена облика зала · тьма ↔ свет
   Тёмная тема — тронная ночь Назарика (чёрные крылья, обсидиан).
   Светлая тема — соборный день (фарфоровая кожа, белое платье).
   Три режима хранятся в localStorage:
     auto  — по времени: тьма с 21:30 до 7:30, днём — свет (по умолчанию)
     light — вручную выбран свет
     dark  — вручную выбрана тьма
   Первичное применение (без мигания) делает встроенный скрипт в <head>;
   здесь — переключатель, живое обновление по времени и мета-цвет.
   ═══════════════════════════════════════════════════════════════ */

import { $, toast } from "./util.js";

const KEY = "albedo-theme";
const MODES = ["auto", "light", "dark"];

/* Тёмное окно суток: с 21:30 до 7:30 (в минутах от полуночи). */
const DARK_FROM = 21 * 60 + 30; // 1290 · 21:30
const DARK_TO = 7 * 60 + 30; //    450 · 07:30

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

/* Тьма ли сейчас по часам (окно 21:30–7:30 переходит через полночь). */
function isNightNow(d = new Date()) {
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= DARK_FROM || mins < DARK_TO;
}

/* Фактический облик из режима: ручной — как выбран, авто — по времени. */
function resolve(m = mode) {
  if (m === "light" || m === "dark") return m;
  return isNightNow() ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
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

function setMode(next, { announce = false } = {}) {
  mode = next;
  localStorage.setItem(KEY, mode);
  const eff = resolve();
  applyTheme(eff);
  paintButton($("#theme-toggle"));
  if (announce) {
    const msg =
      mode === "auto"
        ? `Тема: авто · сейчас ${eff === "dark" ? "тёмная" : "светлая"}`
        : `Тема: ${mode === "dark" ? "тёмная" : "светлая"}`;
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

  // Живое авто-переключение на границах 21:30 / 07:30. Опрос дешёвый; DOM
  // трогаем только когда фактический облик действительно сменился, поэтому
  // ручные режимы (light/dark) остаются неподвижны.
  let lastEff = resolve();
  applyTheme(lastEff);
  const sync = () => {
    const eff = resolve();
    if (eff === lastEff) return;
    lastEff = eff;
    applyTheme(eff);
    paintButton($("#theme-toggle"));
  };
  setInterval(sync, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) sync();
  });
}
