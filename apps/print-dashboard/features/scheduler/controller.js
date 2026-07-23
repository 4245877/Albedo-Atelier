/* ═══════════════════════════════════════════════════════════════
   Раздел «Планировщик печати» — controller. Ручная очередь и планирование
   через новую SQLite-модель (/api/print/scheduler). Честно показывает:
   очередь заданий с приоритетом/дедлайном/notBefore/предпочтением
   день-ночь и закреплением принтера; матрицу совместимости
   task × printer (совместимо / проверить / заблокировано) с причинами;
   черновик плана с таймлайном по принтерам, объяснением рекомендаций
   (почему принтер, альтернативы, из чего сложился score, warnings),
   подтверждение плана и пересчёт (новая ревизия-черновик); отдельный
   блок ночных кандидатов. Никаких команд запуска принтера здесь нет.
   Разметка — view.js; снапшоты форм (optimistic locking) — editSnapshot.js.
   ═══════════════════════════════════════════════════════════════ */

import { apiGet, apiPost } from "../../api.js";
import { createInflightGuard } from "../../shared/inflight.js";
import { createPoller } from "../../shared/polling.js";
import { inputToIso } from "../../shared/format.js";
import { $, esc, toast } from "../../util.js";
import { createSnapshot, isSnapshotStale, paramsPayload } from "./editSnapshot.js";
import {
  addTaskHtml,
  compatibilityHtml,
  errorBanner,
  nightHtml,
  planHtml,
  queueHtml
} from "./view.js";

const POLL_MS = 8000;

const state = {
  queue: [],
  matrix: { printers: [], rows: [] },
  plans: [],
  plan: null,
  night: null,
  loaded: false,
  /* Ошибка последнего опроса — показывается ОТДЕЛЬНО от данных (баннер), а не
     затирает уже загруженное. Сбрасывается следующим успешным опросом. */
  error: null
};
let wired = false;
/* Защита мутаций: повторное нажатие с тем же ключом игнорируется, пока
   предыдущая операция ещё в полёте (см. shared/inflight.js). */
const mutations = createInflightGuard();
/**
 * Immutable per-form edit snapshots, keyed by task id, taken when the operator
 * OPENS a form. Submits read `expectedVersion` from here — never from the
 * poll-refreshed `state` — so stale data can only produce an honest 409.
 */
const editSnapshots = new Map();

/* Единый поллер: single-flight + latest-only + отмена + чистый стоп. Следующий
   опрос планируется ПОСЛЕ завершения предыдущего (пересечения исключены), а
   устаревший ответ, пришедший позже нового, отбрасывается и не трогает UI. */
const poller = createPoller({
  run: (signal) => fetchAll(signal),
  apply: (out, context) => applyAll(out, context),
  onError: (err) => onLoadError(err),
  intervalMs: POLL_MS,
  immediate: true,
  // Автоматические тики — «фоновые»: не рушат открытую форму (см. applyAll).
  pollContext: { fromPoll: true }
});

export function setupScheduler() {
  const body = $("#scheduler-body");
  if (!body) return;
  body.innerHTML = `<div class="slice-loading">Загрузка планировщика…</div>`;
  if (!wired) {
    wireDelegates();
    // Уход со страницы должен снять таймер и оборвать активный запрос.
    window.addEventListener("pagehide", () => poller.stop());
    wired = true;
  }
  // Первичная загрузка — не «фоновая»: снимок форм неактуален, можно рендерить.
  poller.start({ fromPoll: false });
}

/*
 * Собирает состояние раздела за один цикл. Ключевое отличие от прежней логики:
 * при частичном отказе НЕ подставляется пустой массив — сбойный источник просто
 * отсутствует в результате (undefined), и applyAll сохраняет прежнее значение.
 * Полный отказ (ни одного полезного ответа) пробрасывается как ошибка → onError.
 * Отмена (вытеснение/стоп) пробрасывается, чтобы поллер её тихо проглотил.
 */
