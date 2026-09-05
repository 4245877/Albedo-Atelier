/* ═══════════════════════════════════════════════════════════════
   Раздел «Загрузка и анализ» — controller. Единственная точка загрузки
   файлов в новую SQLite-модель (/api/print). Файлы НЕ попадают в старую
   очередь: каждая загрузка создаёт артефакт + черновик задания (DRAFT) +
   анализ, который считается фоновым worker'ом; панель опрашивает его
   состояние. Раздел живёт своей жизнью и не пересобирается вместе с доской
   (renderBoard его не трогает). Разметка элементов — view.js.
   ═══════════════════════════════════════════════════════════════ */

import { apiDelete, apiGet, apiPost, uploadArtifact } from "../../api.js";
import { confirmAction, createFocusTrap } from "../../shared/dialog.js";
import { createInflightGuard } from "../../shared/inflight.js";
import { createPoller } from "../../shared/polling.js";
import { $, cssEscape, esc, toast } from "../../util.js";
import { itemHtml, listBarHtml } from "./view.js";
import { icon } from "../../shared/icons.js";

/* Ровно то, что принимает сервер (GET /api/print/artifacts/config).
   `.gcode.3mf` попадает сюда через `.3mf` — отдельного расширения у него нет. */
const ACCEPT = ".stl,.3mf,.gcode,.gco,.g";
const MAX_PARALLEL = 3;
const POLL_MS = 1500;
/* До скольких карточек список показывается целиком. Дальше он живёт в блоке с
   собственной прокруткой: иначе полсотни моделей уносили «Слайсинг», «Очередь»
   и все прочие разделы на несколько экранов вниз. */
const INLINE_ITEMS = 3;

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
/* То же для удаления: окно подтверждения держит кнопку заблокированной, но
   защита нужна и от второго окна, открытого до ответа сервера. */
const deleteGuard = createInflightGuard();
/* Явный выбор оператора «раскрыть/свернуть свойства» по ключу элемента. Живёт
   вне разметки: список перерисовывается на каждом тике опроса, и без этой карты
   раскрытые свойства схлопывались бы, как только у соседнего файла сменился
   статус. Пусто = поведение по умолчанию (см. detailsOpenFor). */
const detailPrefs = new Map();
/* Свёрнут ли список целиком (кнопка в шапке блока). */
let listCollapsed = false;

