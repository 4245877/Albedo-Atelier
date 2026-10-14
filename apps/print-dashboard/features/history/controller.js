/* ── История печати: контроллер ──────────────────────────────────
   Связывает модель и разметку с сервером. Ничего не решает сам: «напечатать
   ещё раз», «повторить» и «подготовить заново» — запросы к серверу, который
   проверяет файл, анализ и рецепт; запуск — общее окно запуска, где сервер
   проверяет принтер, стол и материал. */

import { apiGet, apiPost } from "../../api.js";
import { gotoSection } from "../../nav.js";
import { openLaunchModal } from "../../render/modals.js";
import { $, esc, toast } from "../../util.js";
import { startNewPrintFrom } from "../newprint/controller.js";
import { historyQuery, launchPrinterFor, reprepareSelection } from "./model.js";
import { historyHtml } from "./view.js";

const PAGE = 30;
/* История меняется, когда печать заканчивается, — не чаще. */
const POLL_MS = 30000;

let wired = false;
let timer = null;
let loadSeq = 0;
const vm = {
  entries: [],
  filter: "",
  more: false,
  cursor: null,
  loading: true,
  error: null,
  busy: null,
  open: new Set()
};

/* Неотвеченный повтор печати, по записи: клик после потерянного ответа
   отправляет ТОТ ЖЕ requestId, и сервер возвращает уже созданную печать, а не
   делает вторую. Забывается после ответа сервера — успеха или отказа. */
const pendingReprint = new Map();

export function setupHistory() {
  const body = $("#history-body");
  if (!body) return;
  if (!wired) {
    wire(body);
    wired = true;
  }
  render();
  void load();
}

// ── Данные ──────────────────────────────────────────────────────────────────

/**
 * `append` — следующая (более ранняя) страница. Без него — обновление того,
 * что уже на экране: столько записей, сколько оператор успел пролистать.
 */
async function load({ append = false } = {}) {
  const seq = ++loadSeq;
  const limit = append ? PAGE : Math.min(100, Math.max(PAGE, vm.entries.length));
  try {
    const res = await apiGet(historyQuery({ state: vm.filter, cursor: append ? vm.cursor : null, limit }));
    if (seq !== loadSeq) return;
    vm.entries = append ? [...vm.entries, ...(res.entries || [])] : res.entries || [];
    vm.cursor = res.nextCursor || null;
    vm.more = Boolean(res.nextCursor);
    vm.error = null;
  } catch (err) {
    if (seq !== loadSeq) return;
    vm.error = `История не загрузилась: ${err.message || "причина неизвестна"} — повторю сам.`;
  } finally {
    if (seq === loadSeq) {
      vm.loading = false;
      render();
      schedule();
    }
  }
}

function schedule() {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    // Раздел скрыт — не тратим запросы; проверим позже.
    if (document.getElementById("history")?.hidden) schedule();
    else void load();
  }, POLL_MS);
}

function render() {
  const body = $("#history-body");
  if (!body) return;
  body.innerHTML = historyHtml(vm);
  const meta = $("#history-meta");
  if (meta) meta.textContent = vm.entries.length ? `показано: ${vm.entries.length}${vm.more ? "+" : ""}` : "завершённые печати";
}

// ── Действия ────────────────────────────────────────────────────────────────

function wire(body) {
  body.addEventListener("click", (e) => {
    const filter = e.target.closest("[data-hist-filter]");
    if (filter) {
      vm.filter = filter.dataset.histFilter || "";
      vm.loading = true;
      vm.entries = [];
      vm.open.clear();
      render();
      void load();
      return;
    }
    const btn = e.target.closest("[data-hist-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.histAction;
    const id = btn.dataset.id;
    if (action === "more") return void load({ append: true });
    if (action === "toggle") {
      if (vm.open.has(id)) vm.open.delete(id);
      else vm.open.add(id);
      return render();
    }
    const entry = vm.entries.find((x) => x.taskId === id);
    if (!entry) return;
    if (action === "reprepare") return reprepare(entry);
    if (action === "reprint") return void run(entry, reprint);
    if (action === "retry") return void run(entry, retry);
  });
}

/** Одна мутация за раз; ошибка — словами сервера; после — свежая история. */
async function run(entry, fn) {
  if (vm.busy) return;
  vm.busy = entry.taskId;
  render();
  try {
    await fn(entry);
  } catch (err) {
    toast(`Не получилось: ${esc(err.message || "причина неизвестна")}`, "toast-danger");
  } finally {
    vm.busy = null;
    await load();
  }
}

/** Новая печать тех же проверенных байт; затем — окно запуска для неё. */
async function reprint(entry) {
  const requestId = pendingReprint.get(entry.taskId) || newRequestId(entry.taskId);
  pendingReprint.set(entry.taskId, requestId);
  let res;
  try {
    res = await apiPost(`/api/print/tasks/${encodeURIComponent(entry.taskId)}/reprint`, { requestId });
  } catch (err) {
    // Сервер ответил отказом — повтор того же ключа ничего не изменит. Ответ
    // потерян (сеть, таймаут) — ключ сохраняем: следующий клик спросит, что вышло.
    if (err && err.status) pendingReprint.delete(entry.taskId);
    throw err;
  }
  pendingReprint.delete(entry.taskId);
  const taskId = res.task && res.task.task && res.task.task.id;
  toast(
    res.deduplicated
      ? `«${esc(entry.title)}» уже поставлено в очередь этим запросом`
      : `«${esc(entry.title)}» снова в очереди — тот же проверенный файл, без новой нарезки`,
    "toast-ok"
  );
  if (taskId) openLaunchModal(taskId, { printerId: launchPrinterFor(entry) });
}

/** Неудавшаяся печать — тем же заданием, обратно в очередь; затем окно запуска. */
async function retry(entry) {
  await apiPost(`/api/print/tasks/${encodeURIComponent(entry.taskId)}/release`, {});
  toast(`«${esc(entry.title)}» возвращено в очередь — попытка остаётся в его истории`, "toast-ok");
  openLaunchModal(entry.taskId, { printerId: launchPrinterFor(entry) });
}

/** Модель — заново, тем же рецептом: мастер «Новая печать» с готовым выбором. */
function reprepare(entry) {
  const selection = reprepareSelection(entry);
  if (!selection) return;
  startNewPrintFrom(selection);
  gotoSection("newprint");
}

function newRequestId(taskId) {
  const rand =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `reprint:${taskId}:${rand}`;
}
