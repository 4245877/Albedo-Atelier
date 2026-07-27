/* ═══════════════════════════════════════════════════════════════
   Раздел «Оператор и ручные операции» — controller.

   Три вещи, ради которых раздел существует:
     • расписание оператора (таймзона, недельные окна, сон, исключения,
       отсутствие) — то, из чего планировщик узнаёт, когда есть человек;
     • очередь ожидающих физических операций с честной готовностью
       («снять можно с 08:00, потому что оператор спит»);
     • вынужденный простой принтеров, удерживаемых до подтверждения.

   Единственный способ закрыть операцию — кнопка «выполнено», то есть
   именованное подтверждение человека. Ни один сигнал телеметрии
   («принтер idle») сюда не ведёт: в этом состоянии деталь как раз лежит
   на столе. Разметка — view.js.
   ═══════════════════════════════════════════════════════════════ */

import { apiGet, apiPost, apiDelete } from "../../api.js";
import { createInflightGuard } from "../../shared/inflight.js";
import { createPoller } from "../../shared/polling.js";
import { inputToIso } from "../../shared/format.js";
import { $, esc, toast } from "../../util.js";
import { errorBanner, holdsHtml, operationsHtml, scheduleHtml } from "./view.js";

const POLL_MS = 10000;

const state = {
  schedule: null,
  operators: [],
  localToday: null,
  operations: [],
  holds: [],
  types: [],
  printers: [],
  loaded: false,
  error: null
};
let wired = false;
const mutations = createInflightGuard();

const poller = createPoller({
  run: (signal) => fetchAll(signal),
  apply: (out, context) => applyAll(out, context),
  onError: (err) => onLoadError(err),
  intervalMs: POLL_MS,
  immediate: true,
  pollContext: { fromPoll: true }
});

export function setupOperations() {
  const body = $("#operations-body");
  if (!body) return;
  body.innerHTML = `<div class="slice-loading">Загрузка расписания…</div>`;
  if (!wired) {
    wireDelegates();
    window.addEventListener("pagehide", () => poller.stop());
    wired = true;
  }
  poller.start({ fromPoll: false });
}

/*
 * Частичный отказ НЕ подставляет пустые данные: сбойный источник просто
 * отсутствует в результате, и mergeOperationsState сохраняет прежнее значение.
 * Полный отказ пробрасывается как ошибка, отмена — тихо проглатывается поллером.
 */
async function fetchAll(signal) {
  const settled = await Promise.allSettled([
    apiGet("/api/print/schedule", { signal }),
    apiGet("/api/print/operations", { signal }),
    apiGet("/api/print/operations/types", { signal }),
    apiGet("/api/print/scheduler/compatibility", { signal })
  ]);
  for (const r of settled) {
    if (r.status === "rejected" && r.reason?.name === "AbortError") throw r.reason;
  }
  const [scheduleR, opsR, typesR, matrixR] = settled;
  const out = { errors: [] };
  if (scheduleR.status === "fulfilled") {
    out.schedule = scheduleR.value.schedule ?? null;
    out.operators = scheduleR.value.operators || [];
    out.localToday = scheduleR.value.localToday ?? null;
  } else out.errors.push(scheduleR.reason);
  if (opsR.status === "fulfilled") {
    out.operations = opsR.value.operations || [];
    out.holds = opsR.value.holds || [];
  } else out.errors.push(opsR.reason);
  if (typesR.status === "fulfilled") out.types = typesR.value.types || [];
  else out.errors.push(typesR.reason);
  // Список принтеров нужен только для формы создания операции — его отказ
  // не должен ронять раздел.
  if (matrixR.status === "fulfilled") out.printers = matrixR.value.printers || [];

  const gotAnything =
    out.schedule !== undefined || out.operations !== undefined || out.types !== undefined;
  if (!gotAnything) throw out.errors[0] || new Error("Backend недоступен");
  return out;
}

