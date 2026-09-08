/* ── Пластины 3MF: разметка ────────────────────────────────────
   Проект слайсера может содержать несколько печатных столов — это несколько
   разных печатей в одном файле. Здесь только отрисовка: какие пластины есть,
   что на каждой, какая выбрана. Решение «нужен ли выбор» принимает сервер и
   присылает в `status.plates.required` — здесь оно не пересчитывается. */

import { API_BASE } from "../../api.js";
import { esc } from "../../util.js";
import { chip } from "../../shared/chips.js";
import { fmtDuration } from "../../shared/format.js";
import { icon } from "../../shared/icons.js";

/* Две РАЗНЫЕ операции, и их нельзя смешивать:
     • просмотр — переключение между пластинами, чтобы посмотреть, что на них.
       Живёт только в браузере и ничего не меняет на сервере;
     • выбор — «работаем с этой пластиной». Отдельное явное действие, оно
       сохраняется на сервер, попадает в аудит и решает, что уйдёт в слайсер.
   Раньше карточка вообще не показывала пластин: файл с тремя столами выглядел
   как обычная модель без габаритов, а слайсинг отказывал без всякого действия,
   которое можно было бы предпринять. */

export function platesHtml(item, { viewIndex = null } = {}) {
  const plates = readPlates(item);
  const state = item.status?.plates;
  // Одна пластина — обычная модель: ничего не спрашиваем и ничего не показываем.
  if (plates.length < 2 && !(state && state.count > 1)) return "";

  const shown = plates.find((p) => p.index === viewIndex) || currentPlate(plates, state);
  const truncated =
    state && state.count > plates.length
      ? `<p class="plate-note">Показаны ${plates.length} из ${state.count} пластин.</p>`
      : "";

  return `
    <div class="plates" data-plates="${esc(item.key)}">
      <div class="plates-bar">
        <span class="panel-sub">Пластины в файле: ${plates.length}</span>
        ${selectionChip(state)}
      </div>
      ${truncated}
      <ul class="plate-tiles">
        ${plates.map((p) => tileHtml(item, p, state, shown)).join("")}
      </ul>
      ${shown ? detailHtml(item, shown, state) : ""}
      ${staleNote(state)}
    </div>`;
}

/* Какая пластина открыта по умолчанию: выбранная, иначе первая. */
function currentPlate(plates, state) {
  const chosen = state?.selectedIndex;
  return plates.find((p) => p.index === chosen) || plates[0] || null;
}

function selectionChip(state) {
  if (!state) return "";
  if (state.selectedIndex !== null && state.selectedIndex !== undefined) {
    return chip(`в работе: №${state.selectedIndex}`, "ok");
  }
  if (state.required) return chip("нужно выбрать пластину", "warn");
  return "";
}

function staleNote(state) {
  if (!state?.stale || !state.staleReason) return "";
  return `<p class="upload-note upload-note-warn">${icon("warn")}<span>Выбор пластины устарел: ${esc(
    state.staleReason
  )}. Выберите пластину заново.</span></p>`;
}

/* Плитка — это ПРОСМОТР. Клик по ней ничего не сохраняет. */
function tileHtml(item, plate, state, shown) {
  const chosen = state?.selectedIndex === plate.index;
  const open = shown && shown.index === plate.index;
  const cls = ["plate-tile", chosen ? "is-chosen" : "", open ? "is-open" : ""].filter(Boolean).join(" ");
  return `
    <li class="${cls}">
      <button type="button" class="plate-tile-btn" data-plate-view="${esc(item.key)}"
              data-plate-index="${plate.index}" aria-pressed="${open ? "true" : "false"}"
              title="${esc(`Посмотреть ${plateTitle(plate)}`)}">
        <span class="plate-thumb">${thumbHtml(item, plate)}</span>
        <span class="plate-tile-label">${esc(plateTitle(plate))}</span>
        <span class="plate-tile-sub">${esc(objectSummary(plate))}</span>
        ${chosen ? `<span class="plate-tile-flag">${icon("check")}</span>` : ""}
      </button>
    </li>`;
}

export function plateTitle(plate) {
  return plate.name ? `№${plate.index} · ${plate.name}` : `Пластина ${plate.index}`;
}

