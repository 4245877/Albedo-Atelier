/* ── Статусные чипы, бейджи и панели ───────────────────────────
   Одна точка правды для трёх повторявшихся примитивов разметки:
     chip()  — цветной чип с точкой (.upload-chip) в workflow-разделах;
     badge() — статусный бейдж принтера (.badge) на доске;
     panel() — панель раздела (.slice-panel) с заголовком.
   ВАЖНО: chip/panel не экранируют `label`/`head` — вызывающий экранирует
   внешние данные сам (части label бывают заранее собранной разметкой). */

import { esc } from "../util.js";

/** Цветной чип с точкой; `cls`: ok/info/warn/error; `pulse` — мигающая точка. */
export function chip(label, cls, pulse = false) {
  return `<span class="upload-chip chip-${cls}"><i class="dot${pulse ? " dot-pulse" : ""}"></i>${label}</span>`;
}

/* Статусы кратки и точны — рабочий режим Надзирательницы: церемониал в
   репликах, безошибочная точность в данных. */
export const STATUS = {
  printing: { label: "трудится", badge: "badge-printing", pulse: true },
  idle: { label: "готов служить", badge: "badge-idle" },
  paused: { label: "пауза", badge: "badge-paused" },
  error: { label: "провинность", badge: "badge-error", pulse: true },
  offline: { label: "безмолвствует", badge: "badge-offline" },
  unknown: { label: "неизвестно", badge: "badge-offline" },
};

/** Статусный бейдж принтера; неизвестный статус получает безопасный fallback. */
export function badge(status) {
  const s = STATUS[status] || STATUS.unknown;
  return `<span class="badge ${s.badge}"><i class="dot${s.pulse ? " dot-pulse" : ""}"></i>${s.label}</span>`;
}

/* «Простаивает» ≠ «готов служить». Программа принтера стоит, но на столе может
   лежать готовая деталь, запуск может быть не подтверждён, а стол — ни разу не
   проверен. Сервер сводит это в `readiness`; бейдж обязан сказать то же самое,
   а не повторять `idle` устройства. */
export const READINESS = {
  needs_clearance: { label: "ждёт снятия детали", badge: "badge-paused" },
  bed_unknown: { label: "стол не подтверждён", badge: "badge-paused" },
  starting: { label: "запуск принят", badge: "badge-printing", pulse: true },
  held: { label: "запуск не подтверждён", badge: "badge-error", pulse: true },
  maintenance: { label: "нужна операция", badge: "badge-paused" },
  stale: { label: "данные устарели", badge: "badge-offline" },
  setup: { label: "нужна настройка", badge: "badge-offline" },
};

/** Бейдж принтера с учётом готовности: печать/ошибка/связь — как есть, простой — по факту. */
export function printerBadge(p) {
  const r = p && p.readiness;
  const quiet = p && (p.status === "idle" || p.status === "unknown");
  const s = r && quiet && READINESS[r.state];
  if (!s) return badge(p ? p.status : "unknown");
  const title = r.detail ? ` title="${esc(r.detail)}"` : "";
  return `<span class="badge ${s.badge}"${title}><i class="dot${s.pulse ? " dot-pulse" : ""}"></i>${s.label}</span>`;
}

/** Панель workflow-раздела: заголовок (экранируется), произвольное тело и хвост шапки. */
export function panel(title, inner, head = "") {
  return `
    <div class="slice-panel">
      <div class="slice-panel-head"><b>${esc(title)}</b>${head ? ` ${head}` : ""}</div>
      ${inner}
    </div>`;
}
