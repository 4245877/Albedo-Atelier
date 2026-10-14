/* ── «Новая печать»: разметка ────────────────────────────────────
   Чистые функции (состояние → HTML), как и у остальных разделов: правила
   отрисовки проверяются без браузера. Решения — в model.js и на сервере. */

import { esc } from "../../util.js";
import { chip } from "../../shared/chips.js";
import { icon } from "../../shared/icons.js";
import { fmtDuration } from "../../shared/format.js";
import { UNIT_CHOICES } from "../uploads/units.js";
import { STEPS, isSlicing, lastRecipeFor, printerChoices, variantPromotable } from "./model.js";

const RECENT_FILES = 12;

const KIND_LABEL = { model: "модель — нужна нарезка", print: "готов к печати" };

/**
 * Весь раздел. `vm`: { flow, data, ui } —
 *   flow — resolveFlow(selection, data);
 *   data — { items, coverage, sets, variants, outputs };
 *   ui   — { busy, error, uploading }.
 */
export function newPrintHtml(vm) {
  const { flow } = vm;
  return `
    <div class="np">
      ${stepsHtml(flow)}
      ${vm.ui && vm.ui.error ? `<div class="form-error" role="alert">${esc(vm.ui.error)}</div>` : ""}
      ${STEPS.map((step) => stepPanelHtml(step.id, vm)).join("")}
      <p class="slice-hint np-foot">Профили и рецепты, планировщик и расписание оператора — технические настройки; они в разделах
        <button type="button" class="np-link" data-goto="slicing">«Слайсинг и профили»</button>,
        <button type="button" class="np-link" data-goto="scheduler">«Планировщик»</button> и
        <button type="button" class="np-link" data-goto="operations">«Оператор»</button>.
        Для обычной печати они не нужны.</p>
    </div>`;
}

/** Полоса шагов: где мы и что уже сделано. */
export function stepsHtml(flow) {
  const items = flow.steps
    .map((s, i) => {
      const mark = s.state === "done" ? icon("check") : s.state === "skipped" ? icon("minus") : `<span>${i + 1}</span>`;
      const label = s.state === "skipped" ? `${esc(s.label)} · не нужно` : esc(s.label);
      return `<li class="np-step is-${s.state}"${s.state === "current" ? ' aria-current="step"' : ""}>
        <span class="np-step-mark" aria-hidden="true">${mark}</span><span class="np-step-label">${label}</span></li>`;
    })
    .join("");
  return `<ol class="np-steps" aria-label="Шаги новой печати">${items}</ol>`;
}

function stepPanelHtml(id, vm) {
  const step = vm.flow.steps.find((s) => s.id === id);
  if (!step || step.state === "skipped" || step.state === "todo") return "";
  const body = {
    file: fileStepHtml,
    printer: printerStepHtml,
    recipe: recipeStepHtml,
    slice: sliceStepHtml,
    result: resultStepHtml,
    launch: launchStepHtml
  }[id](vm, step.state === "current");
  return `
    <section class="slice-panel np-panel is-${step.state}" data-np-step="${id}">
      <div class="slice-panel-head"><b>${esc(step.label)}</b>${
        // После постановки в очередь задание уже существует: менять прежние шаги
        // значило бы готовить вторую печать — для неё есть «Начать новую печать».
        step.state === "done" && !vm.flow.taskId
          ? `<button type="button" class="btn btn-sm" data-np-action="edit" data-step="${id}">${icon("pencil")}<span>Изменить</span></button>`
          : ""
      }</div>
      ${body}
    </section>`;
}

// ── 1 · Файл ───────────────────────────────────────────────────────────────