export function setupUploads() {
  const body = $("#uploads-body");
  if (!body) return;
  body.innerHTML = `
    <div class="upload-drop" id="upload-drop" tabindex="0" role="button"
         aria-label="Загрузить файлы: перетащите сюда или выберите">
      <div class="upload-drop-icon" aria-hidden="true">${icon("upload", { cls: "ico-xl" })}</div>
      <div class="upload-drop-text">
        <b>Вверьте мне ваши файлы, Владыка</b>
        <span>перетащите сюда или <button type="button" class="upload-pick" id="upload-pick">выберите на диске</button></span>
      </div>
      <div class="upload-drop-hint">STL, 3MF, G-code и нарезанный .gcode.3mf · до нескольких файлов сразу</div>
      <input type="file" id="upload-input" accept="${ACCEPT}" multiple hidden />
    </div>
    <div class="upload-listbox" id="upload-listbox" hidden>
      <div class="upload-listbar">
        <span class="panel-sub">Загруженные файлы</span>
        <span class="upload-counts" id="upload-counts"></span>
        <span class="slice-spacer"></span>
        <button type="button" class="btn btn-sm" id="upload-collapse" aria-controls="upload-list"></button>
      </div>
      <ul class="upload-list" id="upload-list"></ul>
    </div>`;

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

  $("#upload-collapse").addEventListener("click", () => {
    listCollapsed = !listCollapsed;
    render();
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
  void syncExisting();

  // Вкладку вернули на передний план: за это время файл мог быть удалён или
  // занят в другой вкладке. Сверяемся, вместо того чтобы показывать прошлое.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncExisting();
  });
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
      /* Почему файл нельзя удалить (строка с сервера) или null. Пока файл ещё
         не сохранён, удалять на сервере нечего. */
      deletionBlocker: null,
      /* Задания планировщика, которые сервер готов отменить вместе с файлом,
         или null, если отменять нечего (файл свободен) либо нельзя (идёт
         печать). Решает сервер — раздел только показывает и спрашивает. */
      deletionCascade: null,
      /* Решение сервера о следующем шаге (status.next), подтверждениях масштаба
         и проверки. Пока файл не сохранён — его нет. */
      status: null,
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
    // Ответ загрузки несёт только что созданные строки; решение о следующем шаге
    // приходит вместе с завершённым анализом (сверка/поллинг).
    item.status = null;
    item.blobExisted = Boolean(res.blobExisted);
    fileStore.delete(item.key); // отданный файл больше не нужен
    item.key = res.artifact?.id || item.key;
    if (res.analysis && res.analysis.state === "ready") {
      // Дубликат содержимого: анализ переиспользован и уже готов — не ждём поллинга,
      // сразу оповещаем слайсинг (иначе загруженный STL не появится там без F5).
      item.stage = "done";
      render();
      notifyAnalysisCompleted(item);
      // Дубликат содержимого: анализ уже готов, поллинг не запустится — а
      // следующий шаг («Поставить в очередь») известен только серверу. Без этой
      // сверки карточка осталась бы без действия до перезагрузки страницы.
      void syncExisting();
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
        // Артефакта больше нет: его удалил другой оператор или очистка. Опрашивать
        // его вечно бессмысленно — карточка уходит из списка на этом же тике.
        if (err?.status === 404) return { it, gone: true };
        // Частичный сбой одного артефакта: сохраняем прежнее, повторим на след. тике.
        return { it, error: err };
      }
    })
  );
}

function applyActive(results) {
  const vanished = new Set();
  for (const r of results) {
    if (r.gone) vanished.add(r.it);
    else if (r.detail) applyDetail(r.it, r.detail);
  }
  if (vanished.size > 0) {
    for (const it of vanished) forget(it);
    items = items.filter((it) => !vanished.has(it));
  }
  render();
  // Активных анализов не осталось — прекращаем опрос (таймер снят, запрос оборван).
  if (!hasActiveAnalysis()) poller.stop();
}

