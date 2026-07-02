/* ── Утилиты рендеринга (DOM, экранирование, форматирование, тосты) ── */

export const $ = (sel) => document.querySelector(sel);

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function fmtLeft(min) {
  if (!min || min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} ч ${String(m).padStart(2, "0")} м` : `${m} м`;
}

export const STATUS = {
  printing: { label: "печатает", badge: "badge-printing", pulse: true },
  idle: { label: "готов", badge: "badge-idle" },
  paused: { label: "пауза", badge: "badge-paused" },
  error: { label: "ошибка", badge: "badge-error", pulse: true },
  offline: { label: "offline", badge: "badge-offline" },
  maintenance: { label: "обслуживание", badge: "badge-maint" },
  unknown: { label: "неизвестно", badge: "badge-offline" },
};

export function badge(status) {
  const s = STATUS[status] || STATUS.unknown;
  return `<span class="badge ${s.badge}"><i class="dot${s.pulse ? " dot-pulse" : ""}"></i>${s.label}</span>`;
}

/** Пустое состояние секции: данных реально нет — не подставляем выдуманные. */
export function emptyRow(text) {
  return `<li class="row"><div class="grow row-sub">${esc(text)}</div></li>`;
}

/* ── Тосты ─────────────────────────────────────────────────── */

export function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="star">✦</span><span>${msg}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 3400);
}
