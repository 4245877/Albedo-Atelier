/* ── Запуск печати: разметка ────────────────────────────────────
   Чистый рендер: получает preview с backend (GET /api/print/launch/:taskId) и
   локальное состояние окна, возвращает HTML. Никаких запросов и никакой логики
   допуска — что можно запустить, решает backend, здесь это только показывается.

   Порядок блоков задан сценарием оператора, а не структурой данных: сначала ЧТО
   печатаем, потом ГДЕ и почему именно там, потом что нужно проверить руками, и
   только в конце — одна главная кнопка. Технические подробности (коды отказов,
   пути к файлам, состояния артефактов) живут в <details> внизу: они нужны при
   разборе полёта и мешают при обычном запуске. */

import { esc } from "../../util.js";

/* Состояния задачи → человеческая подпись и цвет. Совпадает с LaunchState на
   backend; неизвестное состояние показываем как есть, а не прячем.

   Цвет несёт класс badge-*, а не эмодзи: цветные кружки 🟢🟡🔴 отсутствуют в
   шрифтах без emoji-набора и выводятся квадратом-заглушкой прямо перед текстом
   статуса — ровно в том месте, где нужна ясность. Классы уже дают зелёный,
   жёлтый и красный и работают в обеих темах. */
const STATE_LABEL = {
  preparing: { text: "Готовится", cls: "badge-plain" },
  ready: { text: "Готово к печати", cls: "badge-idle" },
  needs_confirmation: { text: "Нужно подтверждение", cls: "badge-paused" },
  blocked: { text: "Не готово", cls: "badge-error" },
  running: { text: "Печатается", cls: "badge-printing" }
};

export function stateLabel(state) {
  return STATE_LABEL[state] || { text: state, cls: "badge-plain" };
}

/** «PETG · 0.4 мм» — только то, что действительно известно. */
export function specLine(preview) {
  const parts = [];
  if (preview.material) parts.push(preview.material);
  if (preview.nozzleMm != null) parts.push(`${preview.nozzleMm} мм`);
  return parts.join(" · ");
}

/** «≈ 1 ч 29 мин · ≈ 31 г» — пропускаем то, чего не измерили. */
export function costLine(preview) {
  const parts = [];
  if (preview.etaText) parts.push(preview.etaText);
  if (preview.filamentG != null) parts.push(`≈ ${Math.round(preview.filamentG)} г`);
  return parts.join(" · ");
}

function materialNote(preview) {
  if (!preview.material) return "";
  if (preview.materialSource === "external") {
    return `<span class="launch-note">внешняя катушка</span>`;
  }
  if (preview.materialSource === "ams") return `<span class="launch-note">AMS</span>`;
  return "";
}

/* ── Карточка принтера в ручном режиме ─────────────────────── */

function candidateCard(c, selectedId) {
  const selected = c.printerId === selectedId;
  const facts = [];
  facts.push(c.online ? "онлайн" : "не в сети");
  if (c.online) facts.push(c.status === "idle" ? "свободен" : c.status);
  if (c.printerNozzleMm != null) facts.push(`сопло ${c.printerNozzleMm} мм`);
  if (c.loadedMaterial) facts.push(c.loadedMaterial);

  // У непригодного принтера показываем ПРИЧИНУ, а не пустую карточку: оператор
  // должен понимать, почему вариант отпал, иначе выбор выглядит произволом.
  const why = c.eligible
    ? `<div class="launch-cand-why">${esc(c.reason)}</div>`
    : `<div class="launch-cand-why is-blocked">${c.problems
        .filter((p) => p.kind === "blocker")
        .map((p) => `<span>${esc(p.title)}</span>`)
        .join("")}</div>`;

  return `
    <label class="launch-cand ${selected ? "is-selected" : ""} ${c.eligible ? "" : "is-blocked"}">
      <input type="radio" name="launch-printer" value="${esc(c.printerId)}"
        ${selected ? "checked" : ""} ${c.eligible ? "" : "disabled"} data-launch-pick />
      <span class="launch-cand-body">
        <span class="launch-cand-head">
          <span class="launch-cand-name">${esc(c.printerName)}</span>
          <span class="badge ${c.eligible ? "badge-idle" : "badge-error"}">
            ${c.eligible ? "совместим" : "несовместим"}
          </span>
        </span>
        <span class="launch-cand-facts">${esc(facts.join(" · "))}</span>
        ${why}
      </span>
    </label>`;
}

/* ── Подтверждения оператора ───────────────────────────────── */

function confirmationsBlock(confirmations, confirmed) {
  if (!confirmations.length) return "";
  return `
    <div class="launch-confirms">
      ${confirmations
        .map(
          (c) => `
        <label class="launch-confirm">
          <input type="checkbox" value="${esc(c.code)}" ${confirmed.has(c.code) ? "checked" : ""} data-launch-confirm />
          <span>
            <span class="launch-confirm-lbl">${esc(c.label)}</span>
            <span class="launch-confirm-hint">${esc(c.detail)}</span>
          </span>
        </label>`
        )
        .join("")}
    </div>`;
}

/* ── Проблемы: подтверждаемое и просто информация ───────────── */