function objectSummary(plate) {
  if (!plate.objectsKnown) return "состав неизвестен";
  const n = plate.objectCount ?? plate.objects.length;
  if (n === 0) return "пусто";
  return `${n} ${plural(n, "модель", "модели", "моделей")}`;
}

/* Картинка из файла, если слайсер её сохранил; иначе — схема расположения,
   нарисованная по числовым габаритам объектов. Второе не «заглушка»: пока
   проект не нарезан, превью в файле нет вовсе, а посмотреть, что стоит на
   столе, всё равно нужно. Растеризатора на сервере ради этого не заводим. */
function thumbHtml(item, plate) {
  if (plate.hasPreview && item.artifact) {
    const url = `${API_BASE}/api/print/artifacts/${encodeURIComponent(item.artifact.id)}/plates/${plate.index}/preview`;
    return `<img src="${esc(url)}" alt="${esc(`Превью ${plateTitle(plate)}`)}" loading="lazy" decoding="async" />`;
  }
  return layoutSvg(plate);
}

/* ── Схема расположения ─────────────────────────────────────────
   Прямоугольник стола = габарит самой пластины, внутри — footprint каждого
   объекта в тех же миллиметрах. Ничего не додумываем: если у объектов нет
   координат (единицы файла неизвестны), схемы тоже нет. */
export function layoutSvg(plate) {
  const boxes = (plate.objects || [])
    .map((o) => o.footprintMm)
    .filter((f) => f && Array.isArray(f.min) && Array.isArray(f.max));
  if (boxes.length === 0) {
    return `<span class="plate-thumb-none" aria-hidden="true">${icon("frame")}</span>`;
  }

  const minX = Math.min(...boxes.map((b) => b.min[0]));
  const minY = Math.min(...boxes.map((b) => b.min[1]));
  const maxX = Math.max(...boxes.map((b) => b.max[0]));
  const maxY = Math.max(...boxes.map((b) => b.max[1]));
  // Поля в 6 % от большей стороны: без них модель, стоящая вплотную к краю,
  // сливается с рамкой.
  const pad = Math.max(maxX - minX, maxY - minY, 1) * 0.06;
  const x0 = minX - pad;
  const y0 = minY - pad;
  const w = Math.max(maxX - minX + pad * 2, 1);
  const h = Math.max(maxY - minY + pad * 2, 1);

  // Y в 3D растёт «вверх», в SVG — «вниз». Отражаем внутри той же рамки
  // (y' = 2·y0 + h − y_max), иначе схема выйдет зеркальной относительно того,
  // что оператор видит в слайсере.
  const rects = boxes
    .map(
      (b) =>
        `<rect x="${round(b.min[0])}" y="${round(2 * y0 + h - b.max[1])}" width="${round(
          Math.max(b.max[0] - b.min[0], 0.5)
        )}" height="${round(Math.max(b.max[1] - b.min[1], 0.5))}" rx="${round(Math.min(w, h) * 0.02)}" />`
    )
    .join("");

  return `<svg class="plate-layout" viewBox="${round(x0)} ${round(y0)} ${round(w)} ${round(h)}"
    role="img" aria-label="${esc(`Схема расположения: ${boxes.length} об.`)}" preserveAspectRatio="xMidYMid meet">
    <rect class="plate-layout-bed" x="${round(x0)}" y="${round(y0)}" width="${round(w)}" height="${round(h)}" />
    <g class="plate-layout-parts">${rects}</g>
  </svg>`;
}

function round(v) {
  return Math.round(v * 100) / 100;
}

/* ── Подробности открытой пластины + действие ──────────────────── */