/** Чистое слияние (вынесено ради юнит-теста): сбойный источник сохраняет прежнее. */
export function mergeOperationsState(prev, out) {
  return {
    schedule: "schedule" in out ? out.schedule : prev.schedule,
    operators: out.operators !== undefined ? out.operators : prev.operators,
    localToday: "localToday" in out ? out.localToday : prev.localToday,
    operations: out.operations !== undefined ? out.operations : prev.operations,
    holds: out.holds !== undefined ? out.holds : prev.holds,
    types: out.types !== undefined ? out.types : prev.types,
    printers: out.printers !== undefined ? out.printers : prev.printers,
    loaded: true,
    error:
      out.errors && out.errors.length
        ? out.errors[0]?.message || "часть данных недоступна"
        : null
  };
}

function applyAll(out, context = {}) {
  Object.assign(state, mergeOperationsState(state, out));
  // Фоновый тик не рушит наполовину заполненную форму подтверждения.
  if (!(context.fromPoll && isEditing())) render();
}

function onLoadError(err) {
  const body = $("#operations-body");
  if (!body) return;
  if (!state.loaded) {
    body.innerHTML = `<div class="slice-loading">Backend безмолвствует, Владыка — раздел вернётся, едва связь будет восстановлена.</div>`;
    return;
  }
  state.error = err?.message || "backend не отвечает";
  render();
}

function isEditing() {
  const body = $("#operations-body");
  if (!body) return false;
  const active = document.activeElement;
  if (active && body.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return true;
  // Открытый <details> — тоже незавершённая работа оператора.
  return Boolean(body.querySelector("details.ops-details[open]"));
}

function render() {
  const body = $("#operations-body");
  if (!body) return;
  body.innerHTML = [
    errorBanner(state),
    scheduleHtml(state),
    operationsHtml(state),
    holdsHtml(state)
  ].join("");
}

/* ── Действия (делегированные) ──────────────────────────────── */

function wireDelegates() {
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-ops-form]");
    if (!form || !$("#operations-body")?.contains(form)) return;
    e.preventDefault();
    const kind = form.dataset.opsForm;
    if (kind === "schedule") void saveSchedule(form);
    else if (kind === "exception") void addException(form);
    else if (kind === "absence") void addAbsence(form);
    else if (kind === "open") void openOperation(form);
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ops-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.opsAction;
    // Кнопки внутри <form> уже обработаны submit-обработчиком выше.
    if (["save-schedule", "add-exception", "add-absence", "open-op"].includes(action)) return;
    e.preventDefault();
    const id = btn.dataset.id;
    if (action === "drop-exception") void run(`ex:${id}`, () => apiDelete(`/api/print/schedule/exceptions/${id}`), "Исключение снято");
    else if (action === "drop-absence") void run(`ab:${id}`, () => apiDelete(`/api/print/schedule/absences/${id}`), "Отсутствие снято");
    else if (action === "claim") void claim(id);
    else if (action === "complete") void complete(btn, id);
    else if (action === "fail") void failOperation(btn, id);
    else if (action === "cancel-op") void cancelOperation(id);
  });
}

/**
 * Одна обёртка на все мутации: single-flight по ключу (повторное нажатие, пока
 * предыдущая операция в полёте, игнорируется), toast и внеочередной опрос после
 * успеха. Пропущенный из-за занятого ключа вызов не перезагружает раздел.
 */
async function run(key, fn, okMessage) {
  const { skipped } = await mutations.run(key, async () => {
    try {
      await fn();
      if (okMessage) toast(okMessage);
    } catch (err) {
      if (err?.name === "AbortError") return;
      toast(`Не вышло: ${esc(err?.message || "ошибка")}`);
    }
  });
  if (!skipped) await poller.refresh({ fromPoll: false });
}

