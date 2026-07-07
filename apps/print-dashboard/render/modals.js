/* ── Модальные окна: детали принтера, форма задания, справка ──
   Один слой поверх доски. Открывается по data-act (open / add-job / …),
   закрывается по фону, крестику или Esc. Детальное окно принтера живёт вместе
   с доской: syncModals() перерисовывает его при обновлении состояния, не разрывая
   живой поток камеры (реконсиляция плееров как на доске). */

import { API_BASE, apiPost } from "../api.js";
import { reconcileCameras } from "../cameraPlayers.js";
import { $, badge, esc, fmtLeft, materialBlock, toast } from "../util.js";
import { camBlock } from "./printers.js";

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

function modalActions(p) {
  const busy = p.status === "printing" || p.status === "paused";
  const dead = p.status === "offline";
  const lightSupported = Boolean(p.lightSupported);
  const lightOnDisabled = !lightSupported || p.light === true || dead;
  const lightOffDisabled = !lightSupported || p.light === false || dead;
  // Доступность снимка определяет backend-флаг snapshotAvailable, а не догадки по
  // camera/cameraSrc — так обычные HTTP-камеры, Bambu и go2rtc с настроенным
  // snapshotUrl трактуются одинаково и честно.
  const snapDisabled = !p.snapshotAvailable || dead;
  return `
    <div class="modal-actions">
      <button class="btn btn-sm" data-act="pause" data-id="${esc(p.id)}" ${p.status !== "printing" ? "disabled" : ""}>⏸ Пауза</button>
      <button class="btn btn-sm" data-act="resume" data-id="${esc(p.id)}" ${p.status !== "paused" ? "disabled" : ""}>▶ Продолжить</button>
      <button class="btn btn-sm btn-danger" data-act="cancel" data-id="${esc(p.id)}" ${!busy ? "disabled" : ""}>✕ Отмена</button>
      <button class="btn btn-sm" data-act="light-on" data-id="${esc(p.id)}" ${lightOnDisabled ? "disabled" : ""}>☀ Подсветка</button>
      <button class="btn btn-sm" data-act="light-off" data-id="${esc(p.id)}" ${lightOffDisabled ? "disabled" : ""}>☾ Погасить</button>
      <button class="btn btn-sm" data-act="snapshot" data-id="${esc(p.id)}" ${snapDisabled ? "disabled" : ""}>◉ Снимок</button>
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
  rows.push(["Прогресс", p.progress != null ? `${Math.round(p.progress)}%` : "не сообщается"]);
  return rows
    .map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join("");
}

function printerModalHtml(p) {
  const busy = p.status === "printing" || p.status === "paused";
  const jobLine =
    busy && p.job ? `Печатает: <b>${esc(p.job)}</b>` :
    busy ? "Печатает — название задания не определено" :
    p.status === "error" ? `<b style="color:var(--danger-ink)">${esc(p.error || "Ошибка")}</b>` :
    p.status === "offline" ? esc(p.error ? `Нет связи: ${p.error}` : "Нет связи с принтером") :
    p.status === "unknown" ? esc(p.error || "Состояние неизвестно") :
    "Свободен — ожидает распоряжений";

  const progress = busy && p.progress != null
    ? `<div class="progress ${p.status === "paused" ? "is-paused" : ""}" style="margin:10px 0"><i style="transform:scaleX(${(p.progress / 100).toFixed(4)})"></i></div>`
    : "";

  return `
    <div class="modal-head">
      <h2 id="modal-title">${esc(p.name)}<span class="type-chip ${p.type === "FDM" ? "type-fdm" : "type-resin"}">${esc(p.type)}</span></h2>
      ${badge(p.status)}
    </div>
    <div class="modal-printer">
      <div class="modal-cam">${camBlock(p, "modal")}</div>
      <div class="modal-side">
        <div class="modal-model">${esc(p.model || "модель не указана")}</div>
        <div class="modal-job">${jobLine}</div>
        ${progress}
        ${materialBlock(p)}
        <div class="modal-tele">${teleRows(p)}</div>
      </div>
    </div>
    ${modalActions(p)}`;
}

export function openPrinterModal(id) {
  const p = findPrinter(id);
  if (!p) {
    toast("Принтер не найден в текущем состоянии фермы", "toast-danger");
    return;
  }
  current = { kind: "printer", printerId: id, lastJson: JSON.stringify(p) };
  openShell();
  $("#modal-content").innerHTML = printerModalHtml(p);
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
  const json = JSON.stringify(p);
  if (json === current.lastJson) return; // ничего не изменилось — не трогаем камеру
  current.lastJson = json;
  $("#modal-content").innerHTML = printerModalHtml(p);
  reconcileCameras();
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
    errBox.textContent = "Укажите название задания";
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
    toast(`${label} добавлено в очередь`, "toast-ok");
  } catch (err) {
    errBox.textContent = err.message || "Не удалось добавить задание";
    errBox.hidden = false;
    submitBtn.disabled = false;
  }
}

/* ── Справочные окна (честные объяснения там, где backend не даёт действия) ── */

const INFO = {
  "add-printer": {
    title: "Добавление принтера",
    body: `
      <p>Принтеры описываются в конфигурации backend, а не создаются из панели —
      так их настройки (протокол, адрес, ключи) остаются под контролем и переживают
      перезапуск.</p>
      <p>Добавьте запись в <code>config/printers.json</code> сервиса
      <b>print-orchestrator</b> (или переменную <code>PRINTERS_CONFIG_JSON</code>) с полями
      <code>id</code>, <code>name</code>, <code>host</code>, <code>protocol</code>
      (<code>moonraker</code> · <code>bambu</code> · <code>creality</code>). После перезапуска
      сервиса принтер появится в зале.</p>`
  },
  "upload-file": {
    title: "Загрузка файла печати",
    body: `
      <p>Удалённая загрузка файлов на принтеры пока не подключена — панель не хранит
      слайсы и не толкает их на устройства.</p>
      <p>Положите нарезанный файл на принтер привычным путём (веб-интерфейс Moonraker/
      Bambu, SD-карта или USB), затем создайте задание кнопкой
      <b>«Добавить задание»</b> и укажите имя этого файла в поле
      <b>«Файл на принтере»</b> — тогда его можно будет запустить удалённо из очереди.</p>`
  },
  settings: {
    title: "Настройки",
    body: `
      <p>Тема зала (тьма / свет / авто по времени) переключается кнопкой в правом
      верхнем углу и запоминается в браузере.</p>
      <p>Параметры backend — интервал опроса принтеров, ночное окно, путь к файлу
      состояния, токен управления — задаются переменными окружения сервиса
      <b>print-orchestrator</b>. Текущее состояние сервиса, опроса и хранилища видно
      в разделе <b>«Системное состояние»</b>.</p>`
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
      <button type="button" class="btn btn-sm btn-primary" data-modal-close>Понятно</button>
    </div>`;
}