function problemsBlock(candidate) {
  if (!candidate) return "";
  // Блокеры уже сказаны крупно (кнопка выключена, причина в шапке) — здесь
  // только то, что оператору полезно знать, но что не мешает запуску.
  const infos = candidate.problems.filter((p) => p.kind === "info");
  if (!infos.length) return "";
  return `
    <ul class="launch-notes">
      ${infos.map((p) => `<li>${esc(p.title)}</li>`).join("")}
    </ul>`;
}

function diagnosticsBlock(preview, candidate) {
  const rows = [
    ["Задание", preview.taskId],
    ["Состояние", preview.state],
    ["Принтер", candidate ? candidate.printerId : "—"],
    ["Файл на устройстве", candidate ? candidate.deviceFile : "—"],
    ["Оценка", candidate ? String(candidate.score) : "—"]
  ];
  const breakdown = candidate?.scoreBreakdown?.length
    ? `<div class="launch-diag-list">${candidate.scoreBreakdown
        .map((s) => `<span>${esc(s.label)} <b>${s.points > 0 ? "+" : ""}${s.points}</b></span>`)
        .join("")}</div>`
    : "";
  const technical = candidate?.problems?.length
    ? `<div class="launch-diag-list">${candidate.problems
        .map((p) => `<span>${esc(p.technical)}</span>`)
        .join("")}</div>`
    : "";
  return `
    <details class="launch-diag">
      <summary>Технические подробности</summary>
      <div class="launch-diag-body">
        ${rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`).join("")}
        ${breakdown}
        ${technical}
      </div>
    </details>`;
}

/* ── Окно целиком ──────────────────────────────────────────── */

/**
 * @param preview ответ GET /api/print/launch/:taskId
 * @param ui  { mode, selectedPrinterId, confirmed:Set, busy, error, done }
 */
export function launchModalHtml(preview, ui) {
  const st = stateLabel(preview.state);
  const candidate =
    preview.candidates.find((c) => c.printerId === ui.selectedPrinterId) || null;
  const spec = specLine(preview);
  const cost = costLine(preview);

  if (ui.done) {
    return `
      <div class="modal-head"><h2 id="modal-title">Печать запущена</h2></div>
      <div class="launch-done">
        <div class="launch-done-mark">▶</div>
        <div class="launch-sum-title">${esc(preview.displayTitle)}</div>
        <div class="launch-sum-sub">${esc(ui.done.printerName)}</div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-sm btn-primary" data-modal-close>Закрыть</button>
      </div>`;
  }

  const confirmations = preview.confirmations || [];
  const allConfirmed = confirmations
    .filter((c) => c.required)
    .every((c) => ui.confirmed.has(c.code));
  const canLaunch = Boolean(candidate?.eligible) && allConfirmed && !ui.busy;

  const cta = candidate
    ? `Запустить на «${candidate.printerName}»`
    : "Запустить печать";

  return `
    <div class="modal-head"><h2 id="modal-title">Запуск печати</h2></div>

    <div class="launch-sum">
      <div class="launch-sum-title">${esc(preview.displayTitle)}</div>
      <div class="launch-sum-grid">
        ${candidate ? `<div class="kv"><span class="k">Принтер</span><span class="v">${esc(candidate.printerName)}</span></div>` : ""}
        ${spec ? `<div class="kv"><span class="k">Материал</span><span class="v">${esc(spec)} ${materialNote(preview)}</span></div>` : ""}
        ${cost ? `<div class="kv"><span class="k">Печать</span><span class="v">${esc(cost)}</span></div>` : ""}
      </div>
      <span class="badge ${st.cls}">${esc(st.text)}</span>
    </div>

    ${
      candidate && candidate.eligible && ui.mode === "auto"
        ? `<p class="launch-reason">${esc(candidate.reason)}</p>`
        : ""
    }

    ${
      !candidate
        ? `<p class="launch-reason is-blocked">Нет принтера, готового принять это задание.</p>`
        : !candidate.eligible
          ? `<p class="launch-reason is-blocked">${esc(
              candidate.problems.find((p) => p.kind === "blocker")?.action || candidate.reason
            )}</p>`
          : ""
    }

    ${confirmationsBlock(confirmations, ui.confirmed)}
    ${problemsBlock(candidate)}

    ${
      ui.mode === "manual"
        ? `<div class="launch-cands">
             <p class="sub-head">Выберите принтер</p>
             ${preview.candidates.map((c) => candidateCard(c, ui.selectedPrinterId)).join("")}
           </div>`
        : ""
    }

    ${ui.error ? `<div class="form-error">${esc(ui.error)}</div>` : ""}

    ${diagnosticsBlock(preview, candidate)}

    <div class="modal-actions launch-actions">
      <button type="button" class="btn btn-sm btn-ghost" data-launch-mode="${ui.mode === "auto" ? "manual" : "auto"}">
        ${ui.mode === "auto" ? "Выбрать принтер вручную" : "← Автоматический выбор"}
      </button>
      <span class="grow"></span>
      <button type="button" class="btn btn-sm" data-modal-close ${ui.busy ? "disabled" : ""}>Отмена</button>
      <button type="button" class="btn btn-sm btn-primary" data-launch-go ${canLaunch ? "" : "disabled"}>
        ${ui.busy ? "Запускаю…" : esc(cta)}
      </button>
    </div>`;
}