function fileStepHtml(vm, current) {
  const { flow } = vm;
  if (!current && flow.item) {
    return `<div class="np-summary">${fileLine(flow.item, flow.kind)}</div>`;
  }
  if (flow.item) return `${fileLine(flow.item, flow.kind)}${holdHtml(flow)}`;

  const items = (vm.data.items || []).filter((it) => it.artifact).slice(0, RECENT_FILES);
  const rows = items
    .map((it) => {
      const kind = fileKindOf(it);
      return `<li class="slice-item"><div class="slice-item-head">
          <span class="slice-name">${esc(it.artifact.name)}</span>
          ${kind ? chip(esc(KIND_LABEL[kind]), kind === "print" ? "ok" : "info") : analysisChip(it)}
          <span class="row-actions"><button type="button" class="btn btn-sm" data-np-action="pick-file" data-id="${esc(it.artifact.id)}">Выбрать</button></span>
        </div></li>`;
    })
    .join("");
  const uploading = vm.ui && vm.ui.uploading;
  return `
    <label class="np-upload">
      <span class="btn btn-primary btn-sm">${icon("upload")}<span>${uploading ? "Загружаю…" : "Загрузить файл"}</span></span>
      <input type="file" data-np-upload accept=".stl,.3mf,.gcode,.gco,.g" ${uploading ? "disabled" : ""} hidden />
      <span class="slice-hint">STL или 3MF — нарежем здесь; G-code или нарезанный 3MF — отправим как есть.</span>
    </label>
    ${rows ? `<div class="panel-sub">Или один из загруженных</div><ul class="slice-list slice-scroll">${rows}</ul>` : ""}
    <p class="slice-hint np-mode">Несколько моделей одним рецептом?
      <button type="button" class="np-link" data-np-action="mode-batch">Подготовить пакетом</button></p>`;
}

/* Тот же вывод, что и fileKind в модели, — для строки списка. */
function fileKindOf(item) {
  const a = item.analysis;
  if (!a || a.state !== "ready") return null;
  if (a.verdict === "needs_preparation") return "model";
  if (item.status && item.status.executable) return "print";
  return null;
}

function analysisChip(item) {
  const a = item.analysis;
  if (!a || a.state === "pending" || a.state === "running") return chip("анализ…", "info", true);
  if (a.state === "failed") return chip("анализ не удался", "error");
  if (a.verdict === "blocked") return chip("непригоден", "error");
  return chip(esc(a.verdict || "—"), "warn");
}

function fileLine(item, kind) {
  return `<div class="slice-item-head"><span class="slice-name">${esc(item.artifact.name)}</span>${
    kind ? chip(esc(KIND_LABEL[kind]), kind === "print" ? "ok" : "info") : analysisChip(item)
  }</div>`;
}

/** Что осталось сделать с файлом до следующего шага — и кнопка, если её можно нажать здесь. */
function holdHtml(flow) {
  const hold = flow.hold;
  const change = `<button type="button" class="btn btn-sm" data-np-action="edit" data-step="file">Выбрать другой файл</button>`;
  if (!hold) return "";
  const text = `<p class="slice-hint">${esc(hold.text)}</p>`;
  if (hold.kind === "wait") return `${text}<div class="slice-meta">${chip("анализ идёт", "info", true)}</div>`;
  if (hold.kind === "confirm_scale") {
    const options = UNIT_CHOICES.map((u) => `<option value="${esc(u.value)}">${esc(u.label)}</option>`).join("");
    return `${text}
      <div class="np-row">
        <label>Единицы модели <select data-np-units>${options}</select></label>
        <button type="button" class="btn btn-primary btn-sm" data-np-action="confirm-units">Подтвердить единицы</button>
        ${change}
      </div>`;
  }
  if (hold.kind === "reanalyze") {
    return `${text}<div class="np-row"><button type="button" class="btn btn-primary btn-sm" data-np-action="reanalyze">${icon("refresh")}<span>Повторить анализ</span></button>${change}</div>`;
  }
  if (hold.kind === "select_plate" || hold.kind === "confirm_review") {
    const what = hold.kind === "select_plate" ? "выбрать пластину" : "прочитать замечания и подтвердить";
    return `${text}<div class="np-row"><button type="button" class="btn btn-primary btn-sm" data-goto="uploads">${icon("arrowRight")}<span>Открыть «Загрузку» — ${what}</span></button>${change}</div>`;
  }
  return `<div class="slice-block">${icon("blocked")}${esc(hold.text)}</div><div class="np-row">${change}</div>`;
}

// ── 2 · Принтер ─────────────────────────────────────────────────────────────

