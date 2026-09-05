/* ── Карточка задания: разметка ─────────────────────────────────
   Чистый рендер. Получает detail с backend (GET /api/print/tasks/:id) и
   готовность (GET /api/print/launch/:taskId), возвращает HTML.

   Это единственное место, отвечающее на вопрос «почему именно ЭТО задание
   сейчас не печатается». Раньше ответ был размазан по четырём экранам:
   загрузка знала про файл и анализ, слайсинг — про варианты и подготовку,
   очередь — про состояние строки, карточка принтера — про прогон. Сопоставлять
   их приходилось по id вручную, и поэтому не сопоставлял никто: застрявшее
   задание обычно «расследовали» отменой.

   Порядок блоков — это порядок самой цепочки: файл → анализ → слайсинг →
   очередь → назначения → доставка → запуски → прогон → журнал. Читая сверху
   вниз, оператор видит, до какого звена дошло дело и где оно встало. */

import { esc } from "../../util.js";
import { chip } from "../../shared/chips.js";
import { fmtBytes, fmtDuration } from "../../shared/format.js";
import { icon } from "../../shared/icons.js";

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

const RUN_STATE = {
  PENDING: "команда отправлена",
  RUNNING: "печатается",
  PAUSED: "на паузе",
  SUCCEEDED: "завершено",
  FAILED: "сбой",
  CANCELLED: "отменено",
  UNKNOWN: "исход неизвестен"
};

const DEVICE_STATE = {
  NOT_PRESENT: "не передан",
  UPLOADING: "передаётся",
  PRESENT_UNVERIFIED: "лежит, но не проверен",
  VERIFIED: "проверен на принтере",
  STALE: "устарел",
  INVALID: "не прошёл проверку",
  FAILED: "передача не удалась"
};

const STATE_TONE = {
  QUEUED: "info",
  PLANNED: "info",
  ASSIGNED: "info",
  DISPATCHING: "info",
  PRINTING: "ok",
  COMPLETED: "ok",
  CANCELLED: "mute",
  FAILED: "error",
  NEEDS_REVIEW: "warn",
  DRAFT: "mute"
};

export function taskModalHtml(detail, readiness, { busy = false, error = null } = {}) {
  const t = detail.task;
  return `
    <div class="modal-head"><h2 id="modal-title">${esc(stripExtension(t.title))}</h2></div>

    <div class="task-head">
      ${chip(TASK_STATE[t.state] || t.state, STATE_TONE[t.state] || "info")}
      ${t.material ? chip(esc(t.material), "mute") : ""}
      ${t.pinnedPrinterId ? chip(`закреплено: ${esc(t.pinnedPrinterId)}`, "warn") : ""}
      <code class="task-id">${esc(t.id)}</code>
    </div>

    ${readinessHtml(readiness, busy)}
    ${error ? `<div class="form-error">${esc(error)}</div>` : ""}

    <ol class="task-chain">
      ${fileStep(detail)}
      ${analysisStep(detail)}
      ${sliceStep(detail)}
      ${queueStep(detail)}
      ${assignmentStep(detail)}
      ${deliveryStep(detail)}
      ${launchStep(detail)}
      ${runStep(detail)}
    </ol>

    ${operationsHtml(detail)}
    ${auditHtml(detail)}

    <div class="modal-actions">
      <button type="button" class="btn btn-sm" data-modal-close>Закрыть</button>
    </div>`;
}

/* Готовность к запуску — та же, что в очереди, из того же preflight. Стоит
   первой: это ответ на вопрос, ради которого окно и открывают. */
function readinessHtml(readiness, busy) {
  if (!readiness) return "";
  const tone =
    readiness.state === "ready" ? "ok" : readiness.state === "blocked" ? "blocked" : "warn";
  const action = readiness.canLaunch
    ? `<button type="button" class="btn btn-sm btn-primary" data-task-launch ${busy ? "disabled" : ""}>
         ${icon("play")}<span>Запустить</span>
       </button>`
    : "";
  return `
    <div class="task-readiness tone-${tone}">
      ${icon(tone === "ok" ? "check" : tone === "blocked" ? "blocked" : "warn")}
      <div class="grow">
        <div class="task-readiness-text">${esc(readiness.summary)}</div>
        ${
          readiness.primaryProblem
            ? `<div class="task-readiness-action">${esc(readiness.primaryProblem.action)}</div>`
            : ""
        }
      </div>
      ${action}
    </div>`;
}

