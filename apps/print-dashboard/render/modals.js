/* ── Модальные окна: детали принтера, форма задания, справка ──
   Один слой поверх доски. Открывается по data-act (open / launch / files / …),
   закрывается по фону, крестику или Esc. Детальное окно принтера живёт вместе
   с доской: syncModals() перерисовывает его при обновлении состояния, не разрывая
   живой поток камеры (реконсиляция плееров как на доске). */

import { API_BASE, apiGet, apiPost } from "../api.js";
import { reconcileCameras } from "../cameraPlayers.js";
import { $, esc, setBusy, toast } from "../util.js";
import { badge } from "../shared/chips.js";
import { confirmAction, createFocusTrap } from "../shared/dialog.js";
import { fmtBytes, fmtLeft } from "../shared/format.js";
import {
  focusFirstInvalid,
  formErrorHtml,
  showFormError,
  validateForm,
  wireBlurValidation
} from "../shared/form.js";
import { icon } from "../shared/icons.js";
import { actionBar, materialBlock, telemetryTempRows } from "./printerParts.js";
import { camBlock } from "./printers.js";
import { createLaunchController } from "../features/launch/controller.js";
import { createTaskController } from "../features/task/controller.js";
import {
  isBusy,
  jobLine,
  lightPolicyLine,
  normalizeProgress,
  progressBarHtml,
  progressPercentText
} from "./printerView.js";

let deps = { getState: () => null, refresh: async () => {} };
let root = null; // .modal-backdrop
let current = null; // { kind, printerId?, lastJson? }
/* Ловушка фокуса открытого окна: Tab не уходит за скрым, Esc закрывает,
   а фокус возвращается на кнопку, которой окно открыли. */
let trap = null;

export function initModals(injected) {
  deps = injected;
  ensureRoot();
}