export function printerStepHtml(vm, current) {
  const { flow } = vm;
  if (!current && flow.printer) {
    return `<div class="np-summary"><span class="slice-name">${esc(flow.printer.printerName || flow.printer.printerId)}</span></div>`;
  }
  const choices = printerChoices(vm.data.coverage, vm.data.sets, flow.kind);
  if (choices.length === 0) {
    return `<div class="slice-empty">Принтеров в ферме нет — добавьте их в разделе <button type="button" class="np-link" data-goto="hardware">«Оборудование»</button>.</div>`;
  }
  const rows = choices
    .map((p) => {
      const selected = flow.printer && flow.printer.printerId === p.printerId;
      const note =
        flow.kind === "model"
          ? p.recipes > 0
            ? chip(`рецептов: ${p.recipes}`, "ok")
            : chip("нет утверждённого рецепта", "warn")
          : "";
      const button = p.usable
        ? `<button type="button" class="btn btn-sm${selected ? " btn-primary" : ""}" data-np-action="pick-printer" data-id="${esc(p.printerId)}">${selected ? "Выбран" : "Выбрать"}</button>`
        : `<button type="button" class="btn btn-sm" data-goto="slicing">Создать рецепт</button>`;
      return `<li class="slice-item"><div class="slice-item-head">
          <span class="slice-name">${esc(p.name)}</span>
          ${p.model ? `<span class="slice-tag">${esc(p.model)}</span>` : ""}
          ${note}
          <span class="row-actions">${button}</span>
        </div></li>`;
    })
    .join("");
  const hint =
    flow.kind === "model"
      ? "Рецепт — утверждённый набор профилей принтера, печати и филамента. Без него нарезать нечем."
      : "Окно запуска проверит этот принтер — стол, материал, файл — перед отправкой.";
  return `${sameAsLastHtml(vm)}<p class="slice-hint">${esc(hint)}</p><ul class="slice-list">${rows}</ul>`;
}

/* «Как в прошлый раз» — принтер и рецепт последней нарезки этой же модели, если
   их по-прежнему можно выбрать. Один клик вместо двух шагов; не навязывается. */
function sameAsLastHtml(vm) {
  const { flow } = vm;
  if (flow.mode === "batch" || flow.kind !== "model" || !flow.item) return "";
  const last = lastRecipeFor(flow.item.artifact.id, vm.data.variants, vm.data.sets, vm.data.coverage);
  if (!last) return "";
  return `<div class="np-row np-last">
      <button type="button" class="btn btn-sm" data-np-action="same-as-last" data-printer="${esc(last.printerId)}" data-set="${esc(last.setId)}">${icon(
        "refresh"
      )}<span>Как в прошлый раз: «${esc(last.printerName)}» · «${esc(last.setName)}»</span></button>
    </div>`;
}

// ── 3 · Рецепт ──────────────────────────────────────────────────────────────

export function recipeStepHtml(vm, current) {
  const { flow } = vm;
  if (!current && flow.set) {
    return `<div class="np-summary"><span class="slice-name">${esc(flow.set.name)}</span></div>`;
  }
  if (flow.recipes.length === 0) {
    return `<div class="slice-block">${icon("warn")}Для этого принтера нет утверждённого рецепта.</div>
      <div class="np-row"><button type="button" class="btn btn-primary btn-sm" data-goto="slicing">${icon("arrowRight")}<span>Создать рецепт в «Слайсинг и профили»</span></button></div>`;
  }
  const rows = flow.recipes
    .map((s) => {
      const selected = flow.set && flow.set.id === s.id;
      const warn = (s.warnings || []).length > 0 ? chip(`замечаний: ${s.warnings.length}`, "warn") : "";
      const target = s.printerId ? `принтер ${esc(s.printerId)}` : `класс ${esc(s.printerClass || "—")}`;
      return `<li class="slice-item"><div class="slice-item-head">
          <span class="slice-name">${esc(s.name)}</span>
          <span class="slice-tag">${target}</span>
          ${warn}
          <span class="row-actions"><button type="button" class="btn btn-sm${selected ? " btn-primary" : ""}" data-np-action="pick-recipe" data-id="${esc(s.id)}">${selected ? "Выбран" : "Выбрать"}</button></span>
        </div></li>`;
    })
    .join("");
  return `<ul class="slice-list">${rows}</ul>`;
}

// ── 4 · Слайсинг ────────────────────────────────────────────────────────────

const VARIANT_LABEL = {
  pending: "в очереди нарезки",
  running: "режу…",
  ready: "нарезано",
  failed: "ошибка нарезки",
  blocked: "нарезка отклонена"
};

