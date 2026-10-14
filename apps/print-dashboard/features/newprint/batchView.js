/* ── «Новая печать»: пакет моделей — разметка ──────────────────────
   Чистые функции (состояние → HTML). Шаги «Принтер» и «Рецепт» — те же, что у
   одной модели; пакет добавляет выбор нескольких файлов, строку на модель и
   действия над всеми готовыми сразу. Решения — в batch.js и на сервере. */

import { esc } from "../../util.js";
import { chip } from "../../shared/chips.js";
import { icon } from "../../shared/icons.js";
import { fmtDuration } from "../../shared/format.js";
import { UNIT_CHOICES } from "../uploads/units.js";
import { MAX_BATCH, batchCandidates } from "./batch.js";
import { fileHold, isSlicing } from "./model.js";
import { printerStepHtml, recipeStepHtml, stepsHtml } from "./view.js";

const VARIANT_LABEL = {
  pending: "в очереди нарезки",
  running: "режу…",
  ready: "нарезано",
  failed: "ошибка нарезки",
  blocked: "нарезка отклонена"
};

/** Весь пакетный путь. `vm`: { flow (resolveBatchFlow), data, ui }. */
export function batchHtml(vm) {
  const { flow } = vm;
  const panels = flow.steps.map((step) => panelHtml(step, vm)).join("");
  return `
    <div class="np np-batch">
      ${stepsHtml(flow)}
      ${vm.ui && vm.ui.error ? `<div class="form-error" role="alert">${esc(vm.ui.error)}</div>` : ""}
      ${panels}
      <p class="slice-hint np-foot">Каждая печать пакета запускается отдельно: у неё свой стол, и его готовность
        подтверждает человек. Одну модель — <button type="button" class="np-link" data-np-action="mode-single">обычным путём</button>.</p>
    </div>`;
}

function panelHtml(step, vm) {
  if (step.state === "todo") return "";
  const current = step.state === "current";
  const body = {
    file: filesStepHtml,
    printer: (v, c) => printerStepHtml(v, c),
    recipe: (v, c) => recipeStepHtml(v, c),
    slice: sliceStepHtml,
    result: resultStepHtml,
    launch: launchStepHtml
  }[step.id](vm, current);
  // После постановки в очередь задания уже существуют — менять прежние шаги
  // значило бы готовить второй пакет; для него есть «Начать заново».
  const editable = step.state === "done" && !vm.flow.queued.length && step.id !== "slice";
  return `
    <section class="slice-panel np-panel is-${step.state}" data-np-step="${step.id}">
      <div class="slice-panel-head"><b>${esc(step.label)}</b>${
        editable
          ? `<button type="button" class="btn btn-sm" data-np-action="edit" data-step="${step.id}">${icon("pencil")}<span>Изменить</span></button>`
          : ""
      }</div>
      ${body}
    </section>`;
}

// ── 1 · Модели ─────────────────────────────────────────────────────────────

function filesStepHtml(vm, current) {
  const { flow } = vm;
  if (!current) {
    const names = flow.ready.map((it) => esc(it.artifact.name)).join(", ");
    return `<div class="np-summary">${chip(`моделей: ${flow.ready.length}`, "ok")}<span class="slice-hint">${names}</span></div>`;
  }
  const selected = new Set(flow.items.map((it) => it.artifact.id));
  const candidates = batchCandidates(vm.data.items);
  // Выбранные, но не годные (единицы, анализ) тоже видны — иначе их не убрать.
  const shown = [...flow.items.filter((it) => !candidates.includes(it)), ...candidates];
  const rows = shown
    .map((it) => {
      const id = it.artifact.id;
      const on = selected.has(id);
      const hold = fileHold(it);
      return `<li class="slice-item np-check${on ? " is-on" : ""}">
          <label class="slice-item-head">
            <input type="checkbox" data-np-batch-toggle="${esc(id)}"${on ? " checked" : ""} />
            <span class="slice-name">${esc(it.artifact.name)}</span>
            ${hold ? chip(esc(holdLabel(hold.kind)), hold.kind === "blocked" ? "error" : "warn", hold.kind === "wait") : chip("модель", "info")}
          </label>
          ${on && hold && hold.kind !== "confirm_scale" ? `<p class="slice-hint">${esc(hold.text)}</p>` : ""}
        </li>`;
    })
    .join("");
  const uploading = vm.ui && vm.ui.uploading;
  const units = flow.needsUnits.length
    ? `<div class="np-row">
        <label>Единицы ${flow.needsUnits.length === 1 ? "модели" : `${flow.needsUnits.length} моделей`}
          <select data-np-units>${UNIT_CHOICES.map((u) => `<option value="${esc(u.value)}">${esc(u.label)}</option>`).join("")}</select></label>
        <button type="button" class="btn btn-sm" data-np-action="batch-units">Подтвердить единицы</button>
      </div>`
    : "";
  const blocking = flow.held.length > 0;
  const count = flow.items.length;
  return `
    <label class="np-upload">
      <span class="btn btn-sm">${icon("upload")}<span>${uploading ? "Загружаю…" : "Загрузить модели"}</span></span>
      <input type="file" data-np-upload multiple accept=".stl,.3mf" ${uploading ? "disabled" : ""} hidden />
      <span class="slice-hint">STL или 3MF — до ${MAX_BATCH} моделей в пакете, все одним рецептом под один принтер.</span>
    </label>
    ${rows ? `<ul class="slice-list slice-scroll">${rows}</ul>` : `<div class="slice-empty">Загруженных моделей пока нет.</div>`}
    ${units}
    ${blocking ? `<p class="slice-hint">Сначала доведите отмеченные модели (единицы, анализ) или снимите их с пакета.</p>` : ""}
    <div class="np-row">
      <button type="button" class="btn btn-primary btn-sm" data-np-action="batch-files-done"${
        count > 0 && !blocking ? "" : " disabled"
      }>${icon("arrowRight")}<span>Дальше · выбрано ${count}</span></button>
    </div>`;
}

