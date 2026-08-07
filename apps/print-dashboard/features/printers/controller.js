/* ═══════════════════════════════════════════════════════════════
   Раздел «Оборудование фермы» — controller.

   Ради чего раздел существует: подключение и настройка принтера перестают
   быть правкой файла в репозитории с последующей пересборкой. Добавить
   принтер, поправить адрес, ввести новый код доступа после сброса, отключить
   на время ремонта, проверить связь — всё здесь, и всё действует сразу.

   Три правила, которых держится этот модуль:
     • пустое поле учётных данных = «не менять» (см. formModel.js). Backend
       секретов не отдаёт, поэтому поля всегда пусты, и трактовать пустоту как
       «стереть» означало бы терять код доступа при каждом сохранении;
     • фоновый опрос не трогает раздел, пока оператор что-то печатает в форме
       или держит раскрытой панель настроек — незавершённую работу не сносим;
     • удаление принтера спрашивает подтверждение по имени: это единственное
       необратимое действие раздела.

   Разметка — view.js, преобразование формы в тело запроса — formModel.js.
   ═══════════════════════════════════════════════════════════════ */

import { apiDelete, apiGet, apiPatch, apiPost } from "../../api.js";
import { createInflightGuard } from "../../shared/inflight.js";
import { createPoller } from "../../shared/polling.js";
import { $, esc, toast } from "../../util.js";
import { buildPrinterPayload } from "./formModel.js";
import { addFormHtml, errorBanner, printersHtml } from "./view.js";

const POLL_MS = 15000;
const BASE = "/api/printers/config";

const state = {
  printers: [],
  options: null,
  /** Результат последней проверки связи, по id принтера. */
  tests: {},
  /** Какое действие сейчас в полёте, по id принтера (плюс __create). */
  busy: {},
  /** Протокол, выбранный в форме добавления — от него зависят поля формы. */
  draftProtocol: "moonraker",
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

export function setupPrinterConfig() {
  const body = $("#hardware-body");
  if (!body) return;
  body.innerHTML = `<div class="slice-loading">Загрузка списка оборудования…</div>`;
  if (!wired) {
    wireDelegates();
    window.addEventListener("pagehide", () => poller.stop());
    wired = true;
  }
  poller.start({ fromPoll: false });
}

/* Частичный отказ не подставляет пустые данные: словарь протоколов меняется
   только с версией backend, поэтому его сбой не должен ронять список. */
async function fetchAll(signal) {
  const settled = await Promise.allSettled([
    apiGet(BASE, { signal }),
    apiGet(`${BASE}/options`, { signal })
  ]);
  for (const r of settled) {
    if (r.status === "rejected" && r.reason?.name === "AbortError") throw r.reason;
  }
  const [listR, optionsR] = settled;
  if (listR.status === "rejected") throw listR.reason;

  return {
    printers: listR.value.printers || [],
    ...(optionsR.status === "fulfilled" ? { options: optionsR.value } : {})
  };
}

function applyAll(out, context = {}) {
  state.printers = out.printers ?? state.printers;
  if (out.options !== undefined) state.options = out.options;
  state.loaded = true;
  state.error = null;
  // Фоновый тик не сносит наполовину заполненную форму.
  if (!(context.fromPoll && isEditing())) render();
}

function onLoadError(err) {
  const body = $("#hardware-body");
  if (!body) return;
  if (!state.loaded) {
    body.innerHTML = `<div class="slice-loading">Backend безмолвствует, Владыка — раздел вернётся, едва связь будет восстановлена.</div>`;
    return;
  }
  state.error = err?.message || "backend не отвечает";
  render();
}

function isEditing() {
  const body = $("#hardware-body");
  if (!body) return false;
  const active = document.activeElement;
  if (active && body.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return true;
  // Раскрытая панель настроек — тоже незавершённая работа оператора.
  return Boolean(body.querySelector("details.prn-details[open]"));
}

function render() {
  const body = $("#hardware-body");
  if (!body) return;
  body.innerHTML = [errorBanner(state), printersHtml(state), addFormHtml(state)].join("");
}

/* ── Чтение формы ──────────────────────────────────────────── */

/**
 * Раскладывает элементы формы на values (текст/селекты) и flags (чекбоксы).
 * Чекбоксы читаются по СОСТОЯНИЮ, а не по присутствию в FormData: снятая
 * галочка — такое же решение оператора, как поставленная, и она обязана
 * доехать до backend как false.
 */
export function readForm(form) {
  const values = {};
  const flags = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") flags[el.name] = el.checked;
    else values[el.name] = el.value;
  }
  return { values, flags };
}

/* ── Действия (делегированные) ─────────────────────────────── */

function wireDelegates() {
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-prn-form]");
    if (!form || !$("#hardware-body")?.contains(form)) return;
    e.preventDefault();
    if (form.dataset.prnForm === "create") void createPrinter(form);
    else void savePrinter(form);
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-prn-action]");
    if (!btn || btn.disabled || !$("#hardware-body")?.contains(btn)) return;
    e.preventDefault();
    const id = btn.dataset.id;
    if (btn.dataset.prnAction === "test") void testConnection(id);
    else if (btn.dataset.prnAction === "discover") void discoverHardware(id);
    else if (btn.dataset.prnAction === "toggle") void toggleEnabled(id, btn.dataset.enabled !== "1");
    else if (btn.dataset.prnAction === "remove") void removePrinter(id);
  });

  // Выбор протокола перестраивает форму добавления: у Bambu спрашиваем серийный
  // номер и код доступа, у Creality — ничего. Показывать все поля всем значило бы
  // требовать несуществующие данные.
  document.addEventListener("change", (e) => {
    const select = e.target.closest("[data-prn-draft-protocol]");
    if (!select || !$("#hardware-body")?.contains(select)) return;
    state.draftProtocol = select.value;
    render();
    // Возвращаем фокус на селект — перерисовка не должна сбивать ввод.
    $("#hardware-body")?.querySelector("[data-prn-draft-protocol]")?.focus();
  });
}