function sliceStepHtml(vm, current) {
  const { flow } = vm;
  const v = flow.variant;
  if (!current && v) {
    return `<div class="np-summary">${chip(esc(VARIANT_LABEL[v.state] || v.state), v.state === "ready" ? "ok" : "warn")}</div>`;
  }
  if (!v) {
    return `<p class="slice-hint">OrcaSlicer нарежет «${esc(flow.item ? flow.item.artifact.name : "")}» рецептом «${esc(
      flow.set ? flow.set.name : ""
    )}» под «${esc(flow.printer ? flow.printer.printerName || flow.printer.printerId : "")}».</p>
      <div class="np-row"><button type="button" class="btn btn-primary btn-sm" data-np-action="slice"${
        vm.ui && vm.ui.busy ? " disabled" : ""
      }>${icon("slice")}<span>Нарезать</span></button></div>`;
  }
  if (isSlicing(v)) {
    return `<div class="slice-meta">${chip(esc(VARIANT_LABEL[v.state]), "info", true)}</div>
      <p class="slice-hint">Обычно это минута-две. Страницу можно не держать открытой — нарезка идёт на сервере.</p>`;
  }
  const findings = [...(v.blockers || []), ...(v.warnings || [])]
    .map((f) => `<li class="slice-warn">${icon("warn")}${esc(f.message)}</li>`)
    .join("");
  return `<div class="slice-meta">${chip(esc(VARIANT_LABEL[v.state] || v.state), "error")}</div>
    ${v.error ? `<div class="slice-block">${icon("blocked")}${esc(v.error)}</div>` : ""}
    ${findings ? `<ul class="slice-findings">${findings}</ul>` : ""}
    <div class="np-row">
      <button type="button" class="btn btn-primary btn-sm" data-np-action="slice-again">${icon("refresh")}<span>Нарезать заново</span></button>
      <button type="button" class="btn btn-sm" data-np-action="edit" data-step="recipe">Другой рецепт</button>
    </div>`;
}

// ── 5 · Результат ───────────────────────────────────────────────────────────

function resultStepHtml(vm, current) {
  const { flow } = vm;
  const v = flow.variant;
  if (!v) return "";
  const output = (vm.data.outputs || []).find((o) => o.artifact && o.artifact.id === v.outputArtifactId) || null;
  const analysis = output ? output.analysis : null;
  const facts = [];
  if (v.orcaEtaS != null) facts.push(`Время печати: ${fmtDuration(v.orcaEtaS)}`);
  if (v.filamentG != null) facts.push(`Филамент: ${v.filamentG} г`);
  if (v.dimensions && Array.isArray(v.dimensions.size)) {
    facts.push(`Габариты: ${v.dimensions.size.map((n) => Math.round(n * 10) / 10).join(" × ")} мм`);
  }
  const factsHtml = facts.length ? `<div class="slice-meta">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : "";
  if (!current) {
    return `<div class="np-summary">${factsHtml || chip("в очереди", "ok")}</div>`;
  }
  const ok = variantPromotable(v, analysis);
  const warnings = ((analysis && analysis.warnings) || [])
    .map((w) => `<li class="slice-warn">${icon("warn")}${esc(w.message)}</li>`)
    .join("");
  const status = !analysis
    ? chip("проверка G-code…", "info", true)
    : ok
      ? chip("G-code проверен", "ok")
      : chip(`G-code: ${esc(analysis.verdict || analysis.state)}`, analysis.state === "ready" ? "error" : "info", analysis.state !== "ready");
  return `${factsHtml}<div class="slice-meta">${status}</div>
    ${warnings ? `<ul class="slice-findings">${warnings}</ul>` : ""}
    <div class="np-row"><button type="button" class="btn btn-primary btn-sm" data-np-action="promote"${ok && !(vm.ui && vm.ui.busy) ? "" : " disabled"}>${icon("plus")}<span>Это и печатаем</span></button></div>`;
}

// ── 6 · Запуск ──────────────────────────────────────────────────────────────

function launchStepHtml(vm) {
  const { flow } = vm;
  const busy = vm.ui && vm.ui.busy ? " disabled" : "";
  const label = flow.kind === "print" && !flow.taskId ? "Поставить в очередь и запустить" : "Открыть запуск";
  return `<p class="slice-hint">Ручная печать не требует утверждать план: окно запуска проверит принтер, стол и материал, загрузит файл и отправит задание.</p>
    <div class="np-row">
      <button type="button" class="btn btn-primary btn-sm" data-np-action="launch"${busy}>${icon("play")}<span>${label}</span></button>
      <button type="button" class="btn btn-sm" data-np-action="restart">Начать новую печать</button>
    </div>`;
}
