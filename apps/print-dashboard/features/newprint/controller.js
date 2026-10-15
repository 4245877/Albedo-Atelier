/* ── «Новая печать»: контроллер ──────────────────────────────────
   Связывает модель пути (model.js, batch.js) и разметку (view.js,
   batchView.js) с сервером. Ничего не решает сам: каждое действие —
   существующий запрос API (загрузка, единицы, нарезка, постановка в очередь),
   а запуск — общее окно запуска, где сервер проверяет принтер, стол и
   материал. План для ручной печати не нужен.

   Два режима одного пути: одна модель (или готовый файл) и пакет моделей под
   один рецепт. Выбор — в sessionStorage: переживает перезагрузку страницы. */

import { apiGet, apiPost, uploadArtifact } from "../../api.js";
import { openLaunchModal } from "../../render/modals.js";
import { $, esc, toast } from "../../util.js";
import { BATCH_RESET, BATCH_RESETS, resolveBatchFlow, toggleBatchFile } from "./batch.js";
import { batchHtml } from "./batchView.js";
import { fileKind, isSlicing, recipesFor, resolveFlow } from "./model.js";
import { newPrintHtml } from "./view.js";

const SELECTION_KEY = "albedo-newprint";
/* Пока идёт анализ или нарезка — часто; в покое — редко (кто-то мог загрузить
   файл или утвердить рецепт в другом разделе). */
const BUSY_POLL_MS = 3000;
const IDLE_POLL_MS = 20000;

let wired = false;
let timer = null;
let loadSeq = 0;
let selection = readSelection();
let data = { items: [], coverage: [], sets: [], variants: [], outputs: [], live: [] };
const ui = { busy: false, error: null, uploading: false };

export function setupNewPrint() {
  const body = $("#newprint-body");
  if (!body) return;
  body.innerHTML = `<div class="slice-loading">Готовлю новую печать…</div>`;
  if (!wired) {
    wireDelegates(body);
    wired = true;
  }
  void load();
}

/**
 * Начать путь с готового выбора — «Подготовить заново» из истории: модель,
 * принтер и рецепт той печати. Мастер проверит каждый шаг как обычно: рецепт,
 * который больше нельзя выбрать, просто не будет выбран.
 */
export function startNewPrintFrom(patch) {
  select({ ...RESETS.file, ...BATCH_RESET, mode: "single", ...patch });
  if (wired) {
    autoAdvance();
    render();
    void load();
  }
}

const isBatch = () => selection.mode === "batch";

// ── Данные ──────────────────────────────────────────────────────────────────

async function load() {
  const seq = ++loadSeq;
  const results = await Promise.allSettled([
    apiGet("/api/print/artifacts"),
    apiGet("/api/print/slicing/runtime"),
    apiGet("/api/print/slicing/profile-sets"),
    apiGet("/api/print/slicing/variants"),
    // Что принтеры делают сейчас — пометка рядом с каждым на шаге «Принтер».
    apiGet("/api/printers")
  ]);
  if (seq !== loadSeq) return; // ответ устарел — свежий запрос уже в пути
  const [artifacts, runtime, sets, variants, printers] = results;
  if (artifacts.status === "fulfilled") {
    const all = artifacts.value.artifacts || [];
    data.items = all;
    data.outputs = all.filter((a) => a.artifact && a.artifact.kind === "gcode");
  }
  if (runtime.status === "fulfilled") data.coverage = runtime.value.coverage || [];
  if (sets.status === "fulfilled") data.sets = sets.value.sets || [];
  if (variants.status === "fulfilled") data.variants = variants.value.variants || [];
  if (printers.status === "fulfilled") {
    data.live = Array.isArray(printers.value) ? printers.value : printers.value?.printers || [];
  }
  // Живое состояние принтеров лишь дополняет список выбора: без него путь
  // работает как прежде, поэтому баннер «не загрузилось» оно не поднимает.
  const failed = [artifacts, runtime, sets, variants].filter((r) => r.status === "rejected").length;
  ui.error = failed > 0 ? "Часть данных не загрузилась — показываю последнее известное, повторю сам." : null;

  autoAdvance();
  render();
  schedule();
}

const flowNow = () => (isBatch() ? resolveBatchFlow(selection, data) : resolveFlow(selection, data));

/** Очевидный выбор делается за оператора: единственный рецепт — выбран. */
function autoAdvance() {
  const flow = flowNow();
  if (flow.kind === "model" && flow.printer && !selection.setId) {
    const recipes = recipesFor(data.sets, flow.printer);
    if (recipes.length === 1) select({ setId: recipes[0].id });
  }
}

function schedule() {
  if (timer !== null) clearTimeout(timer);
  const flow = flowNow();
  const analysing = (isBatch() ? flow.items : flow.item ? [flow.item] : []).some(
    (it) => !it.analysis || ["pending", "running"].includes(it.analysis.state)
  );
  const busy = isBatch()
    ? analysing || flow.slicing || flow.outputPending || ui.error
    : analysing ||
      isSlicing(flow.variant) ||
      (flow.variant &&
        flow.variant.state === "ready" &&
        !data.outputs.some(
          (o) => o.artifact.id === flow.variant.outputArtifactId && o.analysis && o.analysis.state === "ready"
        )) ||
      ui.error;
  timer = setTimeout(() => {
    timer = null;
    // Раздел скрыт — не тратим запросы; проверим снова позже.
    if (document.getElementById("newprint")?.hidden) schedule();
    else void load();
  }, busy ? BUSY_POLL_MS : IDLE_POLL_MS);
}