/* ── Звенья цепочки ───────────────────────────────────────────
   Каждое звено рисуется всегда — даже когда до него ещё не дошло. Пропущенное
   звено сообщает не меньше пройденного: «доставки не было» — это и есть ответ
   на «почему не печатает». */

function step(name, state, rows, tone = "mute") {
  const body = rows.filter(Boolean).join("");
  return `
    <li class="task-step tone-${esc(tone)}">
      <div class="task-step-head">
        <span class="task-step-name">${esc(name)}</span>
        <span class="task-step-state">${esc(state)}</span>
      </div>
      ${body ? `<dl class="task-step-rows">${body}</dl>` : ""}
    </li>`;
}

function kv(key, value) {
  if (value === null || value === undefined || value === "") return "";
  return `<dt>${esc(key)}</dt><dd>${esc(String(value))}</dd>`;
}

function fileStep(d) {
  const a = d.artifact;
  const src = d.sourceArtifact;
  if (!a) return step("Файл", "нет файла", [], "error");
  return step(
    "Файл",
    a.name,
    [
      kv("Размер", fmtBytes(a.sizeBytes)),
      kv("Контрольная сумма", a.sha256 ? `${a.sha256.slice(0, 16)}…` : null),
      kv("Путь на устройстве", d.task.onDeviceFile),
      src ? kv("Исходная модель", src.name) : ""
    ],
    "ok"
  );
}

function analysisStep(d) {
  const latest = (d.analyses || [])[d.analyses.length - 1];
  if (!latest) return step("Анализ", "не выполнялся", [], "warn");
  const tone = latest.state === "ready" ? (latest.verdict === "schedulable" ? "ok" : "warn") : "error";
  return step(
    "Анализ",
    `${latest.state}${latest.verdict ? ` · ${latest.verdict}` : ""}`,
    [
      kv("Формат", latest.detectedFormat),
      kv("Материал", latest.material),
      kv("Сопло", latest.nozzleDiameterMm != null ? `${latest.nozzleDiameterMm} мм` : null),
      kv("Время печати", fmtDuration(latest.estimatedDurationS)),
      kv("Замечаний", (latest.warnings || []).length || null),
      kv("Блокеров", (latest.blockers || []).length || null)
    ],
    tone
  );
}

function sliceStep(d) {
  const variants = d.sliceVariants || [];
  if (!variants.length) {
    // Не ошибка: загруженный G-code печатается без слайсинга, и звено честно
    // говорит именно это, а не «слайсинга нет».
    return step("Слайсинг", "не требовался — файл уже исполнимый", [], "mute");
  }
  const last = variants[variants.length - 1];
  return step(
    "Слайсинг",
    last.state,
    [
      kv("Вариант", last.id),
      kv("Профили", last.profileSetId),
      kv("Принтер варианта", last.targetPrinterId || last.targetPrinterClass),
      kv("Оценка", fmtDuration(last.orcaEtaS)),
      kv("Ошибка", last.error)
    ],
    last.state === "ready" ? "ok" : last.state === "failed" || last.state === "blocked" ? "error" : "warn"
  );
}

function queueStep(d) {
  const e = d.queueEntry;
  if (!e) return step("Очередь", "задания нет в очереди", [], "warn");
  return step(
    "Очередь",
    e.state,
    [kv("Позиция", e.position), kv("Поставлено", fmtTime(e.enqueuedAt))],
    e.state === "WAITING" ? "ok" : "mute"
  );
}

function assignmentStep(d) {
  const list = d.assignments || [];
  if (!list.length) return step("Назначение", "принтер ещё не выбран", [], "mute");
  return `
    <li class="task-step tone-info">
      <div class="task-step-head">
        <span class="task-step-name">История назначений</span>
        <span class="task-step-state">${list.length}</span>
      </div>
      <ul class="task-list">
        ${list
          .map(
            (a) => `<li>
              <b>${esc(a.printerId)}</b> · ${esc(a.state)}${a.source ? ` · ${esc(a.source)}` : ""}
              ${a.invalidatedAt ? `<span class="task-strike">снято: ${esc(a.invalidatedReason || "устарело")}</span>` : ""}
              ${a.reason ? `<span class="task-sub">${esc(a.reason)}</span>` : ""}
            </li>`
          )
          .join("")}
      </ul>
    </li>`;
}