function holdLabel(kind) {
  return (
    {
      wait: "анализ…",
      confirm_scale: "нужны единицы",
      select_plate: "нужна пластина",
      confirm_review: "нужна проверка",
      reanalyze: "повторить анализ",
      blocked: "непригодна"
    }[kind] || kind
  );
}

// ── 4 · Слайсинг ────────────────────────────────────────────────────────────

function sliceStepHtml(vm, current) {
  const { flow } = vm;
  if (!flow.requested) {
    const busy = vm.ui && vm.ui.busy ? " disabled" : "";
    return `<p class="slice-hint">OrcaSlicer нарежет ${flow.ready.length} ${plural(flow.ready.length, "модель", "модели", "моделей")} рецептом
        «${esc(flow.set ? flow.set.name : "")}» под «${esc(flow.printer ? flow.printer.printerName || flow.printer.printerId : "")}».
        Уже нарезанное тем же рецептом сервер отдаст из кэша сразу.</p>
      <div class="np-row"><button type="button" class="btn btn-primary btn-sm" data-np-action="batch-slice"${busy}>${icon(
        "slice"
      )}<span>Нарезать все</span></button></div>`;
  }
  const done = flow.rows.filter((r) => r.variant && r.variant.state === "ready").length;
  if (!current) {
    return `<div class="np-summary">${chip(`нарезано: ${done} из ${flow.rows.length}`, done === flow.rows.length ? "ok" : "warn")}</div>`;
  }
  return `<ul class="slice-list">${flow.rows.map(sliceRowHtml).join("")}</ul>
    ${flow.slicing ? `<p class="slice-hint">Нарезка идёт на сервере — страницу можно не держать открытой.</p>` : ""}`;
}

function sliceRowHtml(row) {
  const v = row.variant;
  const state = row.refused
    ? chip("не нарезана", "error")
    : v
      ? chip(esc(VARIANT_LABEL[v.state] || v.state), v.state === "ready" ? "ok" : isSlicing(v) ? "info" : "error", isSlicing(v))
      : chip("не отправлена", "mute");
  const why = row.refused || (v && v.error) || null;
  return `<li class="slice-item"><div class="slice-item-head"><span class="slice-name">${esc(row.item.artifact.name)}</span>${state}</div>
    ${why ? `<p class="slice-hint">${esc(why)}</p>` : ""}</li>`;
}

// ── 5 · Результат ───────────────────────────────────────────────────────────

function resultStepHtml(vm, current) {
  const { flow } = vm;
  if (!current) {
    return `<div class="np-summary">${chip(`в очереди: ${flow.queued.length}`, "ok")}</div>`;
  }
  const rows = flow.rows
    .map((row) => {
      const v = row.variant;
      const analysis = row.output ? row.output.analysis : null;
      const facts = [];
      if (v && v.orcaEtaS != null) facts.push(fmtDuration(v.orcaEtaS));
      if (v && v.filamentG != null) facts.push(`${v.filamentG} г`);
      const status = row.taskId
        ? chip("в очереди", "ok")
        : row.refused || !v || v.state !== "ready"
          ? chip("не готова", "error")
          : !analysis || analysis.state !== "ready"
            ? chip("проверка G-code…", "info", true)
            : row.promotable
              ? chip("G-code проверен", "ok")
              : chip(`G-code: ${esc(analysis.verdict || analysis.state)}`, "error");
      return `<li class="slice-item"><div class="slice-item-head">
          <span class="slice-name">${esc(row.item.artifact.name)}</span>${status}
          ${facts.length ? `<span class="slice-tag">${esc(facts.join(" · "))}</span>` : ""}
        </div></li>`;
    })
    .join("");
  const count = flow.promotable.length;
  const ready = count > 0 && !flow.slicing && !flow.outputPending && !(vm.ui && vm.ui.busy);
  return `<ul class="slice-list">${rows}</ul>
    <div class="np-row"><button type="button" class="btn btn-primary btn-sm" data-np-action="batch-promote"${ready ? "" : " disabled"}>${icon(
      "plus"
    )}<span>Поставить готовые в очередь${count ? ` (${count})` : ""}</span></button></div>`;
}

// ── 6 · Запуск ──────────────────────────────────────────────────────────────

function launchStepHtml(vm) {
  const { flow } = vm;
  const busy = vm.ui && vm.ui.busy ? " disabled" : "";
  const rows = flow.queued
    .map(
      (row) => `<li class="slice-item"><div class="slice-item-head">
        <span class="slice-name">${esc(row.item.artifact.name)}</span>${chip("в очереди", "ok")}
        <span class="row-actions"><button type="button" class="btn btn-sm" data-np-action="launch-task" data-id="${esc(row.taskId)}"${busy}>${icon(
          "play"
        )}<span>Запустить</span></button></span>
      </div></li>`
    )
    .join("");
  return `<p class="slice-hint">Готовые модели в очереди. Запускайте по одной, когда принтер свободен: окно запуска проверит стол, материал и файл.</p>
    <ul class="slice-list">${rows}</ul>
    <div class="np-row">
      <button type="button" class="btn btn-sm" data-goto="scheduler">${icon("arrowRight")}<span>Открыть очередь</span></button>
      <button type="button" class="btn btn-sm" data-np-action="restart">Начать заново</button>
    </div>`;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