async function fetchAll(signal) {
  const settled = await Promise.allSettled([
    apiGet("/api/print/scheduler/queue", { signal }),
    apiGet("/api/print/scheduler/compatibility", { signal }),
    apiGet("/api/print/scheduler/plans", { signal }),
    apiGet("/api/print/scheduler/night", { signal })
  ]);
  for (const r of settled) {
    if (r.status === "rejected" && r.reason?.name === "AbortError") throw r.reason;
  }
  const [queueR, matrixR, plansR, nightR] = settled;
  const out = { errors: [] };
  if (queueR.status === "fulfilled") out.queue = queueR.value.queue || [];
  else out.errors.push(queueR.reason);
  if (matrixR.status === "fulfilled") out.matrix = { printers: matrixR.value.printers || [], rows: matrixR.value.rows || [] };
  else out.errors.push(matrixR.reason);
  if (plansR.status === "fulfilled") out.plans = plansR.value.plans || [];
  else out.errors.push(plansR.reason);
  // night может законно быть null (нет ночного окна) — это НЕ ошибка.
  if (nightR.status === "fulfilled") out.night = nightR.value ?? null;
  else out.errors.push(nightR.reason);

  // Freshest live plan — детали только если список планов удалось получить.
  if (out.plans !== undefined) {
    const latest = pickLatestPlan(out.plans);
    if (!latest) {
      out.plan = null;
    } else {
      try {
        out.plan = await apiGet(`/api/print/scheduler/plans/${latest.id}`, { signal });
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        out.plan = null;
        out.errors.push(err);
      }
    }
  }

  const gotAnything =
    out.queue !== undefined || out.matrix !== undefined || out.plans !== undefined || out.night !== undefined;
  if (!gotAnything) throw out.errors[0] || new Error("Backend недоступен");
  return out;
}

/**
 * Чистое слияние: отсутствующий (сбойный) источник сохраняет прежнее значение,
 * успешный — заменяет. Ошибка живёт отдельным полем и сбрасывается при успехе.
 * Вынесено ради юнит-теста (частичная ошибка не затирает последние данные).
 */
export function mergeSchedulerState(prev, out) {
  return {
    queue: out.queue !== undefined ? out.queue : prev.queue,
    matrix: out.matrix !== undefined ? out.matrix : prev.matrix,
    plans: out.plans !== undefined ? out.plans : prev.plans,
    plan: "plan" in out ? out.plan : prev.plan,
    night: out.night !== undefined ? out.night : prev.night,
    loaded: true,
    error: out.errors && out.errors.length ? out.errors[0]?.message || "часть данных недоступна" : null
  };
}

function applyAll(out, context = {}) {
  Object.assign(state, mergeSchedulerState(state, out));
  // Фоновый опрос не должен рушить наполовину заполненную форму: только тогда
  // пропускаем перерисовку (состояние уже обновлено), помечая формы устаревшими.
  if (!(context.fromPoll && isEditing())) {
    editSnapshots.clear();
    render();
  } else {
    markStaleForms();
  }
}

function onLoadError(err) {
  const body = $("#scheduler-body");
  if (!body) return;
  if (!state.loaded) {
    // Ещё ничего не показывали — честный экран немоты backend.
    body.innerHTML = `<div class="slice-loading">Backend безмолвствует, Владыка — раздел вернётся, едва связь будет восстановлена.</div>`;
    return;
  }
  // Данные уже были — НЕ стираем их, показываем ошибку отдельным баннером.
  state.error = err?.message || "backend не отвечает";
  render();
}

/** The freshest plan worth showing: newest non-terminal (drafts/active), not a cancelled/superseded one. */
function pickLatestPlan(plans) {
  const live = plans.filter((p) => p.state !== "CANCELLED" && p.state !== "COMPLETED");
  if (!live.length) return null;
  return [...live].sort(
    (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) || b.revision - a.revision
  )[0];
}

