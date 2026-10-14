/* ── История печати: разметка ─────────────────────────────────────
   Чистые функции (состояние → HTML), как у остальных разделов: правила
   отрисовки проверяются без браузера. Что можно сделать с печатью — решает
   сервер; вид только показывает его ответ и кнопки, которые он разрешил. */

import { esc } from "../../util.js";
import { chip } from "../../shared/chips.js";
import { icon } from "../../shared/icons.js";
import { fmtDate, fmtDuration } from "../../shared/format.js";
import {
  STATE_FILTERS,
  STATE_LABEL,
  STATE_TONE,
  blockedReason,
  primaryAction,
  recipeLines,
  runLabel,
  secondaryActions
} from "./model.js";

/**
 * Весь раздел. `vm`: {
 *   entries — записи истории (ответ GET /history),
 *   filter  — выбранное состояние ("" — все),
 *   more    — есть ли следующая страница,
 *   loading — идёт первая загрузка,
 *   error   — текст ошибки загрузки или null,
 *   busy    — id записи, над которой выполняется действие, или null,
 *   open    — Set id раскрытых записей
 * }
 */
export function historyHtml(vm) {
  const filters = STATE_FILTERS.map(
    (f) =>
      `<button type="button" class="hist-filter${vm.filter === f.id ? " is-active" : ""}" data-hist-filter="${esc(f.id)}"
        aria-pressed="${vm.filter === f.id}">${esc(f.label)}</button>`
  ).join("");
  const body = vm.loading
    ? `<div class="slice-loading">Поднимаю летопись печати…</div>`
    : vm.entries.length === 0
      ? `<div class="slice-empty">${
          vm.filter ? "Таких печатей ещё не было." : "Завершённых печатей пока нет — здесь появится каждая законченная, прерванная или отменённая печать."
        }</div>`
      : `<ul class="slice-list hist-list">${vm.entries.map((e) => entryHtml(e, vm)).join("")}</ul>`;
  return `
    <div class="hist">
      <div class="hist-filters" role="group" aria-label="Показать">${filters}</div>
      ${vm.error ? `<div class="form-error" role="alert">${esc(vm.error)}</div>` : ""}
      ${body}
      ${vm.more && !vm.loading ? `<div class="np-row"><button type="button" class="btn btn-sm" data-hist-action="more">Показать раньше</button></div>` : ""}
    </div>`;
}

/** Одна печать: что, где, чем закончилась — и что с ней можно сделать сейчас. */
export function entryHtml(entry, vm = {}) {
  const busy = vm.busy === entry.taskId;
  const open = Boolean(vm.open && vm.open.has && vm.open.has(entry.taskId));
  const run = entry.run;
  const facts = [];
  if (run && run.printerName) facts.push(`${icon("printer")}<span>${esc(run.printerName)}</span>`);
  facts.push(`${icon("clock")}<span>${esc(fmtDate(entry.closedAt))}</span>`);
  if (run && run.durationS != null) facts.push(`<span>${esc(fmtDuration(run.durationS))}</span>`);
  const grams = (run && run.filamentUsedG) ?? (entry.recipe && entry.recipe.filamentG);
  if (grams != null) facts.push(`<span>${esc(String(Math.round(grams * 10) / 10))} г</span>`);
  if (entry.material) facts.push(`<span>${esc(entry.material)}</span>`);

  const lineage = [];
  if (entry.lineage && entry.lineage.reprintOf) lineage.push(chip("повтор", "info"));
  const reprints = (entry.lineage && entry.lineage.reprintedAs) || [];
  if (reprints.length > 0) lineage.push(chip(`напечатано ещё ${reprints.length}×`, "mute"));
  if (entry.runCount > 1) lineage.push(chip(`попыток: ${entry.runCount}`, "mute"));

  const primary = primaryAction(entry);
  const secondary = secondaryActions(entry);
  const disabled = busy || vm.busy ? " disabled" : "";
  const buttons = [
    primary
      ? `<button type="button" class="btn btn-primary btn-sm" data-hist-action="${primary.kind}" data-id="${esc(entry.taskId)}"${disabled}>${icon(
          primary.kind === "reprepare" ? "slice" : "refresh"
        )}<span>${busy ? "Выполняю…" : esc(primary.label)}</span></button>`
      : "",
    ...secondary.map(
      (a) =>
        `<button type="button" class="btn btn-sm" data-hist-action="${a.kind}" data-id="${esc(entry.taskId)}"${disabled}>${esc(a.label)}</button>`
    ),
    `<button type="button" class="btn btn-sm btn-ghost" data-hist-action="toggle" data-id="${esc(entry.taskId)}" aria-expanded="${open}">${
      open ? "Свернуть" : "Подробнее"
    }</button>`
  ].join("");

  const why = blockedReason(entry);
  return `
    <li class="slice-item hist-item" data-hist-entry="${esc(entry.taskId)}">
      <div class="slice-item-head">
        <span class="slice-name">${esc(entry.title)}</span>
        ${chip(esc(STATE_LABEL[entry.state] || entry.state), STATE_TONE[entry.state] || "mute")}
        ${lineage.join("")}
      </div>
      <div class="slice-meta hist-facts">${facts.join("")}</div>
      ${why && !primary ? `<p class="slice-hint">${esc(why)}</p>` : ""}
      <div class="np-row">${buttons}</div>
      ${open ? detailsHtml(entry) : ""}
    </li>`;
}

/** Раскрытая запись: настройки, файл, исход, причина — всё, что было записано. */
export function detailsHtml(entry) {
  const rows = [];
  if (entry.run) rows.push(["Исход", runLabel(entry.run.state)]);
  if (entry.reason) rows.push(["Причина", entry.reason]);
  if (entry.file) rows.push(["Файл", entry.file.name]);
  if (entry.source) rows.push(["Модель", entry.source.name]);
  for (const line of recipeLines(entry)) rows.push(line);
  const recipe = entry.recipe;
  const recipeNote =
    recipe && !recipe.profileSetUsable
      ? `<p class="slice-hint">Рецепт больше не утверждён или в карантине — «Подготовить заново» попросит выбрать другой.</p>`
      : "";
  const why = blockedReason(entry);
  return `
    <div class="hist-details">
      <dl class="hist-kv">${rows
        .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`)
        .join("")}</dl>
      ${recipeNote}
      ${why ? `<p class="slice-hint">Как есть не напечатать: ${esc(why)}</p>` : ""}
    </div>`;
}
