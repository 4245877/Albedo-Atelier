/* ── Раздел «Загрузка и анализ»: view ──────────────────────────
   Чистая разметка элементов списка загрузок: item → HTML-строка.
   Никакого состояния и сети — контроллер (controller.js) владеет моделью
   и вызывает эти функции при отрисовке. */

import { esc } from "../../util.js";
import { chip } from "../../shared/chips.js";
import { fmtBytes, fmtDuration } from "../../shared/format.js";

const VERDICT = {
  schedulable: { label: "готово к планированию", cls: "ok" },
  needs_preparation: { label: "нужна подготовка (слайсинг)", cls: "info" },
  needs_input: { label: "нужны данные", cls: "warn" },
  review: { label: "на проверку", cls: "warn" },
  blocked: { label: "заблокировано", cls: "error" }
};

const STATE_LABEL = {
  pending: "в очереди на анализ",
  running: "анализируется…",
  ready: "анализ завершён",
  failed: "ошибка анализа"
};

export function itemHtml(item) {
  const a = item.analysis;
  const format = a?.detectedFormat || guessFormat(item.name);
  const badge = statusBadge(item);
  const size = fmtBytes(item.sizeBytes);

  const progressBar =
    item.stage === "uploading"
      ? `<div class="upload-progress"><span style="width:${Math.round(item.progress * 100)}%"></span></div>
         <div class="upload-pct">${Math.round(item.progress * 100)}%</div>`
      : "";

  const analysisBlock = a && (a.state === "ready" || a.state === "failed") ? analysisHtml(item, a) : "";
  const errorBlock =
    item.stage === "error"
      ? `<div class="upload-error">${esc(item.error || "ошибка загрузки")}</div>`
      : "";

  const dedup = item.blobExisted
    ? `<span class="upload-tag" title="Идентичное содержимое уже было загружено">blob уже существовал</span>`
    : "";

  return `
    <li class="upload-item" data-upload="${esc(item.key)}">
      <div class="upload-head">
        <div class="upload-name" title="${esc(item.name)}">
          <span class="upload-fmt fmt-${esc(format)}">${esc(fmtFormatLabel(format))}</span>
          <b>${esc(item.name)}</b>
          <span class="upload-size">${esc(size)}</span>
          ${dedup}
        </div>
        ${badge}
      </div>
      ${progressBar}
      ${errorBlock}
      ${analysisBlock}
    </li>`;
}

function statusBadge(item) {
  const a = item.analysis;
  if (item.stage === "uploading") return chip("загрузка", "info", true);
  if (item.stage === "error") return chip("ошибка загрузки", "error");
  if (!a) return chip("сохранение…", "info", true);
  if (a.state === "pending") return chip(STATE_LABEL.pending, "info", true);
  if (a.state === "running") return chip(STATE_LABEL.running, "info", true);
  if (a.state === "failed") return chip("ошибка анализа", "error");
  const v = VERDICT[a.verdict] || { label: a.verdict || "готово", cls: "info" };
  // Fallback-метка приходит с сервера (verdict) — экранируем; табличные статичны.
  return chip(esc(v.label), v.cls);
}

function analysisHtml(item, a) {
  if (a.state === "failed") {
    return `
      <div class="upload-analysis">
        <div class="upload-error">Анализ не удался — досадная оплошность: ${esc(a.error || "неизвестная ошибка")}</div>
        <div class="upload-actions">
          <button type="button" class="btn btn-sm" data-reanalyze="${esc(item.artifact.id)}">↻ Повторить анализ</button>
        </div>
      </div>`;
  }

  const rows = metaRows(a);
  const warns = (a.warnings || [])
    .map((w) => `<li class="upload-warn">⚠ ${esc(w.message)}</li>`)
    .join("");
  const blocks = (a.blockers || [])
    .map((b) => `<li class="upload-block">⛔ ${esc(b.message)}</li>`)
    .join("");

  const taskLink = item.task
    ? `<div class="upload-task">Черновик задания:
         <b>${esc(item.task.title)}</b>
         <span class="upload-chip chip-info"><i class="dot"></i>${esc(item.task.state)}</span>
         <code>${esc(item.task.id)}</code></div>`
    : "";

  return `
    <div class="upload-analysis">
      ${rows ? `<dl class="upload-meta">${rows}</dl>` : ""}
      ${warns || blocks ? `<ul class="upload-findings">${blocks}${warns}</ul>` : ""}
      ${taskLink}
    </div>`;
}

