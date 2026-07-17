/* ═══════════════════════════════════════════════════════════════
   Раздел «Загрузка и анализ» — единственная точка загрузки файлов
   в новую SQLite-модель (/api/print). Файлы НЕ попадают в старую
   очередь: каждая загрузка создаёт артефакт + черновик задания
   (DRAFT) + анализ, который считается фоновым worker'ом; панель
   опрашивает его состояние. Раздел живёт своей жизнью и не
   пересобирается вместе с доской (renderBoard его не трогает).
   ═══════════════════════════════════════════════════════════════ */

import { apiGet, apiPost, uploadArtifact } from "../api.js";
import { $, esc, toast } from "../util.js";

const ACCEPT = ".stl,.3mf,.gcode";
const MAX_PARALLEL = 3;
const POLL_MS = 1500;

/* Модель одного элемента загрузки. Ключ — localId (для активных загрузок) или
   artifact.id (для уже сохранённых). */
let items = [];
let seq = 0;
let pollTimer = null;
let uploading = 0;
const uploadQueue = [];
/* File-объекты держим отдельно от модели элемента (их не сериализуем/не рендерим). */
const fileStore = new Map();

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

export function setupUploads() {
  const body = $("#uploads-body");
  if (!body) return;
  body.innerHTML = `
    <div class="upload-drop" id="upload-drop" tabindex="0" role="button"
         aria-label="Загрузить файлы: перетащите сюда или выберите">
      <div class="upload-drop-icon" aria-hidden="true">⇪</div>
      <div class="upload-drop-text">
        <b>Перетащите файлы сюда</b>
        <span>или <button type="button" class="upload-pick" id="upload-pick">выберите на диске</button></span>
      </div>
      <div class="upload-drop-hint">STL, 3MF, G-code · до нескольких файлов сразу</div>
      <input type="file" id="upload-input" accept="${ACCEPT}" multiple hidden />
    </div>
    <ul class="upload-list" id="upload-list"></ul>`;

  const drop = $("#upload-drop");
  const input = $("#upload-input");

  $("#upload-pick").addEventListener("click", (e) => {
    e.stopPropagation();
    input.click();
  });
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    addFiles(input.files);
    input.value = ""; // позволяет выбрать тот же файл повторно
  });

  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("is-drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && drop.contains(e.relatedTarget)) return;
      drop.classList.remove("is-drag");
    })
  );
  drop.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  // Показать уже загруженные ранее артефакты (переживают перезагрузку страницы).
  void loadExisting();
}

/* ── Загрузка новых файлов ──────────────────────────────────── */

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  for (const file of files) {
    const item = {
      key: `local-${++seq}`,
      name: file.name,
      sizeBytes: file.size,
      stage: "queued",
      progress: 0,
      error: null,
      artifact: null,
      analysis: null,
      task: null,
      blobExisted: false
    };
    fileStore.set(item.key, file);
    items.unshift(item);
    uploadQueue.push(item);
  }
  render();
  pumpUploads();
}

function pumpUploads() {
  while (uploading < MAX_PARALLEL && uploadQueue.length > 0) {
    const item = uploadQueue.shift();
    uploading++;
    void doUpload(item).finally(() => {
      uploading--;
      pumpUploads();
    });
  }
}

async function doUpload(item) {
  item.stage = "uploading";
  item.progress = 0;
  render();
  try {
    const file = findFile(item);
    const res = await uploadArtifact(file, {
      onProgress: (p) => {
        item.progress = p;
        renderItem(item);
      }
    });
    // Один файл — один запрос; ответ несёт артефакт, черновик задания и анализ.
    item.artifact = res.artifact;
    item.task = res.task;
    item.analysis = res.analysis;
    item.blobExisted = Boolean(res.blobExisted);
    fileStore.delete(item.key); // отданный файл больше не нужен
    item.key = res.artifact?.id || item.key;
    item.stage = "analyzing";
    render();
    ensurePolling();
  } catch (err) {
    fileStore.delete(item.key);
    if (err?.name === "AbortError") {
      // Элемент уже удалён — ничего не показываем.
      return;
    }
    item.stage = "error";
    item.error = err?.message || "Не удалось загрузить файл";
    render();
    toast(`«${esc(item.name)}»: ${esc(item.error)}`, "toast-danger");
  }
}

function findFile(item) {
  return fileStore.get(item.key);
}

/* ── Опрос состояния анализа ────────────────────────────────── */

function ensurePolling() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(pollActive, POLL_MS);
}

function hasActiveAnalysis() {
  return items.some(
    (it) => it.artifact && it.analysis && (it.analysis.state === "pending" || it.analysis.state === "running")
  );
}