function deliveryStep(d) {
  const files = d.deviceArtifacts || [];
  if (!files.length) return step("Доставка файла", "файл на принтер не передавался", [], "mute");
  const last = files[files.length - 1];
  return step(
    "Доставка файла",
    DEVICE_STATE[last.state] || last.state,
    [
      kv("Принтер", last.printerId),
      kv("Путь", last.remotePath),
      kv("Размер на устройстве", fmtBytes(last.sizeBytes)),
      kv("Способ", last.transferMode),
      kv("Проверка", last.verification),
      kv("Подтвердил", last.confirmedBy),
      kv("Ошибка", last.lastError)
    ],
    last.state === "VERIFIED" ? "ok" : "warn"
  );
}

function launchStep(d) {
  const attempts = d.dispatchAttempts || [];
  if (!attempts.length) return step("Попытки запуска", "запуск не отправлялся", [], "mute");
  return `
    <li class="task-step tone-info">
      <div class="task-step-head">
        <span class="task-step-name">Попытки запуска</span>
        <span class="task-step-state">${attempts.length}</span>
      </div>
      <ul class="task-list">
        ${attempts
          .map(
            (a) => `<li>
              #${esc(a.attemptNo)} · <b>${esc(a.state)}</b> · ${esc(a.printerId)} · ${esc(fmtTime(a.requestedAt))}
              ${a.error ? `<span class="task-sub task-err">${esc(a.error)}</span>` : ""}
            </li>`
          )
          .join("")}
      </ul>
    </li>`;
}

function runStep(d) {
  const runs = d.printRuns || [];
  if (!runs.length) return step("Печать", "прогонов не было", [], "mute");
  const last = runs[runs.length - 1];
  const pct = last.progress != null ? `${Math.round(last.progress * 100)}%` : null;
  return step(
    "Печать",
    RUN_STATE[last.state] || last.state,
    [
      kv("Принтер", last.printerId),
      kv("Файл", last.file),
      kv("Начата", fmtTime(last.startedAt)),
      kv("Завершена", fmtTime(last.endedAt)),
      kv("Прогресс", pct),
      kv("Длительность", fmtDuration(last.durationS)),
      kv("Филамент", last.filamentUsedG != null ? `${last.filamentUsedG} г` : null)
    ],
    last.state === "RUNNING" || last.state === "SUCCEEDED"
      ? "ok"
      : last.state === "UNKNOWN" || last.state === "FAILED"
        ? "error"
        : "mute"
  );
}

function operationsHtml(d) {
  const ops = d.manualOperations || [];
  if (!ops.length) return "";
  return `
    <div class="task-ops">
      <p class="sub-head">Незакрытые работы на этих принтерах</p>
      <ul class="task-list">
        ${ops
          .map(
            (o) => `<li><b>${esc(o.type)}</b> · ${esc(o.state)} · ${esc(o.printerId)}
              ${o.blocking ? `<span class="task-sub task-err">держит принтер</span>` : ""}</li>`
          )
          .join("")}
      </ul>
    </div>`;
}

function auditHtml(d) {
  const events = [...(d.audit || [])].reverse().slice(0, 40);
  if (!events.length) return "";
  return `
    <details class="task-audit">
      <summary>Журнал (${events.length})</summary>
      <ul class="task-list">
        ${events
          .map(
            (e) => `<li>
              <span class="task-sub">${esc(fmtTime(e.at))}</span>
              <b>${esc(e.action)}</b>
              ${e.fromState || e.toState ? `<span class="task-sub">${esc(e.fromState || "—")} → ${esc(e.toState || "—")}</span>` : ""}
              ${e.actor ? `<span class="task-sub">${esc(e.actor)}</span>` : ""}
            </li>`
          )
          .join("")}
      </ul>
    </details>`;
}

function fmtTime(iso) {
  if (!iso) return null;
  return String(iso).slice(0, 16).replace("T", " ");
}

function stripExtension(title) {
  return String(title || "").replace(/\.(gcode\.3mf|3mf|stl|gcode|gco|g)$/i, "");
}
