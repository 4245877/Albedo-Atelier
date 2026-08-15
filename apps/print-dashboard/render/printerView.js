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
      return "Свободен — смиренно ожидает вашего повеления";
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

/* ── Модель действий карточки принтера ─────────────────────────
   Раньше карточка выкладывала восемь равновесных кнопок в один ряд («Открыть»,
   «Пауза», «Продолжить», «Отмена», «Подсветка», «Погасить», «Снимок»,
   «Снимок»): два действия назывались одинаково, две кнопки описывали одну
   лампу, а разрушающая «Отмена» стояла вплотную к безобидным. Взгляду не за
   что было зацепиться, и цена ошибки у соседних кнопок отличалась в тысячу раз.

   Теперь у карточки ОДНО главное действие (оно зависит от состояния машины),
   одно вспомогательное и меню «ещё» для всего остального.

   Отдельно разведены два разных «нельзя»:
     • НЕ ПОДДЕРЖИВАЕТСЯ — устройство этого не умеет в принципе (нет камеры,
       протокол не отдаёт файлы). Такое действие не рисуется ВОВСЕ: погашенная
       кнопка, которая не оживёт никогда, — это обещание, которого не будет.
     • ВРЕМЕННО НЕДОСТУПНО — умеет, но не сейчас (принтер не в сети, не
       печатает). Такое рисуется погашенным И называет причину. */

/** Ярлык главного действия зависит от того, что с машиной происходит. */
const PRIMARY_BY_STATUS = {
  printing: { act: "pause", label: "Пауза", icon: "pause" },
  paused: { act: "resume", label: "Продолжить", icon: "play" },
  error: { act: "open", label: "Разобраться", icon: "warn" },
  offline: { act: "open", label: "Диагностика", icon: "pulse" },
  idle: { act: "open", label: "Открыть", icon: "eye" },
  unknown: { act: "open", label: "Открыть", icon: "eye" },
};

/**
 * Полная модель действий по принтеру.
 *
 * @param {object} p   payload принтера
 * @param {{context?: "card"|"modal"}} opts
 * @returns {{primary: object|null, secondary: object|null, menu: object[]}}
 *   Каждый пункт: { act, label, icon, disabled, reason, danger, href }.
 */
export function printerActionModel(p, { context = "card" } = {}) {
  const can = actionAvailability(p);
  const offlineReason = "Принтер не в сети — команда не дойдёт";

  /** Пункт меню; `supported: false` выбрасывает его из модели целиком. */
  const item = (o) => (o.supported === false ? null : o);

  const all = [
    item({
      act: "pause", label: "Пауза", icon: "pause",
      disabled: !can.canPause,
      reason: can.canPause ? "" : can.offline ? offlineReason : "Принтер сейчас не печатает",
    }),
    item({
      act: "resume", label: "Продолжить", icon: "play",
      disabled: !can.canResume,
      reason: can.canResume ? "" : can.offline ? offlineReason : "Печать не поставлена на паузу",
    }),
    item({
      act: "cancel", label: "Отменить печать", icon: "cancelPrint", danger: true,
      disabled: !can.canCancel,
      reason: can.canCancel ? "" : "Сейчас нечего отменять — принтер не занят заданием",
    }),
    // Подсветка — ОДИН переключатель вместо пары «Подсветить / Погасить»:
    // состояние лампы видно по самой кнопке, а не по тому, какая из двух
    // одинаковых сейчас погашена.
    item({
      supported: can.lightSupported,
      act: "light",
      label: p.light === true ? "Погасить свет" : "Зажечь свет",
      icon: p.light === true ? "moon" : "sun",
      disabled: can.offline,
      reason: can.offline ? offlineReason : can.lightUnknown ? "Состояние лампы неизвестно — команда уйдёт вслепую" : "",
      pressed: p.light === true,
    }),
    item({
      supported: Boolean(p.snapshotAvailable),
      act: "snapshot", label: "Сделать снимок", icon: "shutter",
      disabled: can.offline,
      reason: can.offline ? offlineReason : "",
    }),
    // Ссылка на уже сохранённый кадр — не команда: она никогда не называется
    // так же, как «Сделать снимок» (прежде обе кнопки звались «Снимок»).
    item({
      supported: Boolean(p.latestSnapshotUrl),
      act: "last-frame", label: "Последний кадр", icon: "frame",
      href: p.latestSnapshotUrl, external: true,
    }),
    item({
      supported: Boolean(p.filesSupported),
      act: "files", label: "Файлы на принтере", icon: "files",
      disabled: can.offline,
      reason: can.offline ? offlineReason : "",
    }),
    item({
      supported: Boolean(p.interfaceUrl),
      act: "interface", label: "Веб-интерфейс", icon: "external",
      href: p.interfaceUrl, external: true, absolute: true,
    }),
  ].filter(Boolean);

  const byAct = (a) => all.find((x) => x.act === a) || null;
  const spec = PRIMARY_BY_STATUS[p.status] || PRIMARY_BY_STATUS.unknown;

  let primary = null;
  if (spec.act === "open") {
    // В окне принтера «Открыть» бессмысленно — оно уже открыто.
    primary = context === "card"
      ? { act: "open", label: spec.label, icon: spec.icon }
      : byAct("snapshot") || byAct("files") || null;
  } else {
    primary = byAct(spec.act);
  }

  // Вспомогательное — то, за чем тянутся чаще всего: свет, затем снимок.
  const secondary = [byAct("light"), byAct("snapshot"), context === "card" ? byAct("open") : null]
    .filter((x) => x && x !== primary)[0] || null;

  const menu = all.filter((x) => x !== primary && x !== secondary);
  return { primary, secondary, menu };
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

/* ── Политика подсветки (payload state.lights) ─────────────────
   Причины решения приходят машинно-читаемыми (reason); здесь — единственная
   таблица их отображения. Причина описывает РЕШЕНИЕ автоматики, а не факт:
   фактическое состояние лампы видно по кнопкам и полю actual. */

export const LIGHT_REASON_TEXT = {
  manual_override: "ручное управление",
  monitoring_lease: "открыта панель мониторинга",
  solar_dark_active_print: "темно, принтер печатает",
  solar_dark: "тёмное время суток",
  solar_daylight: "дневное время",
  printer_inactive: "принтер неактивен",
  automation_disabled: "автоматика выключена",
  fallback_window: "используется резервное расписание",
  fixed_window: "фиксированное расписание",
  dark_unknown_safe_on: "нет расчёта темноты — включено для печати",
  unsupported: "не поддерживается",
};

/** "HH:MM" локального времени из ISO-строки; null, если она не парсится. */
function hhmmFromIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Однострочное описание решения подсветки для карточки и модального окна.
 * Возвращает ПЛОСКИЙ текст (вызывающий экранирует сам): желаемое состояние,
 * человекочитаемая причина, время следующего переключения и признак резерва.
 * Пустая строка — когда записи о подсветке нет (старый payload).
 */
export function lightPolicyLine(entry) {
  if (!entry) return "";
  if (!entry.supported || entry.reason === "unsupported") {
    return "Подсветка: не поддерживается";
  }
  const parts = [];
  if (entry.desired != null) parts.push(entry.desired ? "включить" : "выключить");
  parts.push(LIGHT_REASON_TEXT[entry.reason] || entry.reason);
  const at = entry.nextTransitionAt ? hhmmFromIso(entry.nextTransitionAt) : null;
  if (at) parts.push(`смена в ${at}`);
  if (entry.usingFallback && entry.reason !== "fallback_window") parts.push("резервное расписание");
  return `Подсветка: ${parts.join(" · ")}`;
}
