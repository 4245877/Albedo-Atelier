/* ═══════════════════════════════════════════════════════════════
   Раздел «Загрузка и анализ» — controller. Единственная точка загрузки
   файлов в новую SQLite-модель (/api/print). Файлы НЕ попадают в старую
   очередь: каждая загрузка создаёт артефакт + черновик задания (DRAFT) +
   анализ, который считается фоновым worker'ом; панель опрашивает его
   состояние. Раздел живёт своей жизнью и не пересобирается вместе с доской
   (renderBoard его не трогает). Разметка элементов — view.js.
   ═══════════════════════════════════════════════════════════════ */

import { apiGet, apiPost, uploadArtifact } from "../../api.js";
import { createInflightGuard } from "../../shared/inflight.js";
import { createPoller } from "../../shared/polling.js";
import { $, cssEscape, esc, toast } from "../../util.js";
import { itemHtml } from "./view.js";

const ACCEPT = ".stl,.3mf,.gcode";
const MAX_PARALLEL = 3;
const POLL_MS = 1500;

/* Модель одного элемента загрузки. Ключ — localId (для активных загрузок) или
   artifact.id (для уже сохранённых). */
let items = [];
let seq = 0;
let uploading = 0;
const uploadQueue = [];
/* File-объекты держим отдельно от модели элемента (их не сериализуем/не рендерим). */
const fileStore = new Map();
/* Защита от двойного запуска повторного анализа (по artifactId). */
const analyzeGuard = createInflightGuard();

export function setupUploads() {
  const body = $("#uploads-body");
  if (!body) return;
  body.innerHTML = `
    <div class="upload-drop" id="upload-drop" tabindex="0" role="button"
         aria-label="Загрузить файлы: перетащите сюда или выберите">
      <div class="upload-drop-icon" aria-hidden="true">⇪</div>
      <div class="upload-drop-text">
        <b>Вверьте мне ваши файлы, Владыка</b>
        <span>перетащите сюда или <button type="button" class="upload-pick" id="upload-pick">выберите на диске</button></span>
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
    if (res.analysis && res.analysis.state === "ready") {
      // Дубликат содержимого: анализ переиспользован и уже готов — не ждём поллинга,
      // сразу оповещаем слайсинг (иначе загруженный STL не появится там без F5).
      item.stage = "done";
      render();
      notifyAnalysisCompleted(item);
    } else {
      item.stage = "analyzing";
      render();
      ensurePolling();
    }
  } catch (err) {
    fileStore.delete(item.key);
    if (err?.name === "AbortError") {
      // Элемент уже удалён — ничего не показываем.
      return;
    }
    item.stage = "error";
    item.error = err?.message || "Не удалось загрузить файл";
    render();
    toast(`Простите, Владыка — файл «${esc(item.name)}» не принят: ${esc(item.error)}`, "toast-danger");
  }
}

function findFile(item) {
  return fileStore.get(item.key);
}

/* ── Опрос состояния анализа ────────────────────────────────── */

/* Единый поллер: не более одного запроса одновременно (single-flight),
   latest-only, отмена активного запроса при остановке. Следующий тик
   планируется ПОСЛЕ завершения предыдущего — пересечения исключены. */
const poller = createPoller({
  run: (signal) => fetchActive(signal),
  apply: (results) => applyActive(results),
  onError: () => {
    // Временная ошибка: последнее успешное состояние сохраняется, следующий тик
    // повторит запрос. Ничего не затираем — это осознанный ретрай, не глушение.
  },
  intervalMs: POLL_MS,
  // Первый тик — по таймеру: загрузка/повторный анализ уже отрисовали «анализ…».
  immediate: false
});

function ensurePolling() {
  // start() no-op, если цикл уже идёт — второй петли не возникает.
  if (hasActiveAnalysis()) poller.start();
}

function activeItems() {
  return items.filter(
    (it) => it.artifact && it.analysis && (it.analysis.state === "pending" || it.analysis.state === "running")
  );
}

function hasActiveAnalysis() {
  return activeItems().length > 0;
}

async function fetchActive(signal) {
  const active = activeItems();
  return Promise.all(
    active.map(async (it) => {
      try {
        const detail = await apiGet(`/api/print/artifacts/${it.artifact.id}`, { signal });
        return { it, detail };
      } catch (err) {
        // Отмена (вытеснение/стоп) — наверх, поллер её проглотит.
        if (err?.name === "AbortError") throw err;
        // Частичный сбой одного артефакта: сохраняем прежнее, повторим на след. тике.
        return { it, error: err };
      }
    })
  );
}

function applyActive(results) {
  for (const r of results) {
    if (r.detail) applyDetail(r.it, r.detail);
  }
  render();
  // Активных анализов не осталось — прекращаем опрос (таймер снят, запрос оборван).
  if (!hasActiveAnalysis()) poller.stop();
}

function applyDetail(item, detail) {
  if (!detail) return;
  item.artifact = detail.artifact || item.artifact;
  item.task = detail.task || item.task;
  const latest = (detail.analyses || [])[detail.analyses.length - 1] || item.analysis;
  const wasDone = item.stage === "done";
  item.analysis = latest;
  if (latest) {
    if (latest.state === "ready") {
      item.stage = "done";
      // Оповещаем только при первом переходе в «готово», а не на каждом тике.
      if (!wasDone) notifyAnalysisCompleted(item);
    } else if (latest.state === "failed") item.stage = "failed";
    else item.stage = "analyzing";
  }
}

/* Кросс-модульное событие: анализ артефакта завершён. Раздел слайсинга слушает его
   и обновляет список моделей, чтобы загруженный STL/3MF сразу стал доступен для
   «Запуска слайсинга» без перезагрузки страницы. */
function notifyAnalysisCompleted(item) {
  document.dispatchEvent(
    new CustomEvent("artifact-analysis-completed", {
      detail: { artifactId: item.artifact?.id, verdict: item.analysis?.verdict }
    })
  );
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
  // Двойное нажатие «Повторить анализ» не запускает вторую одинаковую мутацию.
  await analyzeGuard.run(`analyze:${artifactId}`, async () => {
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
      toast(`Простите, Владыка — анализ не перезапустился: ${esc(err.message)}`, "toast-danger");
      render();
    }
  });
}

/* ── Отрисовка (разметка — view.js) ─────────────────────────── */

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

/* ── Делегированные клики (повторный анализ) ────────────────── */

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-reanalyze]");
  if (btn) {
    e.preventDefault();
    void reanalyze(btn.dataset.reanalyze);
  }
});

// Уход со страницы снимает таймер опроса и обрывает активный запрос.
window.addEventListener("pagehide", () => poller.stop());