function applyDetail(item, detail) {
  if (!detail) return;
  item.artifact = detail.artifact || item.artifact;
  item.task = detail.task || item.task;
  item.status = detail.status ?? item.status;
  const latest = (detail.analyses || [])[detail.analyses.length - 1] || item.analysis;
  const wasDone = item.stage === "done";
  item.analysis = latest;
  item.deletionBlocker = detail.deletionBlocker ?? null;
  item.deletionCascade = detail.deletionCascade ?? null;
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

/* ── Существующие артефакты: чтение и сверка со списком ─────── */

/* Порядковый номер чтения списка: применяется только ответ последнего запроса,
   иначе медленный ранний ответ затирал бы свежий. */
let listSeq = 0;

/*
 * Перечитывает список файлов и СВЕРЯЕТ его с тем, что показано.
 *
 * Не просто дозагрузка: `deletionBlocker` приходит именно отсюда, а поллер
 * работает только пока идёт анализ — без сверки причина отказа застывала бы на
 * момент открытия страницы. Файл, который освободился (задание отменили,
 * назначение сняли), навсегда оставался бы с погашенной кнопкой до F5; файл,
 * удалённый в соседней вкладке, — в списке.
 *
 * Карточки текущих загрузок (у них ещё нет артефакта) не трогаются: сервер о
 * них ничего не знает, и их состоянием владеет очередь загрузки.
 */
async function syncExisting() {
  const seq = ++listSeq;
  // Что раздел знал ДО запроса. Убирать можно только эти карточки: файл,
  // загрузившийся, пока ответ был в пути, в него не попал — и вычеркнуть его
  // значило бы стереть только что успешную загрузку. Он дождётся следующей сверки.
  const knownBefore = new Set(items.filter((it) => it.artifact).map((it) => it.artifact.id));

  let artifacts;
  try {
    ({ artifacts } = await apiGet("/api/print/artifacts"));
  } catch {
    return; /* backend недоступен — оставляем показанное как есть */
  }
  if (seq !== listSeq) return; // ответ устарел, пришёл более свежий

  const byId = new Map((artifacts || []).map((row) => [row.artifact.id, row]));
  const kept = [];
  for (const it of items) {
    if (!it.artifact) {
      kept.push(it); // локальная загрузка — сервер о ней ещё не знает
      continue;
    }
    const row = byId.get(it.artifact.id);
    if (!row) {
      if (knownBefore.has(it.artifact.id)) {
        forget(it); // файла на сервере больше нет
        continue;
      }
      kept.push(it); // появился уже после запроса — ответ о нём ничего не говорит
      continue;
    }
    byId.delete(it.artifact.id);
    applyRow(it, row);
    kept.push(it);
  }
  items = kept;
  for (const row of byId.values()) items.push(toItem(row));

  render();
  if (hasActiveAnalysis()) ensurePolling();
}

/* Переносит серверную строку списка на уже показанную карточку, не теряя того,
   что знает только раздел (ключ, имя файла, прогресс загрузки). */
function applyRow(item, row) {
  const fresh = toItem(row);
  item.artifact = fresh.artifact;
  item.analysis = fresh.analysis;
  item.task = fresh.task;
  item.status = fresh.status;
  item.deletionBlocker = fresh.deletionBlocker;
  item.deletionCascade = fresh.deletionCascade;
  item.stage = fresh.stage;
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
    status: row.status ?? null,
    deletionBlocker: row.deletionBlocker ?? null,
    deletionCascade: row.deletionCascade ?? null,
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

/* ── Удаление файла ─────────────────────────────────────────── */

/* Удаление необратимо, поэтому спрашиваем — и спрашиваем предметно: имя файла,
   что именно исчезнет и что при этом уцелеет. Сам запрос идёт из окна (`run`):
   оно держится открытым, пока сервер отвечает, и показывает отказ прямо в себе,
   вместо того чтобы закрыться и оставить оператора гадать, удалилось ли. Из
   списка карточка уходит только после успешного ответа — интерфейс никогда не
   показывает удалённым то, что на сервере осталось, и наоборот.

   Файл, за который держится задание планировщика, раньше был тупиком: сервер
   отказывал, а убрать задание из этого раздела было нечем. Теперь сервер сам
   сообщает (`deletionCascade`), какие задания он готов отменить вместе с
   файлом, — и окно называет их поимённо, прежде чем спросить. Это по-прежнему
   один вопрос и одно действие: каскад уходит на сервер флагом того же запроса,
   а не отдельной отменой задания следом за удалением, которая могла бы пройти
   наполовину. */
async function removeArtifact(artifactId) {
  const item = items.find((it) => it.artifact && it.artifact.id === artifactId);
  if (!item) return;

  const cascade = item.deletionCascade || [];
  const query = cascade.length > 0 ? "?cascade=true" : "";
  // «задание» / «задания» — согласование по числу, а не безличное «задание(я)»:
  // оператор читает это перед необратимым действием.
  const one = cascade.length === 1;

  const ok = await confirmAction({
    title: cascade.length > 0 ? `Удалить файл и ${one ? "задание" : "задания"}` : "Удалить файл",
    object: item.name,
    body:
      cascade.length > 0
        ? `Файл будет стёрт из хранилища, а ${one ? "задание, которое его ждёт" : "задания, которые его ждут"}, — отменено${one ? "" : "ы"}.`
        : "Файл будет стёрт из хранилища, а его записи — из базы.",
    points: deletionPoints(item, cascade),
    cta: cascade.length > 0 ? `Удалить вместе с ${one ? "заданием" : "заданиями"}` : "Удалить файл",
    tone: "danger",
    irreversible: true,
    run: async () => {
      try {
        // Пропущенный из-за guard'а вызов — не успех: иначе окно закрылось бы, а
        // карточка исчезла бы из списка, ничего на сервере не удалив.
        const { skipped } = await deleteGuard.run(`delete:${artifactId}`, () =>
          apiDelete(`/api/print/artifacts/${encodeURIComponent(artifactId)}${query}`)
        );
        if (skipped) throw new Error("удаление этого файла уже выполняется");
      } catch (err) {
        // 404 — файла уже нет: его удалили в другой вкладке или очисткой. Оператор
        // просил, чтобы файла не было; он его не видит. Показывать ошибку значило бы
        // оставить карточку в списке ради разницы, которой для него не существует.
        if (err?.status !== 404) {
          // Отказ «файл занят» несёт причину структурно. Запоминаем её на карточке:
          // без этого кнопка осталась бы живой, предлагая ровно то, в чём сервер
          // только что отказал.
          if (err?.details?.blocker) {
            item.deletionBlocker = String(err.details.blocker);
            // Каскад, которому только что отказали, предлагать снова нельзя: за
            // файл взялось что-то, чего отменой задания не снять. Настоящую
            // причину принесёт syncExisting ниже — до тех пор молчим.
            item.deletionCascade = null;
            render();
          }
          throw err; // текст отказа показывает само окно подтверждения
        }
      }
    }
  });
  if (!ok) return;

  forget(item);
  items = items.filter((it) => it !== item);
  render();
  toast(
    cascade.length > 0
      ? `Файл «${esc(item.name)}» удалён вместе с ${cascade.length === 1 ? "заданием" : "заданиями"}, Владыка`
      : `Файл «${esc(item.name)}» удалён, Владыка`,
    "toast-ok"
  );
  // Слайсинг показывает те же файлы (модели и нарезанный G-code) — пусть узнает
  // сразу, а не через свой следующий фоновый опрос.
  document.dispatchEvent(
    new CustomEvent("artifact-deleted", { detail: { artifactId, cancelledTasks: cascade } })
  );
  // Удаление меняет и СОСЕДЕЙ: у исходной модели уходит вариант слайсинга, и она
  // может стать удаляемой. Перечитываем причины отказа, а не гадаем о них.
  void syncExisting();
}

/* Что именно произойдёт — по состоянию конкретного файла, без общих слов. */
function deletionPoints(item, cascade = []) {
  const points = ["Содержимое файла будет удалено с диска сервера"];
  // Задания называем поимённо и первыми: это самое дорогое из того, что уйдёт,
  // и единственное, чего оператор может не ожидать, нажимая «удалить файл».
  for (const task of cascade) {
    points.push(`Задание «${task.title}» (${task.state}) будет отменено и уйдёт из очереди`);
  }
  if (cascade.length > 0) {
    // Отмена — не удаление: строка остаётся в истории заданий, и это стоит
    // сказать до того, как оператор решит, что стёр её следы.
    points.push("Отменённые задания останутся в истории — из очереди уйдут только они сами");
  }
  if (item.task && item.task.state === "DRAFT") {
    points.push("Черновик задания, созданный при загрузке, будет отменён");
  }
  if (item.analysis && item.analysis.verdict === "needs_preparation") {
    // Две разные вещи, и обе стоит назвать: записи о нарезке этой модели сервер
    // удаляет вместе с ней (иначе они ссылались бы в пустоту), а сами нарезанные
    // файлы — отдельные файлы этого же списка и никуда не денутся.
    points.push("Варианты слайсинга этой модели будут удалены вместе с ней");
    points.push("Сами нарезанные G-code файлы останутся — удалите их отдельно");
  }
  points.push(
    cascade.length > 0
      ? "Уже идущую печать это не остановит — такой файл сервер удалить не даст"
      : "Файл, который используется заданием или печатью, сервер удалить не даст"
  );
  return points;
}

/* Забыть всё, что раздел помнил об элементе вне модели списка. */
function forget(item) {
  detailPrefs.delete(item.key);
  fileStore.delete(item.key);
}

/* ── Следующий шаг: постановка в очередь ────────────────────────

   Единственное действие, которого раньше не существовало вовсе. Уже готовый к
   печати файл (G-code или нарезанный .gcode.3mf) доходил до зелёного вердикта и
   останавливался: очередь пополнялась только через слайсинг, а нарезать
   нарезанное нельзя.

   Кнопку показывает сервер (`status.next.kind === "enqueue"`), он же решает,
   допустим ли файл. Здесь только отправка намерения и честный показ отказа —
   в частности отказа «нужно подтвердить проверку», который сервер помечает
   структурно (`details.needsReview`), чтобы карточка предложила подтверждение,
   а не тупик. */
const enqueueGuard = createInflightGuard();

async function enqueueArtifact(artifactId) {
  const item = items.find((it) => it.artifact && it.artifact.id === artifactId);
  const taskId = item?.status?.next?.taskId;
  if (!item || !taskId) return;

  await enqueueGuard.run(`enqueue:${taskId}`, async () => {
    try {
      await apiPost(`/api/print/tasks/${encodeURIComponent(taskId)}/enqueue`, {});
      toast(`«${esc(item.name)}» встал в очередь, Владыка`, "toast-ok");
      // Очередь и планировщик показывают то же задание — пусть узнают сразу.
      document.dispatchEvent(new CustomEvent("queue-changed", { detail: { taskId } }));
    } catch (err) {
      if (err?.details?.needsReview) {
        toast("Сначала подтвердите проверку файла — причина указана на карточке", "toast-danger");
      } else {
        toast(`Простите, Владыка — в очередь не встало: ${esc(err.message)}`, "toast-danger");
      }
    }
    await syncExisting();
  });
}

/* ── Подтверждение проверки ─────────────────────────────────────

   Нарезанный чужим слайсером файл система проверить не может: скорости,
   температуры и форма стола заданы чужим профилем. Анализ говорит об этом
   честно (вердикт «на проверку»), и до сих пор это было тупиком — запуск
   требует «schedulable».

   Подтверждение привязывается к содержимому файла и к конкретному анализу:
   перезалили файл или переанализировали — подтверждение отпадает само. Поэтому
   окно называет и файл, и то, что именно принимается. */
async function confirmReview(artifactId) {
  const item = items.find((it) => it.artifact && it.artifact.id === artifactId);
  if (!item) return;

  const findings = (item.analysis?.warnings || []).map((w) => w.message);
  const ok = await confirmAction({
    title: "Подтвердить проверку файла",
    object: item.name,
    body:
      "Файл уже нарезан, и его параметры заданы не нами. Система не может их проверить — " +
      "это может сделать только человек, который знает, для какого принтера файл готовился.",
    points: [
      ...findings,
      "Подтверждение записывается в журнал вместе с вашим именем",
      "Оно отпадёт само, если файл заменить или переанализировать",
      "Ночной запуск без присмотра оно НЕ разрешает"
    ],
    cta: "Я проверил, подтверждаю",
    tone: "warn",
    run: async () => {
      await apiPost(`/api/print/artifacts/${encodeURIComponent(artifactId)}/review`, {});
    }
  });
  if (!ok) return;
  toast(`Проверка «${esc(item.name)}» подтверждена`, "toast-ok");
  await syncExisting();
}

/* ── Подтверждение единиц модели ────────────────────────────────

   STL не хранит единиц: его габариты — просто числа, которые могут оказаться
   миллиметрами, сантиметрами или дюймами. Серверная логика масштаба (и отказ
   ночного запуска без него) существует давно; не было места, где это сказать.

   Показываем рассчитанный габарит прямо в окне: выбор «мм или дюймы» без
   чисел, к которым он применяется, — это угадывание. */
function boundingBoxText(item) {
  const g = item.analysis?.data?.geometry;
  const raw = g?.sizeRaw || g?.sizeMm || item.analysis?.data?.bbox?.size;
  if (!Array.isArray(raw)) return null;
  const [x, y, z] = raw.map((v) => Math.round(v * 100) / 100);
  return `${x} × ${y} × ${z}`;
}

async function confirmScale(artifactId) {
  const item = items.find((it) => it.artifact && it.artifact.id === artifactId);
  if (!item) return;
  const box = boundingBoxText(item);

  const units = await pickUnits(item, box);
  if (!units) return;
  try {
    await apiPost(`/api/print/artifacts/${encodeURIComponent(artifactId)}/scale`, { units });
    toast(`Единицы «${esc(item.name)}» подтверждены`, "toast-ok");
  } catch (err) {
    toast(`Простите, Владыка — масштаб не принят: ${esc(err.message)}`, "toast-danger");
  }
  await syncExisting();
}

/* Маленькое окно выбора единиц. Своё, а не confirmAction: здесь не «да/нет», а
   выбор из четырёх равноправных значений, и подменять его четырьмя окнами
   подтверждения было бы издевательством. */
function pickUnits(item, box) {
  return new Promise((resolve) => {
    // Те же классы, что у общего окна подтверждения (shared/dialog.js): один
    // фон, одна геометрия, одна тема. Своя разметка — только внутри.
    const root = document.createElement("div");
    root.className = "modal-backdrop confirm-backdrop";
    root.innerHTML = `
      <div class="modal modal-confirm tone-warn" role="dialog" aria-modal="true" aria-labelledby="units-title">
        <div class="confirm-head">
          <span class="confirm-mark" aria-hidden="true">${icon("warn", { cls: "ico-lg" })}</span>
          <div>
            <h2 id="units-title">В каких единицах эта модель?</h2>
            <p class="confirm-object">${esc(item.name)}</p>
          </div>
        </div>
        <div class="confirm-body">
          <p>STL не хранит единиц измерения — внутри только числа. Пока никто не скажет,
             что они значат, размеры модели недоказуемы, и я не приму её к печати без присмотра.</p>
          ${box ? `<p class="confirm-object">Габариты по файлу: <b>${esc(box)}</b> — в выбранных единицах.</p>` : ""}
          <div class="units-choice">
            ${UNIT_CHOICES.map(
              (u) => `<button type="button" class="btn" data-units="${u.value}">
                        ${esc(u.label)}${box ? `<span class="units-hint">${esc(previewSize(box, u.factor))}</span>` : ""}
                      </button>`
            ).join("")}
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" data-units-cancel>Отмена</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    let trap = null;
    const close = (value) => {
      trap?.release();
      root.remove();
      resolve(value);
    };
    // Escape и клик по фону — «не выбрал», а не «выбрал миллиметры»: молчание
    // здесь означает, что вопрос остался открытым, и сервер продолжит отказывать.
    trap = createFocusTrap(root, { onEscape: () => close(null) });
    root.addEventListener("click", (e) => {
      if (e.target === root || e.target.closest("[data-units-cancel]")) return close(null);
      const pick = e.target.closest("[data-units]");
      if (pick) close(pick.dataset.units);
    });
    trap.focusFirst();
  });
}

const UNIT_CHOICES = [
  { value: "mm", label: "Миллиметры", factor: 1 },
  { value: "cm", label: "Сантиметры", factor: 10 },
  { value: "inch", label: "Дюймы", factor: 25.4 },
  { value: "m", label: "Метры", factor: 1000 }
];

/* «100 × 50 × 20» + ×25.4 → «2540 × 1270 × 508 мм»: что именно получится, если
   выбрать эту единицу. Без этого выбор делается вслепую. */
function previewSize(box, factor) {
  const parts = box.split("×").map((v) => Number.parseFloat(v.trim()));
  if (parts.some((v) => !Number.isFinite(v))) return "";
  return `${parts.map((v) => Math.round(v * factor * 10) / 10).join(" × ")} мм`;
}

/* ── Отрисовка (разметка — view.js) ─────────────────────────── */

/* Свойства файла раскрыты по умолчанию, пока файлов один-два: обычный сценарий
   «загрузил модель — смотрю, что с ней». Как только список становится списком,
   по умолчанию они свёрнуты, и каждая карточка занимает одну строку. Явный
   выбор оператора всегда сильнее умолчания. */
function detailsOpenFor(item) {
  const pref = detailPrefs.get(item.key);
  return pref === undefined ? items.length <= 2 : pref;
}

function render() {
  const list = $("#upload-list");
  const box = $("#upload-listbox");
  if (!list || !box) return;

  box.hidden = items.length === 0;
  if (items.length === 0) {
    list.innerHTML = "";
    return;
  }

  $("#upload-counts").innerHTML = listBarHtml(items);

  const btn = $("#upload-collapse");
  btn.innerHTML = listCollapsed
    ? `${icon("chevronRight")}<span>Показать список (${items.length})</span>`
    : `${icon("chevronDown")}<span>Свернуть список</span>`;
  btn.setAttribute("aria-expanded", listCollapsed ? "false" : "true");
  box.classList.toggle("is-collapsed", listCollapsed);
  // Длинный список получает собственную прокрутку — страница из-за него больше
  // не растёт, и кнопки соседних разделов остаются в пределах экрана.
  box.classList.toggle("is-scrollable", items.length > INLINE_ITEMS);

  list.innerHTML = items.map((it) => itemHtml(it, { detailsOpen: detailsOpenFor(it) })).join("");
}

function renderItem(item) {
  const el = document.querySelector(`[data-upload="${cssEscape(item.key)}"]`);
  if (el) el.outerHTML = itemHtml(item, { detailsOpen: detailsOpenFor(item) });
}

/* ── Делегированные клики (повторный анализ) ────────────────── */

document.addEventListener("click", (e) => {
  const analyze = e.target.closest("[data-reanalyze]");
  if (analyze) {
    e.preventDefault();
    void reanalyze(analyze.dataset.reanalyze);
    return;
  }
  const enqueue = e.target.closest("[data-enqueue]");
  if (enqueue) {
    e.preventDefault();
    void enqueueArtifact(enqueue.dataset.enqueue);
    return;
  }
  const review = e.target.closest("[data-confirm-review]");
  if (review) {
    e.preventDefault();
    void confirmReview(review.dataset.confirmReview);
    return;
  }
  const scale = e.target.closest("[data-confirm-scale]");
  if (scale) {
    e.preventDefault();
    void confirmScale(scale.dataset.confirmScale);
    return;
  }
  const toSlicing = e.target.closest("[data-goto-slicing]");
  if (toSlicing) {
    e.preventDefault();
    document.querySelector('[data-goto="slicing"]')?.click();
    document.getElementById("slicing")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const remove = e.target.closest("[data-delete-artifact]");
  if (remove) {
    e.preventDefault();
    void removeArtifact(remove.dataset.deleteArtifact);
    return;
  }
  // Карточка неудавшейся загрузки: на сервере ничего нет, убираем только строку.
  const dismiss = e.target.closest("[data-upload-dismiss]");
  if (dismiss) {
    e.preventDefault();
    const key = dismiss.dataset.uploadDismiss;
    const item = items.find((it) => it.key === key && !it.artifact);
    if (!item) return;
    forget(item);
    items = items.filter((it) => it !== item);
    render();
  }
});

/* Раскрытие свойств запоминается по ключу элемента: событие toggle не всплывает,
   поэтому слушаем его на фазе перехвата. */
document.addEventListener(
  "toggle",
  (e) => {
    const d = e.target;
    if (!d || typeof d.matches !== "function" || !d.matches("[data-upload-details]")) return;
    const li = d.closest("[data-upload]");
    if (li) detailPrefs.set(li.dataset.upload, d.open);
  },
  true
);

// Уход со страницы снимает таймер опроса и обрывает активный запрос.
window.addEventListener("pagehide", () => poller.stop());
