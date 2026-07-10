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
  unknown: { label: "неизвестно", badge: "badge-offline" },
};

export function badge(status) {
  const s = STATUS[status] || STATUS.unknown;
  return `<span class="badge ${s.badge}"><i class="dot${s.pulse ? " dot-pulse" : ""}"></i>${s.label}</span>`;
}

/** Диаметр сопла «0.4» без плавающего хвоста (0.40000001 → 0.4). */
export function fmtNozzle(mm) {
  if (mm == null) return null;
  return String(Math.round(mm * 100) / 100);
}

/**
 * Строка филамента: живой материал с принтера (тег «с принтера») либо
 * материал из конфигурации (тег «из конфигурации»); плюс чип диаметра сопла,
 * когда принтер его сообщает. Цвет-плашка — из живого цвета, иначе из swatch.
 */
export function materialBlock(p) {
  const live = p.liveMaterialSource === "printer" && p.liveMaterial;
  const color = live && p.liveMaterialColor ? p.liveMaterialColor : p.swatch;
  const dot = color ? `<span class="swatch" style="background:${esc(color)}"></span>` : "";

  let text;
  let tag = "";
  if (live) {
    text = esc(p.liveMaterial);
    tag = `<span class="src-tag src-printer">с принтера</span>`;
  } else if (p.material) {
    text = esc(p.material);
    tag = `<span class="src-tag src-config">из конфигурации</span>`;
  } else {
    text = "материал не указан";
  }

  const nozzle = fmtNozzle(p.nozzleDiameter);
  // A config-sourced diameter must not look like live telemetry: mute it and
  // label it, mirroring the «из конфигурации» tag on the material itself.
  const nozzleFromConfig = p.nozzleDiameterSource === "config";
  const nozzleChip = nozzle
    ? `<span class="nozzle-chip${nozzleFromConfig ? " nozzle-chip-config" : ""}"${
        nozzleFromConfig ? ' title="из конфигурации"' : ""
      }>Сопло ${esc(nozzle)} мм</span>`
    : "";

  return `<div class="printer-material">${dot}<span>${text}</span>${tag}${nozzleChip}</div>`;
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