function render() {
  const body = $("#newprint-body");
  if (!body) return;
  const flow = flowNow();
  body.innerHTML = isBatch() ? batchHtml({ flow, data, ui }) : newPrintHtml({ flow, data, ui });
}

// ── Выбор (переживает перезагрузку страницы) ────────────────────────────────

function readSelection() {
  try {
    const raw = sessionStorage.getItem(SELECTION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function select(patch) {
  selection = { ...selection, ...patch };
  try {
    sessionStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
  } catch {
    /* приватный режим — выбор просто не переживёт перезагрузку */
  }
}

/* Изменение шага сбрасывает всё, что из него следовало. */
const RESETS = {
  file: { artifactId: null, printerId: null, setId: null, variantId: null, taskId: null, previousTaskId: null },
  printer: { printerId: null, setId: null, variantId: null, taskId: null },
  recipe: { setId: null, variantId: null, taskId: null },
  slice: { variantId: null, taskId: null },
  result: { taskId: null }
};

// ── Действия ────────────────────────────────────────────────────────────────

function wireDelegates(body) {
  body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-np-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.npAction;
    const id = btn.dataset.id;
    if (action === "mode-batch") return pick({ ...RESETS.file, ...BATCH_RESET, mode: "batch" });
    if (action === "mode-single") return pick({ ...RESETS.file, ...BATCH_RESET, mode: "single" });
    if (action === "pick-printer") return pick({ ...(isBatch() ? BATCH_RESETS.printer : RESETS.printer), printerId: id });
    if (action === "pick-recipe") return pick({ ...(isBatch() ? BATCH_RESETS.recipe : RESETS.recipe), setId: id });
    if (action === "edit") return pick((isBatch() ? BATCH_RESETS : RESETS)[btn.dataset.step] || {});
    if (action === "restart") return pick({ ...RESETS.file, ...BATCH_RESET });
    if (action === "launch-task") return id ? launchTask(id) : undefined;
    // ── одна модель
    if (action === "pick-file") return pick({ ...RESETS.file, artifactId: id });
    if (action === "same-as-last") return pick({ ...RESETS.printer, printerId: btn.dataset.printer, setId: btn.dataset.set });
    if (action === "confirm-units") return void run(confirmUnits);
    if (action === "reanalyze") return void run(reanalyze);
    if (action === "slice") return void run(slice);
    if (action === "slice-again") return void run(sliceAgain);
    if (action === "promote") return void run(promote);
    if (action === "launch") return void run(launch);
    // ── пакет
    if (action === "batch-units") return void run(confirmBatchUnits);
    if (action === "batch-files-done") return pick({ filesConfirmed: true });
    if (action === "batch-slice") return void run(sliceBatch);
    if (action === "batch-promote") return void run(promoteBatch);
  });
  body.addEventListener("change", (e) => {
    const toggle = e.target.closest("[data-np-batch-toggle]");
    if (toggle) {
      return pick({ ...BATCH_RESETS.file, artifactIds: toggleBatchFile(selection.artifactIds, toggle.dataset.npBatchToggle) });
    }
    const input = e.target.closest("[data-np-upload]");
    if (input && input.files && input.files.length > 0) void upload([...input.files]);
  });
}

function pick(patch) {
  select(patch);
  autoAdvance();
  render();
  schedule();
}

/** Одна мутация за раз; ошибка — словами сервера; после — свежие данные. */
async function run(fn) {
  if (ui.busy) return;
  ui.busy = true;
  render();
  try {
    await fn();
  } catch (err) {
    toast(`Не получилось: ${esc(err.message || "причина неизвестна")}`, "toast-danger");
  } finally {
    ui.busy = false;
    await load();
  }
}

/** Загрузка: одна модель — сразу выбрана; в пакете каждая добавляется к выбору. */
async function upload(files) {
  if (ui.uploading) return;
  ui.uploading = true;
  render();
  try {
    for (const file of isBatch() ? files : files.slice(0, 1)) {
      try {
        const res = await uploadArtifact(file);
        if (isBatch()) {
          const ids = selection.artifactIds || [];
          if (!ids.includes(res.artifact.id)) {
            select({ ...BATCH_RESETS.file, artifactIds: toggleBatchFile(ids, res.artifact.id) });
          }
        } else {
          select({ ...RESETS.file, artifactId: res.artifact.id });
        }
        toast(`«${esc(file.name)}» загружен — анализирую`, "toast-ok");
      } catch (err) {
        toast(`«${esc(file.name)}» не принят: ${esc(err.message)}`, "toast-danger");
      }
    }
  } finally {
    ui.uploading = false;
    await load();
  }
}

async function confirmUnits() {
  const units = $("#newprint-body [data-np-units]")?.value;
  if (!units || !selection.artifactId) return;
  await apiPost(`/api/print/artifacts/${encodeURIComponent(selection.artifactId)}/scale`, { units });
}

async function reanalyze() {
  if (!selection.artifactId) return;
  await apiPost(`/api/print/artifacts/${encodeURIComponent(selection.artifactId)}/analyze`, {});
}

async function slice() {
  const flow = resolveFlow(selection, data);
  if (!flow.item || !flow.set || !flow.printer) return;
  const res = await apiPost("/api/print/slicing/slice", {
    artifactId: flow.item.artifact.id,
    profileSetId: flow.set.id,
    targetPrinterId: flow.printer.printerId,
    // Подготовка «заново» из истории называет печать, которую повторяет.
    ...(selection.previousTaskId ? { previousTaskId: selection.previousTaskId } : {})
  });
  select({ variantId: res.variant.id, taskId: null });
}

async function sliceAgain() {
  const flow = resolveFlow(selection, data);
  if (!flow.variant) return slice();
  const res = await apiPost(`/api/print/slicing/variants/${encodeURIComponent(flow.variant.id)}/rerun`, {});
  select({ variantId: res.variant.id, taskId: null });
}

async function promote() {
  const flow = resolveFlow(selection, data);
  if (!flow.variant) return;
  const res = await apiPost(`/api/print/slicing/variants/${encodeURIComponent(flow.variant.id)}/promote`, {});
  select({ taskId: res.task.task.id });
  toast("Задание в очереди — осталось запустить", "toast-ok");
}

async function launch() {
  const flow = resolveFlow(selection, data);
  let taskId = selection.taskId;
  if (!taskId && fileKind(flow.item) === "print") {
    // Уже нарезанный файл: в очередь его ставит сервер (проверка анализа и
    // подтверждённого чтения замечаний — там), а не этот экран.
    const existing = flow.item.task;
    if (existing && existing.state === "QUEUED") {
      taskId = existing.id;
    } else {
      const draft = (flow.item.status && flow.item.status.next && flow.item.status.next.taskId) || (existing && existing.id);
      if (!draft) throw new Error("у файла нет задания — загрузите его заново");
      const res = await apiPost(`/api/print/tasks/${encodeURIComponent(draft)}/enqueue`, {});
      taskId = res.task.task.id;
    }
    select({ taskId });
  }
  if (!taskId) return;
  openLaunchModal(taskId, { printerId: flow.printer ? flow.printer.printerId : null });
}

// ── Пакет ───────────────────────────────────────────────────────────────────

/** Одни единицы для всех выбранных STL, которые их ждут (каждая — своим запросом). */
async function confirmBatchUnits() {
  const units = $("#newprint-body [data-np-units]")?.value;
  const flow = resolveBatchFlow(selection, data);
  if (!units || flow.needsUnits.length === 0) return;
  const failed = [];
  for (const item of flow.needsUnits) {
    try {
      await apiPost(`/api/print/artifacts/${encodeURIComponent(item.artifact.id)}/scale`, { units });
    } catch (err) {
      failed.push(`${item.artifact.name}: ${err.message}`);
    }
  }
  if (failed.length > 0) throw new Error(failed.join("; "));
  toast(`Единицы подтверждены: ${flow.needsUnits.length}`, "toast-ok");
}

async function sliceBatch() {
  const flow = resolveBatchFlow(selection, data);
  if (!flow.set || !flow.printer || flow.ready.length === 0) return;
  const res = await apiPost(
    "/api/print/slicing/batches",
    {
      artifactIds: flow.ready.map((it) => it.artifact.id),
      profileSetId: flow.set.id,
      targetPrinterId: flow.printer.printerId
    },
    { timeoutMs: 60000 }
  );
  const variants = {};
  const refused = {};
  for (const item of res.batch.items || []) {
    if (item.ok) variants[item.artifactId] = item.variant.id;
    else refused[item.artifactId] = item.error;
  }
  select({ batchId: res.batch.batchId, variants, refused, tasks: {}, queued: false });
  const bad = Object.keys(refused).length;
  toast(
    bad > 0 ? `Нарезка запущена; не принято моделей: ${bad} — причины в списке` : "Нарезка пакета запущена",
    bad > 0 ? "" : "toast-ok"
  );
}

async function promoteBatch() {
  const flow = resolveBatchFlow(selection, data);
  const ids = flow.promotable.map((r) => r.variant.id);
  if (ids.length === 0) return;
  const res = await apiPost("/api/print/slicing/batches/promote", { variantIds: ids });
  const tasks = { ...(selection.tasks || {}) };
  const failed = [];
  for (const item of res.items || []) {
    if (item.ok) tasks[item.variantId] = item.taskId;
    else failed.push(item.error);
  }
  select({ tasks, queued: Object.keys(tasks).length > 0 });
  if (failed.length > 0) toast(`В очередь не встали: ${esc(failed.join("; "))}`, "toast-danger");
  else toast(`В очереди: ${ids.length} — осталось запускать`, "toast-ok");
}

function launchTask(taskId) {
  openLaunchModal(taskId, { printerId: selection.printerId || null });
}
