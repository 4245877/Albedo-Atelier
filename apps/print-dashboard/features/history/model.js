/* ── История печати: модель ───────────────────────────────────────
   Чистый модуль (без DOM и сети): подписи и выбор того, что показать для
   записи истории. Можно ли напечатать ещё раз, повторить попытку или
   подготовить модель заново — решает сервер (`actions` у каждой записи, те
   же правила, что исполняют команды); здесь только язык и порядок кнопок. */

export const STATE_FILTERS = [
  { id: "", label: "Все" },
  { id: "COMPLETED", label: "Напечатано" },
  { id: "FAILED", label: "Не удалось" },
  { id: "CANCELLED", label: "Отменено" }
];

export const STATE_LABEL = { COMPLETED: "напечатано", FAILED: "не удалось", CANCELLED: "отменено" };
export const STATE_TONE = { COMPLETED: "ok", FAILED: "error", CANCELLED: "mute" };

const RUN_LABEL = {
  SUCCEEDED: "печать завершена",
  FAILED: "печать прервалась",
  CANCELLED: "печать остановлена",
  UNKNOWN: "исход не подтверждён",
  RUNNING: "печатается",
  PAUSED: "на паузе",
  PENDING: "запуск не подтверждён"
};

export function runLabel(state) {
  return RUN_LABEL[state] || state || "—";
}

/**
 * Главная кнопка записи. Неудавшуюся печать естественнее повторить тем же
 * заданием (попытка остаётся в его истории); завершённую или отменённую —
 * напечатать ещё раз новой печатью тех же байт. Когда файла больше нет,
 * остаётся подготовить модель заново тем же рецептом.
 */
export function primaryAction(entry) {
  const a = (entry && entry.actions) || {};
  if (entry.state === "FAILED" && a.retry && a.retry.allowed) return { kind: "retry", label: "Повторить" };
  if (a.reprint && a.reprint.allowed) return { kind: "reprint", label: "Напечатать ещё раз" };
  if (a.reprepare) return { kind: "reprepare", label: "Подготовить заново" };
  return null;
}

/** Остальные доступные действия — без повтора главного. */
export function secondaryActions(entry) {
  const a = (entry && entry.actions) || {};
  const primary = primaryAction(entry);
  const out = [];
  if (a.reprint && a.reprint.allowed && (!primary || primary.kind !== "reprint")) {
    out.push({ kind: "reprint", label: "Новой печатью" });
  }
  if (a.reprepare && (!primary || primary.kind !== "reprepare")) {
    out.push({ kind: "reprepare", label: "Подготовить заново" });
  }
  return out;
}

/** Почему этот файл нельзя напечатать как есть — словами сервера, или null. */
export function blockedReason(entry) {
  const reprint = entry && entry.actions && entry.actions.reprint;
  return reprint && !reprint.allowed ? reprint.reason || null : null;
}

/** Масштаб нарезки по-человечески: 1 — это миллиметры как есть. */
export function scaleText(factor) {
  if (factor == null) return null;
  if (Math.abs(factor - 1) < 1e-9) return "1:1 (миллиметры)";
  return `×${Math.round(factor * 1000) / 1000}`;
}

/**
 * Настройки, с которыми печать сделана, — строки «что — чем». Записаны в момент
 * нарезки (вариант и его закреплённые ревизии профилей), поэтому это то, что
 * действительно использовалось, а не то, что рецепт говорит сегодня.
 */
export function recipeLines(entry) {
  const r = entry && entry.recipe;
  if (!r) return [];
  return [
    ["Рецепт", r.profileSetName || r.profileSetId],
    ["Профиль принтера", r.machine],
    ["Профиль печати", r.process],
    ["Филамент", r.filament],
    ["Масштаб", scaleText(r.scaleFactor)],
    ["OrcaSlicer", r.orcaVersion]
  ].filter(([, value]) => value != null && value !== "");
}

/** Выбор для мастера «Новая печать» по «Подготовить заново». */
export function reprepareSelection(entry) {
  const hint = entry && entry.actions && entry.actions.reprepare;
  if (!hint) return null;
  return {
    artifactId: hint.artifactId,
    printerId: hint.printerId || null,
    setId: hint.profileSetId || null,
    previousTaskId: entry.taskId
  };
}

/** Принтер, который окно запуска проверит первым после повтора. */
export function launchPrinterFor(entry) {
  return (entry && entry.run && entry.run.printerId) || (entry && entry.recipe && entry.recipe.targetPrinterId) || null;
}

/** Параметры запроса страницы истории. */
export function historyQuery({ state = "", cursor = null, limit = 30 } = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (state) params.set("state", state);
  if (cursor) params.set("cursor", cursor);
  return `/api/print/history?${params.toString()}`;
}