/** True while the operator is mid-edit — an open params editor or focus in a section input. */
function isEditing() {
  const body = $("#scheduler-body");
  if (!body) return false;
  if (body.querySelector('[data-sch-form="params"]:not([hidden])')) return true;
  const active = document.activeElement;
  return Boolean(active && body.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName));
}

/* ── Отрисовка (разметка — view.js) ─────────────────────────── */

function render() {
  const body = $("#scheduler-body");
  if (!body) return;
  body.innerHTML = [
    errorBanner(state),
    queueHtml(state),
    addTaskHtml(),
    compatibilityHtml(state),
    planHtml(state),
    nightHtml(state)
  ].join("");
}

/* ── Действия (делегированные) ──────────────────────────────── */

function wireDelegates() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sch-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.schAction;
    if (!action) return;
    e.preventDefault();
    const id = btn.dataset.id;
    const rowEl = btn.closest("[data-task]");
    const taskId = rowEl?.dataset.task;

    if (action === "toggle-edit") {
      const form = rowEl?.querySelector('[data-sch-form="params"]');
      if (form) {
        form.hidden = !form.hidden;
        if (!form.hidden && taskId) {
          // Opening the editor freezes the edit snapshot for this task.
          const row = state.queue.find((r) => r.task.id === taskId);
          if (row) editSnapshots.set(taskId, createSnapshot(row.task));
        } else if (form.hidden && taskId) {
          editSnapshots.delete(taskId);
        }
      }
    } else if (action === "reload-form") {
      // Operator chose to re-read a stale form: re-render mints new snapshots.
      editSnapshots.clear();
      render();
    } else if (action === "up" || action === "down") {
      void moveTask(taskId, action, btn);
    } else if (action === "unpin") {
      void run(`unpin:${taskId}`, () => apiPost(`/api/print/scheduler/tasks/${taskId}/unpin`), "Закрепление снято, Владыка", btn);
    } else if (action === "build-plan") {
      void run("build-plan", () => apiPost("/api/print/scheduler/plans", {}), "Черновик плана выстроен и ожидает вашего суда", btn);
    } else if (action === "recompute") {
      void run(`recompute:${id}`, () => apiPost(`/api/print/scheduler/plans/${id}/recompute`), "План пересчитан заново (новая ревизия)", btn);
    } else if (action === "confirm") {
      void run(`confirm:${id}`, () => apiPost(`/api/print/scheduler/plans/${id}/confirm`), "План подтверждён — да исполнится ваша воля", btn);
    }
  });

  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-sch-form]");
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.schForm;
    const submitBtn = form.querySelector('button[type="submit"]');
    if (kind === "add") {
      const d = Object.fromEntries(new FormData(form).entries());
      const payload = { title: d.title };
      if (d.material) payload.material = d.material;
      if (d.priority) payload.priority = Number(d.priority);
      if (d.deadline) payload.deadline = inputToIso(d.deadline);
      void run("add-task", () => apiPost("/api/print/scheduler/queue", payload), "Задание принято в очередь — я позабочусь о нём, Владыка", submitBtn);
    } else if (kind === "params") {
      const rowEl = form.closest("[data-task]");
      const taskId = rowEl?.dataset.task;
      const d = Object.fromEntries(new FormData(form).entries());
      void saveParams(taskId, form, d, submitBtn);
    }
  });
}

