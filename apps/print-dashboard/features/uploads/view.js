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
  const warns = (a.warnings || []).map((w) => findingHtml(w, "upload-warn", "⚠")).join("");
  const blocks = (a.blockers || []).map((b) => findingHtml(b, "upload-block", "⛔")).join("");

  return `
    <div class="upload-analysis">
      ${verdictNote(a)}
      ${rows ? `<dl class="upload-meta">${rows}</dl>` : ""}
      ${warns || blocks ? `<ul class="upload-findings">${blocks}${warns}</ul>` : ""}
      ${taskHtml(item)}
    </div>`;
}

/* Находка = факт + (необязательно) что с этим делать. Подсказка идёт отдельной
   строкой: сообщение остаётся описанием причины, а не инструкцией. */
function findingHtml(f, cls, icon) {
  const hint = f.hint ? `<span class="upload-hint">${esc(f.hint)}</span>` : "";
  return `<li class="${cls}">${icon} ${esc(f.message)}${hint}</li>`;
}

/* Вердикт «заблокировано» сам по себе ничего не объясняет, а рядом ещё и висит
   черновик в NEEDS_REVIEW — со стороны это два непонятных статуса об одном и том
   же. Поэтому даём одну человеческую фразу: что произошло и что дальше. */
const VERDICT_NOTE = {
  blocked: "Файл не удалось подготовить к печати — причина ниже. Задание отложено на проверку.",
  review: "Файл сохранён, но автоматически распознать его не вышло — нужен взгляд оператора.",
  needs_input: "Файл принят, но для планирования не хватает данных.",
  needs_preparation: "Файл принят. Это модель — перед печатью её нужно нарезать (раздел «Слайсинг»)."
};

function verdictNote(a) {
  const note = VERDICT_NOTE[a.verdict];
  return note ? `<p class="upload-note">${esc(note)}</p>` : "";
}

function taskHtml(item) {
  if (!item.task) return "";
  const reason = item.task.reason
    ? `<div class="upload-task-reason">${esc(item.task.reason)}</div>`
    : "";
  return `
    <div class="upload-task">Черновик задания:
      <b>${esc(item.task.title)}</b>
      <span class="upload-chip chip-info"><i class="dot"></i>${esc(TASK_STATE[item.task.state] || item.task.state)}</span>
      <code>${esc(item.task.id)}</code>
    </div>${reason}`;
}

/* NEEDS_REVIEW/DRAFT — внутренние имена состояний; оператору нужны слова. */
const TASK_STATE = {
  DRAFT: "черновик",
  NEEDS_REVIEW: "нужна проверка",
  QUEUED: "в очереди",
  PLANNED: "запланировано",
  ASSIGNED: "назначено принтеру",
  DISPATCHING: "отправляется",
  PRINTING: "печатается",
  COMPLETED: "напечатано",
  CANCELLED: "отменено",
  FAILED: "сбой"
};

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
    add("Единицы", "неизвестны (STL их не хранит)");
    add("Габариты", fmtGeometry(d));
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
    add("Создан в", fmtProducer(d));
    add("Единицы", fmtUnits(d));
    add("Объектов", d.objectCount);
    add("Build items", d.buildItemCount);
    // >1 — модель разложена по нескольким частям (production extension 3MF).
    if (d.modelPartCount > 1) add("Частей модели", d.modelPartCount);
    add("Пластин", d.plateCount);
    add("Материал", a.material);
    add("G-code внутри", fmtGcodePayload(d));
    add("Габариты", fmtGeometry(d));
    add("По пластинам", fmtPlates(d.geometry));
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
    {
      generic: "модель 3MF",
      slicer_project: "проект слайсера",
      sliced: "нарезанный / G-code 3MF",
      // «unknown» больше не значит «мы не смогли открыть файл» — только «внутри
      // архива нет 3D-модели». Причина всегда приходит отдельной находкой.
      unknown: "архив без 3D-модели"
    }[c] || c
  );
}

const PRODUCER = {
  orcaslicer: "OrcaSlicer",
  bambustudio: "Bambu Studio",
  prusaslicer: "PrusaSlicer",
  cura: "Cura",
  other: "другой слайсер"
};

/* «Создан в» — название слайсера, а в скобках его собственная подпись из файла
   (`OrcaSlicer-2.1.1`), чтобы видеть версию. Если файл ничего не сообщает —
   строка не выводится вовсе, а не показывает «—». */
function fmtProducer(d) {
  const label = d.producer ? PRODUCER[d.producer] || d.producer : null;
  if (!label) return d.slicer || null;
  return d.slicer && d.slicer !== label ? `${label} (${d.slicer})` : label;
}

function fmtGcodePayload(d) {
  if (!d.hasGcodePayload) return "нет — это модель, её ещё нужно нарезать";
  const n = Array.isArray(d.gcodeEntries) ? d.gcodeEntries.length : 0;
  return n > 1 ? `да, ${n} шт.` : "да";
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
  const conf = bbox.confidence && bbox.confidence !== "high" ? ` · точность: ${bbox.confidence}` : "";
  return `${fmtTriple(bbox.size, unitsKnown)}${conf}`;
}

/* Габариты из нормализованного `geometry` (анализатор ≥ 1.1.0): миллиметры
   показываются только тогда, когда файл действительно доказал единицы —
   иначе выводятся исходные числа с явной пометкой. Старые записи анализа
   (без `geometry`) читаются по прежней схеме bbox + units. */
function fmtGeometry(d) {
  const g = d.geometry;
  if (!g) return fmtBbox(d.bbox, d.units && d.units !== "unknown");
  if (g.sizeMm) return fmtTriple(g.sizeMm, true);
  if (g.multiPlate) {
    return g.sceneSizeMm
      ? `${fmtTriple(g.sceneSizeMm, true)} — суммарно по ${g.plateCount} пластинам, не размер одной печати`
      : `не определены: ${g.plateCount} пластин, выберите одну`;
  }
  if (g.sizeRaw) return fmtTriple(g.sizeRaw, false);
  return null;
}

function fmtPlates(g) {
  if (!g || !Array.isArray(g.plates) || g.plates.length < 2) return null;
  return g.plates
    .map((p) => {
      const size = p.sizeMm ? fmtTriple(p.sizeMm, true) : p.sizeRaw ? fmtTriple(p.sizeRaw, false) : "—";
      return `#${p.index}: ${size} (объектов: ${p.objectCount})`;
    })
    .join(" · ");
}

function fmtUnits(d) {
  const g = d.geometry;
  const units = (g && g.sourceUnits) || d.units;
  if (!units) return null;
  if (units === "unknown") {
    const declared = g && g.declaredUnits;
    return declared ? `не распознаны («${declared}»)` : "не указаны";
  }
  return units;
}

function fmtTriple(size, unitsKnown) {
  const [x, y, z] = size.map((v) => Math.round(v * 100) / 100);
  return `${x} × ${y} × ${z}${unitsKnown ? " мм" : " (ед. неизв.)"}`;
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