function detailHtml(item, plate, state) {
  const rows = [];
  const add = (k, v) => {
    if (v !== null && v !== undefined && v !== "") rows.push(`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`);
  };

  add("Размеры", fmtSize(plate));
  add("Объектов", plate.objectsKnown ? (plate.objectCount ?? plate.objects.length) : null);
  const est = plate.estimate;
  add("Время печати", est ? fmtDuration(est.durationS) : null);
  add("Вес", est && est.weightG !== null ? `${est.weightG} г` : null);
  add("Поддержки", est && est.supportUsed !== null ? (est.supportUsed ? "да" : "нет") : null);
  add("Филамент", est ? fmtFilaments(est.filaments) : null);
  add("Стол", plate.settings?.curr_bed_type || null);
  add("Порядок печати", plate.settings?.print_sequence || null);
  if (plate.locked) add("Пластина", "заблокирована в слайсере");
  if (plate.sliced) add("G-code внутри", "есть — пластина уже нарезана");

  const objects = plate.objectsKnown && plate.objects.length > 0
    ? `<ul class="plate-objects">${plate.objects
        .slice(0, 24)
        .map((o) => `<li>${esc(o.name || `объект ${o.objectId}`)}</li>`)
        .join("")}</ul>`
    : "";

  return `
    <div class="plate-detail">
      <div class="plate-detail-head"><b>${esc(plateTitle(plate))}</b></div>
      ${rows.length ? `<dl class="upload-meta">${rows.join("")}</dl>` : ""}
      ${objects}
      ${actionHtml(item, plate, state)}
    </div>`;
}

/* Кнопка выбора. Пустую пластину показываем, но выбрать не даём — и объясняем
   почему, вместо погашенной кнопки без причины. */
function actionHtml(item, plate, state) {
  if (!item.artifact) return "";
  const chosen = state?.selectedIndex === plate.index;
  if (chosen) {
    return `
      <div class="plate-actions">
        <span class="upload-note upload-note-ok">${icon("check")}<span>${esc(chosenNote(state))}</span></span>
        <button type="button" class="btn btn-sm" data-clear-plate="${esc(item.artifact.id)}">
          ${icon("cross")}<span>Снять выбор</span>
        </button>
      </div>`;
  }
  const blocked = unselectableReason(plate);
  if (blocked) {
    return `
      <div class="plate-actions">
        <button type="button" class="btn btn-sm" disabled title="${esc(blocked)}">
          ${icon("check")}<span>Работать с этой пластиной</span>
        </button>
        <span class="plate-note">${esc(blocked)}</span>
      </div>`;
  }
  return `
    <div class="plate-actions">
      <button type="button" class="btn btn-sm btn-primary" data-select-plate="${esc(item.artifact.id)}"
        data-plate-index="${plate.index}">
        ${icon("check")}<span>Работать с этой пластиной</span>
      </button>
    </div>`;
}

/* Почему пластину нельзя выбрать — те же два случая и те же формулировки, что и
   на сервере (plateUnselectableReason). Кнопка гасится только вместе с причиной:
   отключённый контрол без объяснения — это тупик, а не отказ. */
function unselectableReason(plate) {
  if (plate.objectsKnown && (plate.objectCount ?? plate.objects.length) === 0) {
    return "На этой пластине нет ни одной модели — печатать нечего.";
  }
  if (!plate.objectsKnown) {
    return "Состав пластины не разобран — файл не описывает, что на ней стоит.";
  }
  return null;
}

function chosenNote(state) {
  const who = state?.confirmedBy ? `выбрал ${state.confirmedBy}` : "выбрана";
  const when = state?.confirmedAt ? `, ${String(state.confirmedAt).slice(0, 16).replace("T", " ")}` : "";
  return `Работаем с этой пластиной — ${who}${when}`;
}

function fmtSize(plate) {
  const g = plate.geometry || {};
  if (Array.isArray(g.sizeMm)) return `${triple(g.sizeMm)} мм`;
  if (Array.isArray(g.sizeRaw)) return `${triple(g.sizeRaw)} (ед. неизв.)`;
  return null;
}

function triple(size) {
  return size.map((v) => Math.round(v * 100) / 100).join(" × ");
}

function fmtFilaments(filaments) {
  if (!Array.isArray(filaments) || filaments.length === 0) return null;
  return filaments
    .map((f) => [f.type || `#${f.id}`, f.usedG !== null && f.usedG !== undefined ? `${f.usedG} г` : null]
      .filter(Boolean)
      .join(" "))
    .join(" · ");
}

/* Список пластин из анализа. Массив пишет анализатор (data.plates); карточка
   его только читает и никогда не достраивает. */
export function readPlates(item) {
  const raw = item.analysis?.data?.plates;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p.index === "number")
    .map((p) => ({
      ...p,
      objects: Array.isArray(p.objects) ? p.objects : [],
      objectsKnown: p.source === "model_settings" || p.source === "implicit",
      hasPreview: !!p.preview
    }))
    .sort((a, b) => a.index - b.index);
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
