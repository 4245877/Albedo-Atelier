/* ── Модальные окна: детали принтера, форма задания, справка ──
   Один слой поверх доски. Открывается по data-act (open / add-job / …),
   закрывается по фону, крестику или Esc. Детальное окно принтера живёт вместе
   с доской: syncModals() перерисовывает его при обновлении состояния, не разрывая
   живой поток камеры (реконсиляция плееров как на доске). */

import { API_BASE, apiGet, apiPost } from "../api.js";
import { reconcileCameras } from "../cameraPlayers.js";
import { $, badge, esc, fmtLeft, materialBlock, toast } from "../util.js";
import { camBlock } from "./printers.js";
import {
  actionAvailability,
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
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <button type="button" class="modal-x" data-modal-close aria-label="Закрыть">✕</button>
      <div class="modal-content" id="modal-content"></div>
    </div>`;
  document.body.appendChild(root);

  // Клик по фону (но не по самому окну) закрывает.
  root.addEventListener("click", (e) => {
    if (e.target === root || e.target.closest("[data-modal-close]")) closeModal();
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !root.hidden) closeModal();
  });
  return root;
}

function openShell() {
  ensureRoot();
  root.hidden = false;
  document.documentElement.classList.add("modal-open");
}

export function closeModal() {
  if (!root || root.hidden) return;
  root.hidden = true;
  current = null;
  document.documentElement.classList.remove("modal-open");
  $("#modal-content").innerHTML = "";
  // Снять живой плеер камеры из закрытого окна (крепления больше нет в DOM).
  reconcileCameras();
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

function modalActions(p) {
  const can = actionAvailability(p);
  const lightTitle = can.lightUnknown && can.lightSupported
    ? ' title="Состояние подсветки неизвестно — команда будет отправлена вручную"'
    : "";
  const filesTitle = p.filesSupported
    ? "Файлы на принтере"
    : "Просмотр файлов пока поддерживается только для Moonraker-принтеров";
  return `
    <div class="modal-actions">
      <button class="btn btn-sm" data-act="pause" data-id="${esc(p.id)}" ${can.canPause ? "" : "disabled"}>⏸ Пауза</button>
      <button class="btn btn-sm" data-act="resume" data-id="${esc(p.id)}" ${can.canResume ? "" : "disabled"}>▶ Продолжить</button>
      <button class="btn btn-sm btn-danger" data-act="cancel" data-id="${esc(p.id)}" ${can.canCancel ? "" : "disabled"}>✕ Отмена</button>
      <button class="btn btn-sm" data-act="light-on" data-id="${esc(p.id)}"${lightTitle} ${can.canLightOn ? "" : "disabled"}>☀ Подсветка</button>
      <button class="btn btn-sm" data-act="light-off" data-id="${esc(p.id)}"${lightTitle} ${can.canLightOff ? "" : "disabled"}>☾ Погасить</button>
      <button class="btn btn-sm" data-act="snapshot" data-id="${esc(p.id)}" ${can.canSnapshot ? "" : "disabled"}>◉ Снимок</button>
      <button class="btn btn-sm" data-act="files" data-id="${esc(p.id)}" ${can.canFiles ? "" : "disabled"} title="${esc(filesTitle)}">🗂 Файлы</button>
      ${p.interfaceUrl ? `<a class="btn btn-sm" href="${esc(p.interfaceUrl)}" target="_blank" rel="noopener">⧉ Интерфейс</a>` : ""}
      ${p.latestSnapshotUrl ? `<a class="btn btn-sm" href="${API_BASE}${esc(p.latestSnapshotUrl)}" target="_blank" rel="noopener">🖼 Последний снимок</a>` : ""}
    </div>`;
}

function teleRows(p) {
  const rows = [];
  if (p.nozzle) rows.push(["Сопло", `${p.nozzle[0]}°${p.nozzle[1] != null ? ` / ${p.nozzle[1]}°` : ""}`]);
  if (p.bed) rows.push(["Стол", `${p.bed[0]}°${p.bed[1] != null ? ` / ${p.bed[1]}°` : ""}`]);
  if (p.chamber != null) rows.push(["Камера", `${p.chamber}°`]);
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
}

/** Держит открытое окно принтера в согласии со свежим состоянием фермы. */
export function syncModals() {
  if (!current || current.kind !== "printer" || root.hidden) return;
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

function fmtBytes(size) {
  if (size == null || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} МБ`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function fmtFileMeta(e) {
  const parts = [];
  const bytes = fmtBytes(e.size);
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
      <button type="button" class="btn btn-sm" data-files-back>← К принтеру</button>
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
          <span class="file-ico">📁</span>
          <span class="file-name">${esc(e.name)}</span>
          <span class="file-meta">папка</span>
        </button>`;
    }
    const disabled = startBlocked || !e.printable;
    const title = !e.printable
      ? "Это не файл G-code — запускать его я не позволю"
      : blockedNote || `Запустить «${e.name}» на печать`;
    return `
      <div class="file-row">
        <span class="file-ico">${e.printable ? "⬢" : "📄"}</span>
        <span class="file-name">${esc(e.name)}</span>
        <span class="file-meta">${fmtFileMeta(e)}</span>
        <button type="button" class="btn btn-sm btn-primary file-start" data-files-print="${esc(e.path)}"
          ${disabled ? "disabled" : ""} title="${esc(title)}">▶ Печать</button>
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
  $("#modal-content").innerHTML = filesShellHtml(p, path, `<div class="files-note">Загружаю список файлов…</div>`);
  // Файловое окно без камеры: снять живой плеер, если он был в окне принтера.
  reconcileCameras();

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
  // Подтверждение обязательно: запуск занимает принтер и греет столы-сопла.
  if (!window.confirm(`Владыка, повелеваете начать печать «${filePath}» на «${p.name}»?`)) return;

  btn.disabled = true;
  try {
    await apiPost(`/api/printers/${encodeURIComponent(printerId)}/print`, { file: filePath });
    await deps.refresh();
    toast(`«${esc(p.name)}»: печать «${esc(filePath)}» начата по вашему велению ▶`, "toast-ok");
    // Возвращаемся к деталям принтера — там прогресс и камера.
    openPrinterModal(printerId);
  } catch (err) {
    toast(`Простите, Владыка — печать не началась: ${esc(err.message || "причина неизвестна")}`, "toast-danger");
    if (btn.isConnected) btn.disabled = false;
  }
}

/* ── Форма нового задания (реальный POST /api/queue) ────────── */

export function openJobForm() {
  const state = deps.getState();
  const printers = state?.printers || [];
  const options = printers
    .map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`)
    .join("");

  current = { kind: "job" };
  openShell();
  $("#modal-content").innerHTML = `
    <div class="modal-head"><h2 id="modal-title">Новое задание печати</h2></div>
    <form class="modal-form" id="job-form" novalidate>
      <label class="field">
        <span class="field-lbl">Название <b class="req">*</b></span>
        <input class="input" name="title" required maxlength="120" placeholder="например, Кубок Владыки" />
      </label>
      <label class="field">
        <span class="field-lbl">Принтер</span>
        <input class="input" name="printer" list="job-printers" placeholder="без принтера — уйдёт на проверку" />
        <datalist id="job-printers">${options}</datalist>
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-lbl">Материал</span>
          <input class="input" name="material" maxlength="60" placeholder="PLA, смола…" />
        </label>
        <label class="field">
          <span class="field-lbl">Оценка времени</span>
          <input class="input" name="eta" maxlength="40" placeholder="2ч 30м" />
        </label>
      </div>
      <label class="field">
        <span class="field-lbl">Файл на принтере</span>
        <input class="input" name="file" maxlength="160" placeholder="chalice.gcode — нужен для удалённого запуска" />
        <span class="field-hint">Имя .gcode, уже загруженного на принтер. Без него задание нельзя запустить удалённо.</span>
      </label>
      <label class="field field-check">
        <input type="checkbox" name="night" />
        <span>Пригодно для ночной печати</span>
      </label>
      <div class="modal-actions">
        <button type="button" class="btn btn-sm" data-modal-close>Отмена</button>
        <button type="submit" class="btn btn-sm btn-primary">Добавить в очередь</button>
      </div>
      <div class="form-error" id="job-error" hidden></div>
    </form>`;

  const form = $("#job-form");
  form.querySelector('input[name="title"]').focus();
  form.addEventListener("submit", onJobSubmit);
}

async function onJobSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const errBox = $("#job-error");
  errBox.hidden = true;

  const data = new FormData(form);
  const title = String(data.get("title") || "").trim();
  if (!title) {
    errBox.textContent = "Владыка, задание должно носить имя — укажите название";
    errBox.hidden = false;
    return;
  }

  const body = { title };
  for (const key of ["printer", "material", "eta", "file"]) {
    const value = String(data.get(key) || "").trim();
    if (value) body[key] = value;
  }
  if (data.get("night")) body.night = true;

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const res = await apiPost("/api/queue", body);
    await deps.refresh();
    closeModal();
    const label = res?.job?.title ? `«${esc(res.job.title)}»` : "Задание";
    toast(`${label} принято в очередь — я прослежу за ним лично, Владыка`, "toast-ok");
  } catch (err) {
    errBox.textContent = `Простите, Владыка — задание не принято: ${err.message || "причина неизвестна"}`;
    errBox.hidden = false;
    submitBtn.disabled = false;
  }
}

/* ── Справочные окна (честные объяснения там, где backend не даёт действия) ── */

const INFO = {
  "add-printer": {
    title: "Принятие принтера в Назарик",
    body: `
      <p>Владыка, новые принтеры принимаются через конфигурацию backend, а не из
      панели — так их настройки (протокол, адрес, ключи) остаются под строгим
      контролем и переживают любой перезапуск. Порядок превыше поспешности.</p>
      <p>Добавьте запись в <code>config/printers.json</code> сервиса
      <b>print-orchestrator</b> (или переменную <code>PRINTERS_CONFIG_JSON</code>) с полями
      <code>id</code>, <code>name</code>, <code>host</code>, <code>protocol</code>
      (<code>moonraker</code> · <code>bambu</code> · <code>creality</code>). После перезапуска
      сервиса я немедля приму новобранца под свой надзор.</p>`
  },
  "upload-file": {
    title: "Вручение файла печати",
    body: `
      <p>Удалённая доставка файлов на принтеры пока не подключена, Владыка — панель
      не хранит слайсы и не передаёт их на устройства. Я не стану обещать то, чего
      не могу исполнить безупречно.</p>
      <p>Положите нарезанный файл на принтер привычным путём (веб-интерфейс Moonraker/
      Bambu, SD-карта или USB), затем создайте задание кнопкой
      <b>«Добавить задание»</b> и укажите имя этого файла в поле
      <b>«Файл на принтере»</b> — тогда я смогу запустить его удалённо из очереди.</p>
      <p>Файлы, уже покоящиеся на Moonraker-принтере (Creality K2), доступны сразу:
      откройте принтер и нажмите <b>«🗂 Файлы»</b>.</p>`
  },
  "files-unsupported": {
    title: "Файлы принтера",
    body: `
      <p>Просмотр файлов и удалённый запуск пока подвластны мне лишь для
      Moonraker-принтеров, Владыка.</p>
      <p>Для Bambu Lab и Creality (WebSocket) запускайте печать с самого принтера
      или из фирменного приложения; задание я всё равно буду вести в очереди панели —
      ни одно не останется без присмотра.</p>`
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
      <button type="button" class="btn btn-sm btn-primary" data-modal-close>Да будет так</button>
    </div>`;
}