function metaRows(a) {
  const d = a.data || {};
  const parts = [];
  const add = (k, v) => {
    if (v !== null && v !== undefined && v !== "") parts.push(`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`);
  };

  add("Формат", fmtFormatLabel(a.detectedFormat));
  if (a.detectedFormat === "stl") {
    add("Тип STL", d.stlVariant === "ascii" ? "ASCII" : "бинарный");
    add("Треугольников", d.triangles);
    add("Единицы", "неизвестны");
    add("Габариты", fmtBbox(d.bbox, false));
  } else if (a.detectedFormat === "gcode") {
    add("Слайсер", joinVer(d.slicer, d.slicerVersion));
    add("Принтер", d.printerModel);
    add("Материал", a.material);
    add("Время печати", fmtDuration(a.estimatedDurationS));
    add("Филамент", a.estimatedFilamentG != null ? `${a.estimatedFilamentG} г` : null);
    add("Высота слоя", a.layerHeightMm != null ? `${a.layerHeightMm} мм` : null);
    add("Сопло", a.nozzleDiameterMm != null ? `${a.nozzleDiameterMm} мм` : null);
    add("Температуры", fmtTemps(d.nozzleTempC, d.bedTempC));
    add("Габариты", fmtBbox(d.bbox, true));
  } else if (a.detectedFormat === "3mf") {
    add("Класс", fmt3mfClass(d.threeMfClass));
    add("Единицы", d.units);
    add("Объектов", d.objectCount);
    add("Build items", d.buildItemCount);
    add("Пластин", d.plateCount);
    add("Слайсер", d.slicer);
    add("Материал", a.material);
    add("G-code внутри", d.hasGcodePayload ? "да" : "нет");
    add("Габариты", fmtBbox(d.bbox, true));
  }
  return parts.join("");
}

/* ── Форматирование, специфичное для загрузок ───────────────── */

function fmtFormatLabel(f) {
  if (f === "gcode") return "G-code";
  if (f === "3mf") return "3MF";
  if (f === "stl") return "STL";
  return "неизв.";
}

function fmt3mfClass(c) {
  return (
    { generic: "модель 3MF", slicer_project: "проект слайсера", sliced: "нарезанный / G-code 3MF", unknown: "неизвестный 3MF" }[c] || c
  );
}

export function guessFormat(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "gcode" || ext === "gco" || ext === "g") return "gcode";
  if (ext === "3mf") return "3mf";
  if (ext === "stl") return "stl";
  return "unknown";
}

function fmtBbox(bbox, unitsKnown) {
  if (!bbox || !bbox.size) return null;
  const [x, y, z] = bbox.size.map((v) => Math.round(v * 100) / 100);
  const suffix = unitsKnown ? " мм" : " (ед. неизв.)";
  const conf = bbox.confidence && bbox.confidence !== "high" ? ` · точность: ${bbox.confidence}` : "";
  return `${x} × ${y} × ${z}${suffix}${conf}`;
}

function fmtTemps(nozzle, bed) {
  const parts = [];
  if (nozzle != null) parts.push(`сопло ${nozzle}°`);
  if (bed != null) parts.push(`стол ${bed}°`);
  return parts.length ? parts.join(" · ") : null;
}

function joinVer(name, ver) {
  if (!name) return null;
  return ver ? `${name} ${ver}` : name;
}