/**
 * Одна обёртка на все мутации: single-flight по ключу, пометка «занято» для
 * кнопок, toast и внеочередной опрос после успеха.
 */
async function run(id, action, fn, okMessage) {
  const key = `${id}:${action}`;
  state.busy[id] = action;
  const { skipped } = await mutations.run(key, async () => {
    try {
      await fn();
      if (okMessage) toast(okMessage, "toast-ok");
    } catch (err) {
      if (err?.name === "AbortError") return;
      toast(`Не вышло: ${esc(err?.message || "ошибка")}`, "toast-danger");
    }
  });
  delete state.busy[id];
  if (!skipped) await poller.refresh({ fromPoll: false });
  else render();
}

function createPrinter(form) {
  const payload = buildPrinterPayload(readForm(form), { create: true });
  return run("__create", "create", () => apiPost(BASE, payload), "Принтер добавлен в ферму");
}

function savePrinter(form) {
  const id = form.dataset.id;
  const payload = buildPrinterPayload(readForm(form));
  return run(id, "save", () => apiPatch(`${BASE}/${encodeURIComponent(id)}`, payload), "Настройки сохранены и уже действуют");
}

function toggleEnabled(id, enabled) {
  return run(
    id,
    "toggle",
    () => apiPost(`${BASE}/${encodeURIComponent(id)}/enabled`, { enabled }),
    enabled ? "Принтер снова в работе" : "Принтер отключён — опрос и очередь его больше не трогают"
  );
}

async function testConnection(id) {
  state.busy[id] = "test";
  render();
  const { skipped } = await mutations.run(`${id}:test`, async () => {
    try {
      const res = await apiPost(`${BASE}/${encodeURIComponent(id)}/test`, {});
      state.tests[id] = res.result;
      toast(
        res.result?.online
          ? "Принтер ответил — настройки верны"
          : "Принтер не ответил: см. причину в карточке",
        res.result?.online ? "toast-ok" : "toast-danger"
      );
    } catch (err) {
      if (err?.name === "AbortError") return;
      state.tests[id] = { online: false, error: err?.message || "ошибка", checkedAt: null };
      toast(`Проверка не удалась: ${esc(err?.message || "ошибка")}`, "toast-danger");
    }
  });
  delete state.busy[id];
  if (!skipped) await poller.refresh({ fromPoll: false });
  else render();
}

/**
 * Внеочередной опрос характеристик. Обычно этого делать не нужно — сервис
 * переспрашивает принтеры сам, — но после физической замены сопла или катушки
 * ждать интервал незачем.
 *
 * Опрос не меняет на принтере ничего: он только просит устройство рассказать о
 * себе, поэтому безопасен и во время печати.
 */
function discoverHardware(id) {
  // Сообщение отдаём сами, а не через okMessage: «запрос прошёл» и «принтер
  // ответил» — разные вещи, и неудачный опрос не должен рапортовать об успехе.
  return run(id, "discover", async () => {
    const res = await apiPost(`${BASE}/${encodeURIComponent(id)}/discover`, {});
    const discovery = res.printer?.discovery;
    if (discovery && !discovery.succeeded) {
      toast(
        `Принтер не ответил на опрос${discovery.error ? `: ${esc(discovery.error)}` : ""} — прежние характеристики сохранены`,
        "toast-danger"
      );
      return;
    }
    toast("Характеристики обновлены с принтера", "toast-ok");
  });
}

/* Удаление — единственное необратимое действие раздела, поэтому подтверждение
   именное: у принтеров ферм имена похожи, и «вы уверены?» тут мало. */
function removePrinter(id) {
  const printer = state.printers.find((p) => p.id === id);
  const name = printer?.name || id;
  if (!window.confirm(`Удалить «${name}» из фермы? История печати сохранится, но принтер исчезнет из опроса, очереди и планировщика.`)) {
    return Promise.resolve();
  }
  return run(id, "remove", () => apiDelete(`${BASE}/${encodeURIComponent(id)}`), "Принтер удалён из фермы");
}
