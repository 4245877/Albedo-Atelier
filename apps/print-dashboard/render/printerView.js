/* ── Чистые view-helpers принтера ──────────────────────────────
   Одна точка правды для карточки (render/printers.js), модального окна
   (render/modals.js) и очереди (render/sections.js): занятость, строка
   состояния, доступность действий и progress bar. Никакого DOM — модуль
   выполняется и в Node (tests/printerView.test.mjs). */

import { esc } from "../util.js";

/** Принтер занят заданием: печатает или стоит на паузе. */
export function isBusy(p) {
  return p.status === "printing" || p.status === "paused";
}

/**
 * Пользовательская строка о состоянии принтера — общая для карточки и
 * модального окна. Все внешние строки (имя задания, текст ошибки)
 * экранируются; выделения — только классами, без inline-стилей.
 * Неизвестное значение статуса получает безопасный fallback, а не
 * «Свободен».
 */
export function jobLine(p) {
  if (isBusy(p)) {
    return p.job ? `Печатает: <b>${esc(p.job)}</b>` : "Печатает — название задания не определено";
  }
  switch (p.status) {
    case "error":
      return `<b class="job-error">${esc(p.error || "Ошибка")}</b>`;
    case "offline":
      return esc(p.error ? `Нет связи: ${p.error}` : "Нет связи с принтером");
    case "idle":
      return "Свободен — ожидает распоряжений";
    case "unknown":
    default:
      return esc(p.error || "Состояние неизвестно — принтер ещё не ответил");
  }
}

/**
 * Модель доступности действий по одному payload принтера. Карточка и
 * модальное окно рисуют кнопки каждый по-своему, но разрешают/запрещают
 * действия строго по этим флагам — расхождения между ними исключены.
 * Занятость конкретного запроса (двойной клик) отдельно ведёт actions.js
 * через свой inFlight-набор.
 */
export function actionAvailability(p) {
  const busy = isBusy(p);
  const offline = p.status === "offline";
  // Управляемость подсветки определяет ТОЛЬКО backend-флаг lightSupported —
  // читаемость состояния не означает, что подсветкой можно управлять.
  const lightSupported = Boolean(p.lightSupported);
  return {
    busy,
    offline,
    canPause: p.status === "printing",
    canResume: p.status === "paused",
    canCancel: busy,
    lightSupported,
    /** light === null: состояние подсветки неизвестно (команда уйдёт вслепую). */
    lightUnknown: p.light == null,
    canLightOn: lightSupported && p.light !== true && !offline,
    canLightOff: lightSupported && p.light !== false && !offline,
    // Доступность снимка определяет backend-флаг snapshotAvailable, а не
    // догадки по camera/cameraSrc.
    canSnapshot: Boolean(p.snapshotAvailable) && !offline,
    // Для unsupported-принтера кнопка «Файлы» остаётся кликабельной: по клику
    // показывается честное объяснение. Блокируется только там, где просмотр
    // поддержан, но принтер не в сети.
    canFiles: !(p.filesSupported && offline)
  };
}

/**
 * Прогресс к числу 0–100: null/undefined, пустая строка и NaN → null
 * («принтер не сообщает»), выход за диапазон обрезается.
 */
export function normalizeProgress(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/**
 * Единая разметка progress bar (`.progress > i`) с ARIA-атрибутами.
 * Возвращает "" когда прогресс неизвестен. `style` — фиксированные
 * отступы конкретного места вызова, не внешние данные.
 */
export function progressBarHtml(value, { paused = false, style = "" } = {}) {
  const pct = normalizeProgress(value);
  if (pct === null) return "";
  return `<div class="progress ${paused ? "is-paused" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Прогресс печати"${style ? ` style="${style}"` : ""}><i style="transform:scaleX(${(pct / 100).toFixed(4)})"></i></div>`;
}

/** Подпись «N%» к progress bar; em-dash когда прогресс не сообщается. */
export function progressPercentText(value) {
  const pct = normalizeProgress(value);
  return pct === null ? "—" : `${Math.round(pct)}%`;
}