function ensureRoot() {
  if (root) return root;
  root = document.createElement("div");
  root.className = "modal-backdrop";
  root.hidden = true;
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
      <button type="button" class="modal-x" data-modal-close aria-label="Закрыть окно">${icon("cross", { cls: "ico-md" })}</button>
      <div class="modal-content" id="modal-content"></div>
    </div>`;
  document.body.appendChild(root);

  // Клик по фону (но не по самому окну) закрывает.
  root.addEventListener("click", (e) => {
    if (e.target === root || e.target.closest("[data-modal-close]")) closeModal();
  });

  // Окно запуска печати: собственные делегированные клики и change-события.
  // Обрабатываются ПЕРВЫМИ и по своему kind, чтобы разметка запуска не пересекалась
  // с обработчиками файлового браузера.
  root.addEventListener("click", (e) => {
    if (current?.kind === "task") {
      taskController().handleClick(e);
      return;
    }
    if (!current || current.kind !== "launch") return;
    launchController().handleClick(e);
  });
  root.addEventListener("change", (e) => {
    if (!current || current.kind !== "launch") return;
    launchController().handleChange(e);
  });
  // Причина override набирается посимвольно: `change` придёт только по потере
  // фокуса, а кнопка «Запустить» должна оживать по мере набора.
  root.addEventListener("input", (e) => {
    if (!current || current.kind !== "launch") return;
    launchController().handleInput(e);
  });

  // Навигация файлового браузера — делегированно, разметка перерисовывается.
  root.addEventListener("click", (e) => {
    if (!current || current.kind !== "files") return;
    const back = e.target.closest("[data-files-back]");
    if (back) { openPrinterModal(current.printerId); return; }
    const nav = e.target.closest("[data-files-nav]");
    if (nav && !nav.disabled) { openFilesModal(current.printerId, nav.dataset.filesNav || ""); return; }
    const printBtn = e.target.closest("[data-files-print]");
    if (printBtn && !printBtn.disabled) startFileFromBrowser(current.printerId, printBtn.dataset.filesPrint, printBtn);
  });
  return root;
}

function openShell() {
  ensureRoot();
  const alreadyOpen = !root.hidden;
  root.hidden = false;
  document.documentElement.classList.add("modal-open");
  // Ловушка ставится один раз на сессию окна: переходы «принтер → файлы →
  // принтер» происходят внутри того же слоя и не должны терять точку возврата.
  if (!alreadyOpen) {
    trap = createFocusTrap(root, { onEscape: closeModal });
  }
}

/**
 * Перевести фокус в свежесобранное содержимое окна.
 *
 * Строго синхронно. Через requestAnimationFrame это делать нельзя: в фоновой
 * (невидимой) вкладке кадры не планируются вовсе, и окно открывалось БЕЗ
 * фокуса — клавиатурный пользователь оставался снаружи, а отложенный кадр,
 * сработав позже, ещё и перехватывал фокус у поля с ошибкой. Разметка к этому
 * моменту уже в DOM, поэтому ждать кадра незачем.
 */
function focusModal() {
  if (!trap) return;
  trap.focusFirst();
}

export function closeModal() {
  if (!root || root.hidden) return;
  root.hidden = true;
  current = null;
  document.documentElement.classList.remove("modal-open");
  $("#modal-content").innerHTML = "";
  // Сессия запуска (и её ключ идемпотентности) живёт ровно столько же, сколько
  // окно: закрыли — следующая попытка начинается заново.
  launchRef?.reset();
  taskRef?.reset();
  // Снять живой плеер камеры из закрытого окна (крепления больше нет в DOM).
  reconcileCameras();
  // Освобождение возвращает фокус на элемент, которым окно открыли.
  trap?.release();
  trap = null;
}

/* ── Запуск печати ─────────────────────────────────────────────
   Контроллер создаётся лениво и один раз: ему нужны deps (refresh), которые
   приходят в initModals позже, чем строится модальный корень. */

let launchRef = null;

function launchController() {
  if (!launchRef) {
    launchRef = createLaunchController({
      getContent: () => $("#modal-content"),
      refresh: () => deps.refresh(),
      close: closeModal
    });
  }
  return launchRef;
}

/** Открывает окно запуска для задания очереди. */
export function openLaunchModal(taskId) {
  current = { kind: "launch", taskId };
  openShell();
  launchController().open(taskId);
  focusModal();
}

/* ── Карточка задания ───────────────────────────────────────────
   Диагностическое окно: вся цепочка artifact → анализ → слайсинг → очередь →
   назначение → доставка → запуск → прогон, плюс журнал. Отвечает на вопрос
   «почему именно это задание сейчас не печатается», ответа на который до сих
   пор не было ни на одном экране целиком. */
let taskRef = null;

function taskController() {
  if (!taskRef) {
    taskRef = createTaskController({
      mount: (html) => {
        const box = $("#modal-content");
        if (box) box.innerHTML = html;
      },
      // Запуск живёт в своём окне; отсюда — только переход к нему.
      onLaunch: (taskId) => openLaunchModal(taskId)
    });
  }
  return taskRef;
}

export function openTaskModal(taskId) {
  current = { kind: "task", taskId };
  openShell();
  taskController().open(taskId);
  focusModal();
}

/* ── Детали принтера ───────────────────────────────────────── */

function findPrinter(id) {
  const state = deps.getState();
  return state?.printers?.find((p) => p.id === id) || null;
}

/** Запись политики подсветки (state.lights) для принтера; null у старого payload. */
function findLight(id) {
  const state = deps.getState();
  return state?.lights?.find((l) => l.id === id) || null;
}

/* Действия окна собирает та же модель, что и карточку (printerActionModel):
   расхождений между «что можно на карточке» и «что можно в окне» быть не может.
   Отдельная тихая строка объясняет ПРИНЦИПИАЛЬНО недоступное — вместо
   погашенной кнопки, которая не оживёт никогда. */
function modalActions(p) {
  const notes = [];
  if (!p.filesSupported) {
    // Не «только Moonraker»: Bambu Lab тоже умеет и передачу (FTPS), и запуск
    // (локальный MQTT). Без файлового API остался один протокол — Creality по
    // WebSocket, — и строка называет причину, а не список исключений, который
    // устареет со следующим адаптером.
    notes.push("Протокол этого принтера не даёт доступа к его файлам — запуск только с самого принтера.");
  }
  if (!p.snapshotAvailable && p.camera === "none") {
    notes.push("Камера этому принтеру не назначена — снимок делать нечем.");
  }
  return `
    ${actionBar(p, { context: "modal" })}
    ${notes.length ? `<p class="modal-note">${notes.map(esc).join(" ")}</p>` : ""}`;
}

function teleRows(p) {
  const rows = telemetryTempRows(p).map(([label, current, target]) => [
    label,
    `${current}°${target != null ? ` / ${target}°` : ""}`
  ]);
  if (p.nozzleType) {
    rows.push([
      "Тип сопла",
      p.nozzleTypeSource === "config" ? `${p.nozzleType} (из конфигурации)` : p.nozzleType,
    ]);
  }
  if (p.liveMaterialSource === "printer" && p.activeTray != null) {
    rows.push(["Активный лоток", `AMS ${p.activeTray + 1}`]);
  }
  rows.push(["Осталось", fmtLeft(p.minutesLeft)]);
  rows.push(["Прогресс", normalizeProgress(p.progress) != null ? progressPercentText(p.progress) : "не сообщается"]);
  return rows
    .map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join("");
}

function printerModalHtml(p, light) {
  const progress = isBusy(p)
    ? progressBarHtml(p.progress, { paused: p.status === "paused", style: "margin:10px 0" })
    : "";
  const lightLine = light ? `<div class="printer-light">${esc(lightPolicyLine(light))}</div>` : "";

  return `
    <div class="modal-head">
      <h2 id="modal-title">${esc(p.name)}<span class="type-chip ${p.type === "FDM" ? "type-fdm" : "type-resin"}">${esc(p.type)}</span></h2>
      ${badge(p.status)}
    </div>
    <div class="modal-printer">
      <div class="modal-cam">${camBlock(p, "modal")}</div>
      <div class="modal-side">
        <div class="modal-model">${esc(p.model || "модель не указана")}</div>
        <div class="modal-job">${jobLine(p)}</div>
        ${progress}
        ${materialBlock(p)}
        <div class="modal-tele">${teleRows(p)}</div>
        ${lightLine}
      </div>
    </div>
    ${modalActions(p)}`;
}

export function openPrinterModal(id) {
  const p = findPrinter(id);
  if (!p) {
    toast("Владыка, этот принтер ускользнул из моего поля зрения — в текущем состоянии фермы его нет", "toast-danger");
    return;
  }
  const light = findLight(id);
  current = { kind: "printer", printerId: id, lastJson: JSON.stringify([p, light]) };
  openShell();
  $("#modal-content").innerHTML = printerModalHtml(p, light);
  reconcileCameras();
  focusModal();
}

/** Держит открытое окно принтера в согласии со свежим состоянием фермы. */
export function syncModals() {
  if (!current || current.kind !== "printer" || root.hidden) return;
  // Пока оператор держит открытым меню «⋯» внутри окна, пересобирать его
  // содержимое нельзя: меню исчезло бы из-под курсора на очередном тике.
  if (root.querySelector("[data-menu-host][data-open]")) return;
  const p = findPrinter(current.printerId);
  if (!p) {
    // Принтер пропал из конфигурации — окно больше нечем наполнять.
    closeModal();
    return;
  }
  const light = findLight(current.printerId);
  const json = JSON.stringify([p, light]);
  if (json === current.lastJson) return; // ничего не изменилось — не трогаем камеру
  current.lastJson = json;
  $("#modal-content").innerHTML = printerModalHtml(p, light);
  reconcileCameras();
}

/* ── Файлы принтера (реальный GET /api/printers/:id/files) ────
   Живёт в том же модальном слое: кнопка «Файлы» в окне принтера открывает
   браузер каталога G-code, папки навигируются, printable-файл запускается
   через POST /api/printers/:id/print после подтверждения. */

function fmtFileMeta(e) {
  const parts = [];
  const bytes = fmtBytes(e.size, "");
  if (bytes) parts.push(bytes);
  const estSec = Number(e.metadata?.estimated_time);
  if (Number.isFinite(estSec) && estSec > 0) parts.push(`≈ ${fmtLeft(estSec / 60)}`);
  const material = e.metadata?.filament_type;
  if (material) parts.push(esc(String(material)));
  if (e.modifiedAt) {
    const d = new Date(e.modifiedAt);
    if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }));
  }
  return parts.join(" · ");
}

function filesCrumbsHtml(path) {
  const crumbs = [
    path
      ? `<button type="button" class="crumb" data-files-nav="">Корень</button>`
      : `<span class="crumb is-here">Корень</span>`
  ];
  let acc = "";
  const parts = path ? path.split("/") : [];
  parts.forEach((part, i) => {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push(`<span class="crumb-sep">/</span>`);
    crumbs.push(
      i === parts.length - 1
        ? `<span class="crumb is-here">${esc(part)}</span>`
        : `<button type="button" class="crumb" data-files-nav="${esc(acc)}">${esc(part)}</button>`
    );
  });
  return `<div class="files-crumbs">${crumbs.join("")}</div>`;
}

function filesShellHtml(p, path, bodyHtml) {
  return `
    <div class="modal-head">
      <h2 id="modal-title">Файлы — ${esc(p.name)}</h2>
      ${badge(p.status)}
    </div>
    ${filesCrumbsHtml(path)}
    ${bodyHtml}
    <div class="modal-actions">
      <button type="button" class="btn btn-sm" data-files-back>${icon("arrowLeft")}<span>К принтеру</span></button>
      <button type="button" class="btn btn-sm" data-modal-close>Закрыть</button>
    </div>`;
}

function filesListHtml(p, entries) {
  const busy = isBusy(p);
  const dead = p.status === "offline";
  const startBlocked = !p.remoteStartSupported || busy || dead;
  const blockedNote = !p.remoteStartSupported
    ? "Удалённый запуск этому принтеру не дозволен его протоколом — запустите файл на самом принтере, Владыка."
    : dead
      ? "Принтер безмолвствует — запуск сейчас невозможен."
      : busy
        ? "Принтер уже трудится — запуск станет возможен, едва он завершит начатое."
        : "";

  if (entries.length === 0) {
    return `<div class="files-note">Папка пуста</div>${blockedNote ? `<div class="files-note">${esc(blockedNote)}</div>` : ""}`;
  }

  const rows = entries.map((e) => {
    if (e.type === "directory") {
      return `
        <button type="button" class="file-row is-dir" data-files-nav="${esc(e.path)}">
          <span class="file-ico">${icon("folder")}</span>
          <span class="file-name">${esc(e.name)}</span>
          <span class="file-meta">папка</span>
        </button>`;
    }
    const disabled = startBlocked || !e.printable;
    // `printable` приходит с backend и уже посчитан ДЛЯ ЭТОГО принтера
    // (capabilitiesOf(printer).startableExtensions), поэтому подготовленный
    // Bambu-пакет `.gcode.3mf` здесь запускаемый, а для Moonraker — нет.
    // Собственного списка расширений у UI нет и быть не должно.
    const title = !e.printable
      ? "Этот файл нельзя запустить на этом принтере"
      : blockedNote || `Запустить «${e.name}» на печать`;
    return `
      <div class="file-row">
        <span class="file-ico ${e.printable ? "file-ico-go" : ""}">${icon(e.printable ? "filePrintable" : "file")}</span>
        <span class="file-name">${esc(e.name)}</span>
        <span class="file-meta">${fmtFileMeta(e)}</span>
        <button type="button" class="btn btn-sm btn-primary file-start" data-files-print="${esc(e.path)}"
          ${disabled ? "disabled" : ""} title="${esc(title)}">${icon("play")}<span>Печать</span></button>
      </div>`;
  });

  return `
    ${blockedNote ? `<div class="files-note">${esc(blockedNote)}</div>` : ""}
    <div class="files-list">${rows.join("")}</div>`;
}

/** Актуально ли ещё это окно браузера файлов (пользователь мог уйти). */
function isCurrentFiles(printerId, path) {
  return Boolean(current && current.kind === "files" && current.printerId === printerId && current.path === path);
}

export async function openFilesModal(printerId, path = "") {
  const p = findPrinter(printerId);
  if (!p) {
    toast("Владыка, этот принтер ускользнул из моего поля зрения — в текущем состоянии фермы его нет", "toast-danger");
    return;
  }
  if (!p.filesSupported) {
    openInfoModal("files-unsupported");
    return;
  }

  current = { kind: "files", printerId, path };
  openShell();
  // Скелет вместо строки «Загружаю…»: список встаёт на своё место без прыжка.
  const skeleton = `<div class="files-list">${
    Array.from({ length: 5 }, () => `<div class="file-row is-skeleton" aria-hidden="true"><span class="sk sk-dot"></span><span class="sk sk-line grow"></span></div>`).join("")
  }</div><p class="files-note" role="status">Загружаю список файлов…</p>`;
  $("#modal-content").innerHTML = filesShellHtml(p, path, skeleton);
  // Файловое окно без камеры: снять живой плеер, если он был в окне принтера.
  reconcileCameras();
  focusModal();

  try {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    const res = await apiGet(`/api/printers/${encodeURIComponent(printerId)}/files${query}`);
    if (!isCurrentFiles(printerId, path)) return; // окно уже сменилось
    $("#modal-content").innerHTML = filesShellHtml(p, res.path ?? path, filesListHtml(p, res.entries || []));
  } catch (err) {
    if (!isCurrentFiles(printerId, path)) return;
    $("#modal-content").innerHTML = filesShellHtml(
      p,
      path,
      `<div class="files-note files-error">Простите, Владыка — список файлов мне не покорился: ${esc(err.message || "причина неизвестна")}</div>`
    );
  }
}

async function startFileFromBrowser(printerId, filePath, btn) {
  const p = findPrinter(printerId);
  if (!p || !filePath) return;

  // Подтверждение обязательно: запуск занимает принтер, греет стол и сопло и
  // расходует материал. Своё окно вместо window.confirm — оно называет и файл,
  // и машину, и последствия, а не спрашивает безымянное «OK / Cancel».
  const ok = await confirmAction({
    title: "Запустить печать файла",
    object: `${filePath} — на «${p.name}»`,
    body: "Принтер начнёт греться немедленно и приступит к печати этого файла.",
    points: [
      "Панель не проверяла этот файл — она не знает ни его длительности, ни материала",
      "Убедитесь, что стол чист и свободен",
      "Машина будет занята до конца печати или до отмены"
    ],
    cta: "Запустить печать",
    tone: "warn"
  });
  if (!ok) return;

  const restore = setBusy(btn, "Запускаю…");
  try {
    await apiPost(`/api/printers/${encodeURIComponent(printerId)}/print`, { file: filePath });
    toast(`«${esc(p.name)}»: печать «${esc(filePath)}» начата по вашему велению`, "toast-ok");
    await deps.refresh();
    // Возвращаемся к деталям принтера — там прогресс и камера.
    openPrinterModal(printerId);
  } catch (err) {
    toast(`Простите, Владыка — печать не началась: ${esc(err.message || "причина неизвестна")}`, "toast-danger");
    restore();
  }
}

/* ── Форма нового задания: удалена ─────────────────────────────

   Здесь жила форма «Новое задание печати»: имя, принтер и ТЕКСТОВОЕ имя файла,
   уже лежащего на принтере (POST /api/queue). Она создавала второй жизненный
   цикл задания — в обход загрузки, анализа, слайсинга, контрольной суммы и
   вообще всякой связи с артефактом. Такое задание нельзя было ни проверить, ни
   доставить, ни сверить с тем, что реально лежит на устройстве: система знала о
   нём только строку, которую напечатал человек.

   Единственный путь теперь один: «Добавить задание» → «Загрузить файл». Загрузка
   создаёт артефакт с хешем, анализ и черновик задания, а дальше — либо слайсинг
   (модель), либо «Поставить в очередь» (готовый G-code или нарезанный 3MF).

   Серверный POST /api/queue не удалён: он помечен deprecated и продолжает
   работать для внешних клиентов и как фикстура в тестах. Убран именно интерфейс,
   который приглашал им пользоваться. */

/* ── Справочные окна (честные объяснения там, где backend не даёт действия) ── */

const INFO = {
  "add-printer": {
    title: "Принятие принтера в Назарик",
    body: `
      <p>Новобранцы принимаются прямо здесь, Владыка — в разделе
      <b>«Оборудование фермы»</b>. Укажите протокол, адрес и учётные данные, и я
      приму принтера под надзор со следующего же опроса: ни правки файлов, ни
      пересборки, ни перезапуска.</p>
      <p>Там же меняется код доступа Bambu Lab после сброса на самом принтере —
      кнопка «проверить связь» подтвердит, что новый код принят.</p>`
  },
  "upload-file": {
    title: "Вручение файла печати",
    body: `
      <p>Перетащите файл в раздел <b>«Загрузка и анализ»</b>, Владыка — я приму STL,
      3MF, G-code и уже нарезанный <code>.gcode.3mf</code>. Каждый файл получает
      контрольную сумму, проходит анализ и обзаводится черновиком задания.</p>
      <p>Дальше карточка файла сама скажет, что делать: модель — <b>«Нарезать»</b>,
      готовый к печати файл — <b>«Поставить в очередь»</b>. Ни имени файла на
      принтере, ни ручного копирования от вас больше не требуется: доставку на
      устройство выполняет сервер в момент запуска, и он же проверяет, что долетело
      именно то, что проверялось.</p>
      <p>Принтеры без адаптера загрузки (Creality по WebSocket) честно помечаются
      как непригодные для удалённого запуска — такой файл запускают с экрана самого
      принтера.</p>`
  },
  /* Показывается, когда `filesSupported === false` — то есть ровно для Creality
     (WebSocket): в таблице возможностей адаптеров (`infra/printers/capabilities.ts`)
     только у него нет ни файлового API, ни удалённого старта. Текст перечислял
     здесь и Bambu Lab, что было верно ровно до появления FTPS-клиента и старта
     через локальный MQTT: с тех пор панель сама передаёт на A1 пакет
     `.gcode.3mf` и сама начинает печать, а справка продолжала отправлять
     оператора к экрану принтера. */
  "files-unsupported": {
    title: "Файлы принтера",
    body: `
      <p>Этот принтер не даёт мне доступа к своим файлам, Владыка: его протокол
      (Creality по WebSocket) умеет только сообщать состояние — ни списка файлов,
      ни передачи, ни удалённого запуска в нём нет.</p>
      <p>Такое задание запускают с экрана самого принтера или из фирменного
      приложения; в очереди панели оно всё равно ведётся и без присмотра не
      останется.</p>
      <p>Moonraker (Creality K2) и Bambu Lab доступны полностью: файл я передаю
      и запускаю сама, из окна запуска задания.</p>`
  },
  settings: {
    title: "Настройки",
    body: `
      <p>Облик зала (тьма / свет / авто по времени) переключается кнопкой в правом
      верхнем углу и запоминается в браузере.</p>
      <p>Параметры backend — интервал опроса принтеров, ночное окно, путь к файлу
      состояния, токен управления — задаются переменными окружения сервиса
      <b>print-orchestrator</b>. Текущее состояние сервиса, опроса и хранилища я
      честно показываю в разделе <b>«Системное состояние»</b>.</p>`
  }
};

export function openInfoModal(kind) {
  const info = INFO[kind];
  if (!info) return;
  current = { kind: "info" };
  openShell();
  $("#modal-content").innerHTML = `
    <div class="modal-head"><h2 id="modal-title">${esc(info.title)}</h2></div>
    <div class="modal-info">${info.body}</div>
    <div class="modal-actions">
      <button type="button" class="btn btn-primary" data-modal-close data-autofocus>Да будет так</button>
    </div>`;
  focusModal();
}