async function pollActive() {
  if (!hasActiveAnalysis()) {
    clearInterval(pollTimer);
    pollTimer = null;
    return;
  }
  const active = items.filter(
    (it) => it.artifact && it.analysis && (it.analysis.state === "pending" || it.analysis.state === "running")
  );
  await Promise.all(
    active.map(async (it) => {
      try {
        const detail = await apiGet(`/api/print/artifacts/${it.artifact.id}`);
        applyDetail(it, detail);
      } catch {
        /* тихо: следующий тик повторит */
      }
    })
  );
  render();
}

function applyDetail(item, detail) {
  if (!detail) return;
  item.artifact = detail.artifact || item.artifact;
  item.task = detail.task || item.task;
  const latest = (detail.analyses || [])[detail.analyses.length - 1] || item.analysis;
  item.analysis = latest;
  if (latest) {
    if (latest.state === "ready") item.stage = "done";
    else if (latest.state === "failed") item.stage = "failed";
    else item.stage = "analyzing";
  }
}

/* ── Существующие артефакты (при открытии страницы) ─────────── */

async function loadExisting() {
  try {
    const { artifacts } = await apiGet("/api/print/artifacts");
    for (const row of artifacts || []) {
      if (items.some((it) => it.artifact && it.artifact.id === row.artifact.id)) continue;
      items.push(toItem(row));
    }
    render();
    if (hasActiveAnalysis()) ensurePolling();
  } catch {
    /* backend недоступен — раздел просто пуст до восстановления связи */
  }
}

function toItem(row) {
  const analysis = row.analysis;
  const stage = !analysis
    ? "analyzing"
    : analysis.state === "ready"
      ? "done"
      : analysis.state === "failed"
        ? "failed"
        : "analyzing";
  return {
    key: row.artifact.id,
    name: row.artifact.name,
    sizeBytes: row.artifact.sizeBytes,
    stage,
    progress: 1,
    error: null,
    artifact: row.artifact,
    analysis,
    task: row.task,
    blobExisted: false
  };
}

/* ── Повторный анализ ───────────────────────────────────────── */

async function reanalyze(artifactId) {
  const item = items.find((it) => it.artifact && it.artifact.id === artifactId);
  if (!item) return;
  item.stage = "analyzing";
  item.error = null;
  render();
  try {
    const { analysis } = await apiPost(`/api/print/artifacts/${artifactId}/analyze`);
    item.analysis = analysis;
    render();
    ensurePolling();
  } catch (err) {
    item.stage = "failed";
    toast(`Не удалось перезапустить анализ: ${esc(err.message)}`, "toast-danger");
  }
}

/* ── Отрисовка ──────────────────────────────────────────────── */

function render() {
  const list = $("#upload-list");
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = items.map((it) => itemHtml(it)).join("");
}

function renderItem(item) {
  const el = document.querySelector(`[data-upload="${cssEscape(item.key)}"]`);
  if (el) el.outerHTML = itemHtml(item);
}

function itemHtml(item) {
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
  return chip(v.label, v.cls);
}

function chip(label, cls, pulse = false) {
  return `<span class="upload-chip chip-${cls}"><i class="dot${pulse ? " dot-pulse" : ""}"></i>${esc(label)}</span>`;
}

function analysisHtml(item, a) {
  if (a.state === "failed") {
    return `
      <div class="upload-analysis">
        <div class="upload-error">Анализ не удался: ${esc(a.error || "неизвестная ошибка")}</div>
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

/* ── Делегированные клики (повторный анализ) ────────────────── */

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-reanalyze]");
  if (btn) {
    e.preventDefault();
    void reanalyze(btn.dataset.reanalyze);
  }
});

/* ── Форматирование ─────────────────────────────────────────── */

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

function guessFormat(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "gcode" || ext === "gco" || ext === "g") return "gcode";
  if (ext === "3mf") return "3mf";
  if (ext === "stl") return "stl";
  return "unknown";
}

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

function fmtBbox(bbox, unitsKnown) {
  if (!bbox || !bbox.size) return null;
  const [x, y, z] = bbox.size.map((v) => Math.round(v * 100) / 100);
  const suffix = unitsKnown ? " мм" : " (ед. неизв.)";
  const conf = bbox.confidence && bbox.confidence !== "high" ? ` · точность: ${bbox.confidence}` : "";
  return `${x} × ${y} × ${z}${suffix}${conf}`;
}

function fmtDuration(s) {
  if (s == null) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} ч ${m} м` : `${m} м`;
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

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}
