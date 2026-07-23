/* ── DOM-утилиты (выбор, экранирование, тосты, пустые состояния) ──
   Только DOM-помощники. Форматирование чисел/дат — shared/format.js,
   чипы/бейджи/панели — shared/chips.js, блоки принтера — render/printerParts.js. */

export const $ = (sel) => document.querySelector(sel);

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Экранирование строки для селектора атрибута ([data-x="…"]). */
export function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

/** Пустое состояние секции: данных реально нет — не подставляем выдуманные. */
export function emptyRow(text) {
  return `<li class="row"><div class="grow row-sub">${esc(text)}</div></li>`;
}

/* ── Тосты ─────────────────────────────────────────────────── */

export function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="star">❖</span><span>${msg}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 3400);
}