async function saveParams(taskId, form, d, submitBtn) {
  // In-flight guard по ключу задания: двойное нажатие «Сохранить» не отправит
  // вторую одинаковую мутацию, пока первая ещё в полёте.
  const { skipped } = await mutations.run(`params:${taskId}`, async () => {
    if (submitBtn) submitBtn.disabled = true;
    // Everything the submit asserts — above all `expectedVersion` — comes from
    // the snapshot frozen when the form OPENED, never from the poll-refreshed
    // state. Stale data therefore reaches the server with the OLD version and
    // gets an honest 409 instead of silently clobbering a newer edit.
    const snapshot = editSnapshots.get(taskId) ?? null;
    const payload = paramsPayload(snapshot, {
      priority: d.priority,
      dayNightPreference: d.dayNightPreference,
      notBefore: d.notBefore ? inputToIso(d.notBefore) : null,
      deadline: d.deadline ? inputToIso(d.deadline) : null,
      unattendedAllowed: form.querySelector('[name="unattended"]').checked
    });
    try {
      await apiPost(`/api/print/scheduler/tasks/${taskId}/params`, payload);
      const pin = d.pin;
      if (pin) await apiPost(`/api/print/scheduler/tasks/${taskId}/pin`, { printer: pin });
      editSnapshots.delete(taskId);
      toast("Параметры сохранены в точности, как вы повелели", "toast-ok");
    } catch (err) {
      const conflict = /409|конфликт|version/i.test(String(err.message || ""));
      toast(
        esc(conflict
          ? "Владыка, задание изменили в другом окне — я перечитала форму; соблаговолите проверить и сохранить заново"
          : `Простите, Владыка — сохранить не удалось: ${err.message || "причина неизвестна"}`),
        "toast-danger"
      );
      editSnapshots.delete(taskId);
    } finally {
      // Кнопка обязательно возвращается в рабочее состояние — в т.ч. при ошибке.
      if (submitBtn) submitBtn.disabled = false;
    }
  });
  // Внеочередное обновление раздела — но не для проигнорированного дубля.
  if (!skipped) poller.refresh({ fromPoll: false });
}

/**
 * Marks every open params form whose task moved on the server since its
 * snapshot: a visible banner + the honest promise that saving will conflict.
 * The form's own values and snapshot are NOT touched.
 */
function markStaleForms() {
  const body = $("#scheduler-body");
  if (!body) return;
  for (const form of body.querySelectorAll('[data-sch-form="params"]:not([hidden])')) {
    const rowEl = form.closest("[data-task]");
    const taskId = rowEl?.dataset.task;
    if (!taskId) continue;
    const snapshot = editSnapshots.get(taskId);
    const current = state.queue.find((r) => r.task.id === taskId)?.task ?? null;
    const stale = isSnapshotStale(snapshot, current);
    let banner = form.querySelector(".sch-stale");
    if (stale && !banner) {
      banner = document.createElement("div");
      banner.className = "sch-stale slice-warn";
      banner.innerHTML =
        `⚠ Владыка, задание изменили в другом окне — эта форма устарела, и сохранение честно вернёт конфликт. ` +
        `<button type="button" class="btn btn-sm" data-sch-action="reload-form">Перечитать</button>`;
      form.prepend(banner);
    } else if (!stale && banner) {
      banner.remove();
    }
  }
}

async function moveTask(taskId, dir, btn) {
  const idx = state.queue.findIndex((r) => r.task.id === taskId);
  if (idx < 0) return;
  const row = state.queue[idx];
  const neighbourIdx = dir === "up" ? idx - 1 : idx + 1;
  const neighbour = state.queue[neighbourIdx];
  if (!neighbour) return;
  // Move past the neighbour: server re-sorts by position.
  const position = dir === "up" ? neighbour.entry.position - 1 : neighbour.entry.position + 1;
  await run(
    `reorder:${taskId}`,
    () => apiPost(`/api/print/scheduler/tasks/${taskId}/reorder`, {
      position,
      expectedVersion: row.entry.version
    }),
    "Порядок в очереди перестроен, Владыка",
    btn
  );
}

/**
 * Единый исполнитель мутации: in-flight guard по ключу (двойное нажатие не
 * порождает вторую одинаковую мутацию), блокировка кнопки на время операции с
 * гарантированным возвратом в finally, разумный таймаут наследуется от apiPost.
 */
async function run(key, fn, okMsg, btn) {
  const { skipped } = await mutations.run(key, async () => {
    if (btn) btn.disabled = true;
    try {
      await fn();
      toast(okMsg, "toast-ok");
    } catch (err) {
      toast(`Простите, Владыка — приказ не исполнен: ${esc(err.message || "причина неизвестна")}`, "toast-danger");
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  if (!skipped) poller.refresh({ fromPoll: false });
}