async function saveSchedule(form) {
  const data = new FormData(form);
  const available = [];
  const sleep = [];
  for (const row of form.querySelectorAll(".ops-edit-row")) {
    const weekday = Number(row.dataset.weekday);
    const get = (name) => row.querySelector(`[name="${name}"]`)?.value || "";
    const av = { start: get("av-start"), end: get("av-end") };
    const sl = { start: get("sl-start"), end: get("sl-end") };
    if (av.start && av.end) available.push({ weekday, ...av });
    if (sl.start && sl.end) sleep.push({ weekday, ...sl });
  }
  const timeZone = (data.get("timeZone") || "").toString().trim();
  await run(
    "schedule",
    () => apiPost("/api/print/schedule", { timeZone: timeZone || null, available, sleep }),
    "Расписание сохранено"
  );
}

async function addException(form) {
  const data = new FormData(form);
  const kind = (data.get("kind") || "available").toString();
  const body = {
    date: (data.get("date") || "").toString(),
    kind,
    note: (data.get("note") || "").toString() || null
  };
  if (kind !== "off") {
    body.start = (data.get("start") || "").toString();
    body.end = (data.get("end") || "").toString();
  }
  await run("exception", () => apiPost("/api/print/schedule/exceptions", body), "Исключение добавлено");
}

async function addAbsence(form) {
  const data = new FormData(form);
  const startsAt = inputToIso((data.get("startsAt") || "").toString());
  const endsAt = inputToIso((data.get("endsAt") || "").toString());
  await run(
    "absence",
    () =>
      apiPost("/api/print/schedule/absences", {
        startsAt,
        endsAt: endsAt || null,
        reason: (data.get("reason") || "").toString() || null
      }),
    "Отсутствие записано"
  );
}

async function openOperation(form) {
  const data = new FormData(form);
  const minutes = Number(data.get("estimatedMinutes"));
  await run(
    "open-op",
    () =>
      apiPost("/api/print/operations", {
        type: (data.get("type") || "").toString(),
        printerId: (data.get("printerId") || "").toString(),
        ...(Number.isFinite(minutes) && data.get("estimatedMinutes") !== ""
          ? { estimatedMinutes: minutes }
          : {}),
        reason: (data.get("reason") || "").toString() || null
      }),
    "Операция создана"
  );
}

function claim(id) {
  const operatorId = state.schedule?.operator?.id || state.operators[0]?.id;
  if (!operatorId) {
    toast("Нет оператора, которому можно назначить операцию");
    return Promise.resolve();
  }
  return run(`claim:${id}`, () => apiPost(`/api/print/operations/${id}/claim`, { operatorId }), "Операция взята в работу");
}

/**
 * Подтверждение выполнения — единственный путь закрыть операцию (и, для
 * снятия модели / замены пластины, единственный путь перевести стол в CLEAR).
 * Фактическая длительность и подтвердивший берутся из формы строки.
 */
function complete(btn, id) {
  const row = btn.closest("[data-operation]");
  const form = row?.querySelector('[data-ops-form="complete"]');
  const data = form ? new FormData(form) : new FormData();
  const actual = Number(data.get("actualMinutes"));
  return run(
    `done:${id}`,
    () =>
      apiPost(`/api/print/operations/${id}/complete`, {
        ...(Number.isFinite(actual) && data.get("actualMinutes") !== ""
          ? { actualMinutes: actual }
          : {}),
        actor: (data.get("actor") || "").toString() || undefined,
        note: (data.get("note") || "").toString() || null
      }),
    "Выполнение подтверждено"
  );
}

function failOperation(btn, id) {
  const row = btn.closest("[data-operation]");
  const form = row?.querySelector('[data-ops-form="complete"]');
  const note = form ? new FormData(form).get("note") : "";
  return run(
    `fail:${id}`,
    () => apiPost(`/api/print/operations/${id}/fail`, { note: (note || "").toString() || null }),
    "Отмечено как неудавшееся — принтер остаётся удержанным"
  );
}

function cancelOperation(id) {
  return run(`cancel:${id}`, () => apiPost(`/api/print/operations/${id}/cancel`, {}), "Операция отменена");
}
