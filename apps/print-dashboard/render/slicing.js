/* ═══════════════════════════════════════════════════════════════
   Раздел «Слайсинг и профили» — работа с пресетами OrcaSlicer и
   подготовка STL/3MF к печати через новую SQLite-модель (/api/print).
   Честно показывает: доступность OrcaSlicer runtime, статусы профилей
   (active/quarantined/invalid) с warnings/blockers, наборы профилей и
   их утверждение (утвердить набор с блокерами нельзя), запуск слайсинга
   и его результат (ETA OrcaSlicer, расход, габариты, выходной артефакт).
   Никаких фиктивных процентов и оценок: если runtime нет — виден blocker.
   ═══════════════════════════════════════════════════════════════ */

import { apiGet, apiPost } from "../api.js";
import { $, esc, toast } from "../util.js";

const POLL_MS = 4000;

const state = { runtime: null, profiles: [], sets: [], variants: [], models: [], loaded: false, errors: [] };
let pollTimer = null;
let wired = false;
/* Клиентский in-flight lock: пока идёт мутирующий POST, повторные клики/сабмиты
   игнорируются — двойная отправка не плодит дубли слайсов/наборов. */
let busy = false;

const TYPE_LABEL = { machine: "Принтер", process: "Печать", filament: "Филамент" };
const STATUS = {
  active: { label: "активен", cls: "ok" },
  quarantined: { label: "карантин", cls: "warn" },
  invalid: { label: "невалиден", cls: "error" }
};
const VALIDATION = {
  valid: { label: "совместим", cls: "ok" },
  warnings: { label: "с предупреждениями", cls: "warn" },
  blocked: { label: "есть блокеры", cls: "error" }
};
const VARIANT_STATE = {
  pending: { label: "в очереди", cls: "info", pulse: true },
  running: { label: "слайсинг…", cls: "info", pulse: true },
  ready: { label: "готово", cls: "ok" },
  failed: { label: "ошибка", cls: "error" },
  blocked: { label: "заблокировано", cls: "error" }
};

export function setupSlicing() {
  const body = $("#slicing-body");
  if (!body) return;
  body.innerHTML = `<div class="slice-loading">Загрузка профилей…</div>`;
  if (!wired) {
    wireDelegates();
    wired = true;
  }
  void loadAll();
}

async function loadAll() {
  // allSettled, а не Promise.all с per-request .catch(() => пусто): падение одного
  // ресурса не должно выглядеть как «нет профилей / загрузите STL». Успешные
  // ресурсы обновляют state, упавшие — сохраняют последнее корректное значение и
  // попадают в state.errors (баннер + автоповтор через ensurePolling).
  const results = await Promise.allSettled([
    apiGet("/api/print/slicing/runtime"),
    apiGet("/api/print/slicing/profiles"),
    apiGet("/api/print/slicing/profile-sets"),
    apiGet("/api/print/slicing/variants"),
    apiGet("/api/print/artifacts")
  ]);
  const [runtime, profiles, sets, variants, artifacts] = results;
  const errors = [];

  if (runtime.status === "fulfilled") state.runtime = runtime.value;
  else errors.push("среда OrcaSlicer");
  if (profiles.status === "fulfilled") state.profiles = profiles.value.profiles || [];
  else errors.push("профили");
  if (sets.status === "fulfilled") state.sets = sets.value.sets || [];
  else errors.push("наборы");
  if (variants.status === "fulfilled") state.variants = variants.value.variants || [];
  else errors.push("варианты слайсинга");
  if (artifacts.status === "fulfilled") {
    state.models = (artifacts.value.artifacts || []).filter(
      (a) => a.analysis && a.analysis.verdict === "needs_preparation"
    );
  } else errors.push("модели");

  state.errors = errors;

  // Данных ещё не было и всё упало — полноэкранная ошибка с кнопкой повтора.
  // Иначе рисуем то, что есть (плюс баннер об упавших ресурсах).
  if (!state.loaded && results.every((r) => r.status === "rejected")) {
    renderConnectionError();
  } else {
    state.loaded = true;
    render();
  }
  ensurePolling();
}

function renderConnectionError() {
  const body = $("#slicing-body");
  if (!body) return;
  body.innerHTML = `<div class="slice-loading">Backend недоступен — не удалось загрузить раздел.
    <button type="button" class="btn btn-sm" data-slice-action="reload">↻ Повторить</button></div>`;
}

function ensurePolling() {
  const busyVariants = state.variants.some((v) => v.state === "pending" || v.state === "running");
  // Опрашиваем и при ошибках загрузки — чтобы данные восстановились сами,
  // не дожидаясь действия оператора.
  const shouldPoll = busyVariants || state.errors.length > 0;
  if (shouldPoll && pollTimer === null) {
    pollTimer = setInterval(() => void loadAll(), POLL_MS);
  } else if (!shouldPoll && pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* ── Отрисовка ──────────────────────────────────────────────── */

function render() {
  const body = $("#slicing-body");
  if (!body) return;
  body.innerHTML = [
    errorsHtml(),
    runtimeHtml(),
    profilesHtml(),
    setsHtml(),
    createSetHtml(),
    variantsHtml(),
    newSliceHtml()
  ].join("");
}

function errorsHtml() {
  if (!state.errors.length) return "";
  return `
    <div class="slice-panel slice-errbox">
      <div class="slice-block">⛔ Не удалось загрузить: ${state.errors.map((e) => esc(e)).join(", ")}.
        Показаны последние известные данные; повтор — автоматически.</div>
      <button type="button" class="btn btn-sm" data-slice-action="reload">↻ Обновить сейчас</button>
    </div>`;
}

function runtimeHtml() {
  const r = state.runtime;
  if (!r) return "";
  const rt = r.runtime || {};
  const ok = rt.available;
  const badge = ok
    ? chip(`OrcaSlicer ${esc(rt.detectedVersion || "")} готов`, "ok")
    : chip("OrcaSlicer недоступен", "error");
  const net = rt.networkIsolated ? `<span class="slice-tag">сеть отключена</span>` : "";
  const err = !ok && rt.error ? `<div class="slice-block">⛔ ${esc(rt.error)}</div>` : "";
  const counts = r.profileCounts || {};
  const countRow = `
    <div class="slice-counts">
      ${chip(`активных: ${counts.active ?? 0}`, "ok")}
      ${chip(`карантин: ${counts.quarantined ?? 0}`, "warn")}
      ${chip(`невалидных: ${counts.invalid ?? 0}`, counts.invalid ? "error" : "info")}
    </div>`;

  const missing = (r.missingParents || []).length
    ? `<details class="slice-details"><summary>Отсутствуют системные профили-родители (${r.missingParents.length}) — положите их в vendor/</summary>
         <ul class="slice-findings">${r.missingParents.map((p) => `<li class="slice-warn">⚠ ${esc(p)}</li>`).join("")}</ul>
       </details>`
    : "";

  // Покрытие в трёх состояниях: нет профиля вовсе (блокер) ≠ есть только
  // неактивные — карантин/невалидные (предупреждение: активного покрытия нет) ≠
  // активен. Проверять только hasAnyProfile нельзя: принтер с единственным
  // карантинным профилем выглядел бы «покрытым», хотя набор для него не утвердить.
  const missingCov = (r.coverage || []).filter((c) => !c.hasAnyProfile);
  const inactiveCov = (r.coverage || []).filter((c) => c.hasAnyProfile && !c.hasActiveProfile);
  const coverage = [
    missingCov.length
      ? `<div class="slice-block">⛔ Нет профиля принтера для: ${missingCov.map((c) => esc(c.printerName)).join(", ")}</div>`
      : "",
    inactiveCov.length
      ? `<div class="slice-warnbox">⚠ Только неактивные профили (карантин/невалидные), активного покрытия нет: ${inactiveCov.map((c) => esc(c.printerName)).join(", ")}</div>`
      : ""
  ].join("");

  return `
    <div class="slice-panel slice-runtime">
      <div class="slice-panel-head">
        <b>Среда OrcaSlicer</b>
        ${badge}${net}
        <span class="slice-spacer"></span>
        <button type="button" class="btn btn-sm" data-slice-action="reload">↻ Обновить</button>
        <button type="button" class="btn btn-sm" data-slice-action="import">↻ Импорт пресетов</button>
      </div>
      ${countRow}
      ${err}
      ${coverage}
      ${missing}
    </div>`;
}

function profilesHtml() {
  const groups = ["machine", "process", "filament"];
  const cols = groups
    .map((type) => {
      const rows = state.profiles.filter((p) => p.type === type);
      return `
        <div class="slice-col">
          <div class="slice-col-head">${TYPE_LABEL[type]} <span class="slice-count">${rows.length}</span></div>
          <ul class="slice-list">
            ${rows.map(profileRow).join("") || `<li class="slice-empty">нет профилей</li>`}
          </ul>
        </div>`;
    })
    .join("");
  return `
    <div class="slice-panel">
      <div class="slice-panel-head"><b>Профили</b><span class="slice-hint">immutable-ревизии; в наборе используются только active</span></div>
      <div class="slice-cols">${cols}</div>
    </div>`;
}

function profileRow(p) {
  const st = STATUS[p.status] || { label: p.status, cls: "info" };
  const findings = [...(p.blockers || []), ...(p.warnings || [])];
  const detail = findings.length
    ? `<ul class="slice-findings">
         ${(p.blockers || []).map((b) => `<li class="slice-block-li">⛔ ${esc(b.message)}</li>`).join("")}
         ${(p.warnings || []).map((w) => `<li class="slice-warn">⚠ ${esc(w.message)}</li>`).join("")}
       </ul>`
    : "";
  return `
    <li class="slice-item" title="${esc(p.logicalId)}">
      <div class="slice-item-head">
        <span class="slice-name">${esc(p.name)}</span>
        ${chip(st.label, st.cls)}
      </div>
      ${detail}
    </li>`;
}

function setsHtml() {
  if (!state.sets.length) {
    return `<div class="slice-panel"><div class="slice-panel-head"><b>Наборы профилей</b></div>
      <div class="slice-empty">Пока нет наборов. Создайте набор ниже.</div></div>`;
  }
  const rows = state.sets.map(setRow).join("");
  return `<div class="slice-panel"><div class="slice-panel-head"><b>Наборы профилей</b></div>
    <ul class="slice-list">${rows}</ul></div>`;
}

function setRow(s) {
  const v = VALIDATION[s.validation] || { label: s.validation, cls: "info" };
  const approved = s.approved
    ? chip("утверждён", "ok")
    : `<button type="button" class="btn btn-sm" data-slice-action="approve" data-id="${esc(s.id)}"${s.validation === "blocked" ? " disabled title=\"есть блокеры\"" : ""}>Утвердить</button>`;
  const blockers = (s.blockers || []).map((b) => `<li class="slice-block-li">⛔ ${esc(b.message)}</li>`).join("");
  const warnings = (s.warnings || []).map((w) => `<li class="slice-warn">⚠ ${esc(w.message)}</li>`).join("");
  const target = s.printerId ? `принтер ${esc(s.printerId)}` : s.printerClass ? `класс ${esc(s.printerClass)}` : "—";
  return `
    <li class="slice-item">
      <div class="slice-item-head">
        <span class="slice-name">${esc(s.name)}</span>
        ${chip(v.label, v.cls)} <span class="slice-tag">${target}</span>
        <span class="slice-spacer"></span>
        ${approved}
      </div>
      ${blockers || warnings ? `<ul class="slice-findings">${blockers}${warnings}</ul>` : ""}
    </li>`;
}

function createSetHtml() {
  // Набор утверждается только из active-профилей (иначе валидация даёт блокер).
  // Поэтому выбираемы лишь active; неактивные показаны, но disabled и с причиной —
  // чтобы не делать путь с заведомо неутверждаемым набором основным.
  const active = (list) => list.filter((p) => p.status === "active");
  const opts = (list) => {
    const on = active(list)
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
      .join("");
    const off = list
      .filter((p) => p.status !== "active")
      .map(
        (p) => `<option value="${esc(p.id)}" disabled>${esc(p.name)} · ${esc(statusLabel(p.status))} (недоступен)</option>`
      )
      .join("");
    return on + off;
  };

  const machines = state.profiles.filter((p) => p.type === "machine");
  const processes = state.profiles.filter((p) => p.type === "process");
  const filaments = state.profiles.filter((p) => p.type === "filament");
  const missingActive = [];
  if (!active(machines).length) missingActive.push("принтер");
  if (!active(processes).length) missingActive.push("печать");
  if (!active(filaments).length) missingActive.push("филамент");

  const coverage = (state.runtime && state.runtime.coverage) || [];
  const printerOpts = coverage
    .map(
      (c) =>
        `<option value="${esc(c.printerId)}">${esc(c.printerName)}${c.hasActiveProfile ? "" : " · нет активного профиля"}</option>`
    )
    .join("");

  const note = missingActive.length
    ? `<div class="slice-block">⛔ Нет активных профилей: ${missingActive.join(", ")}. Набор собирается только из active-профилей — импортируйте/почините пресеты.</div>`
    : `<div class="slice-hint">В набор попадают только active-профили; неактивные показаны, но недоступны для выбора.</div>`;
  const disabledAttr = missingActive.length ? " disabled" : "";

  return `
    <form class="slice-panel slice-form" data-slice-form="create-set">
      <div class="slice-panel-head"><b>Новый набор</b></div>
      <div class="slice-grid">
        <label>Имя<input type="text" name="name" required placeholder="K2 · PETG · Balance" /></label>
        <label>Принтер профиля<select name="machine" required>${opts(machines)}</select></label>
        <label>Печать<select name="process" required>${opts(processes)}</select></label>
        <label>Филамент<select name="filament" required>${opts(filaments)}</select></label>
        <label>Целевой принтер<select name="printer">${printerOpts || `<option value="">—</option>`}</select></label>
      </div>
      ${note}
      <button type="submit" class="btn btn-primary btn-sm"${disabledAttr}>Создать и проверить</button>
    </form>`;
}

function variantsHtml() {
  if (!state.variants.length) return "";
  const rows = state.variants.map(variantRow).join("");
  return `<div class="slice-panel"><div class="slice-panel-head"><b>Варианты слайсинга</b></div>
    <ul class="slice-list">${rows}</ul></div>`;
}

function variantRow(v) {
  const st = VARIANT_STATE[v.state] || { label: v.state, cls: "info" };
  const meta = [];
  if (v.orcaEtaS != null) meta.push(`ETA OrcaSlicer: ${fmtDuration(v.orcaEtaS)}`);
  if (v.filamentG != null) meta.push(`филамент: ${v.filamentG} г`);
  if (v.dimensions && v.dimensions.size) meta.push(`габариты: ${fmtSize(v.dimensions.size)}`);
  const metaRow = meta.length ? `<div class="slice-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>` : "";
  const out = v.outputArtifactId
    ? `<div class="slice-out">Выходной артефакт: <code>${esc(v.outputArtifactId)}</code></div>`
    : "";
  const blockers = (v.blockers || []).map((b) => `<li class="slice-block-li">⛔ ${esc(b.message)}</li>`).join("");
  const err = v.error && v.state === "failed" ? `<div class="slice-block">⛔ ${esc(v.error)}</div>` : "";
  const rerun =
    v.state === "failed" || v.state === "blocked"
      ? `<button type="button" class="btn btn-sm" data-slice-action="rerun" data-id="${esc(v.id)}">↻ Повторить</button>`
      : "";
  return `
    <li class="slice-item">
      <div class="slice-item-head">
        <span class="slice-name">${esc(shortId(v.id))}</span>
        ${chip(st.label, st.cls, st.pulse)}
        <span class="slice-spacer"></span>
        ${rerun}
      </div>
      ${metaRow}${out}${err}
      ${blockers ? `<ul class="slice-findings">${blockers}</ul>` : ""}
    </li>`;
}

function newSliceHtml() {
  const approvedSets = state.sets.filter((s) => s.approved);
  if (!state.models.length || !approvedSets.length) {
    const why = !state.models.length
      ? "загрузите STL/3MF (раздел «Загрузка»)"
      : "утвердите хотя бы один набор профилей";
    return `<div class="slice-panel"><div class="slice-panel-head"><b>Запуск слайсинга</b></div>
      <div class="slice-empty">Чтобы запустить: ${why}.</div></div>`;
  }
  const modelOpts = state.models
    .map((m) => `<option value="${esc(m.artifact.id)}">${esc(m.artifact.name)}</option>`)
    .join("");
  const setOpts = approvedSets.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");

  // Runtime заведомо недоступен — не даём запустить и не показываем ложный успех:
  // такой слайс воркер всё равно переведёт в blocked. Блокируем кнопку и объясняем,
  // как восстановить среду. (available === null/unknown не блокируем — решает сервер.)
  const runtimeDown = state.runtime?.runtime?.available === false;
  const runtimeMsg = state.runtime?.runtime?.error;
  const runtimeBlock = runtimeDown
    ? `<div class="slice-block">⛔ OrcaSlicer недоступен — запуск невозможен${runtimeMsg ? `: ${esc(runtimeMsg)}` : ""}.
         Восстановите среду (проверьте контейнер OrcaSlicer, затем ↻ Импорт пресетов) и повторите.</div>`
    : "";
  const disabledAttr = runtimeDown ? ' disabled title="OrcaSlicer недоступен"' : "";

  return `
    <form class="slice-panel slice-form" data-slice-form="slice">
      <div class="slice-panel-head"><b>Запуск слайсинга</b></div>
      <div class="slice-grid">
        <label>Модель<select name="artifactId" required>${modelOpts}</select></label>
        <label>Набор профилей<select name="profileSetId" required>${setOpts}</select></label>
      </div>
      ${runtimeBlock}
      <button type="submit" class="btn btn-primary btn-sm"${disabledAttr}>Нарезать</button>
    </form>`;
}

/* ── Действия (делегированные) ──────────────────────────────── */

function wireDelegates() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-slice-action]");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const action = btn.dataset.sliceAction;
    // Обновление — обычное чтение, вне in-flight lock.
    if (action === "reload") {
      void loadAll();
      return;
    }
    if (busy) return; // мутация уже выполняется — повторный клик игнорируем
    const id = btn.dataset.id;
    if (action === "import") void run(btn, () => apiPost("/api/print/slicing/presets/import"), "Пресеты импортированы");
    else if (action === "approve") void run(btn, () => apiPost(`/api/print/slicing/profile-sets/${id}/approve`), "Набор утверждён");
    else if (action === "rerun") void run(btn, () => apiPost(`/api/print/slicing/variants/${id}/rerun`), "Слайсинг перезапущен");
  });

  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-slice-form]");
    if (!form) return;
    e.preventDefault();
    if (busy) return;
    const kind = form.dataset.sliceForm;
    // Защита на случай, если кнопка не была disabled: без runtime не запускаем.
    if (kind === "slice" && state.runtime?.runtime?.available === false) {
      toast("OrcaSlicer недоступен — запуск невозможен. Восстановите среду и повторите.", "toast-danger");
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    const data = Object.fromEntries(new FormData(form).entries());
    if (kind === "create-set") {
      void run(submitBtn, () => apiPost("/api/print/slicing/profile-sets", data), "Набор создан");
    } else if (kind === "slice") {
      void run(submitBtn, () => apiPost("/api/print/slicing/slice", data), "Слайсинг запущен");
    }
  });

  // Модуль загрузки завершил анализ модели → подтягиваем свежий список, чтобы
  // загруженный STL сразу появился в «Запуске слайсинга» без перезагрузки страницы.
  document.addEventListener("artifact-analysis-completed", () => {
    if (state.loaded) void loadAll();
  });
}

async function run(btn, fn, okMsg) {
  busy = true;
  if (btn) btn.disabled = true; // мгновенная блокировка конкретной кнопки/формы
  try {
    await fn();
    toast(okMsg, "toast-ok");
  } catch (err) {
    toast(esc(err.message || "Не удалось выполнить действие"), "toast-danger");
  } finally {
    busy = false;
    await loadAll(); // перерисовка сбросит disabled на свежем DOM
  }
}

/* ── Мелочи отрисовки ───────────────────────────────────────── */

function chip(label, cls, pulse = false) {
  return `<span class="upload-chip chip-${cls}"><i class="dot${pulse ? " dot-pulse" : ""}"></i>${esc(label)}</span>`;
}

function statusLabel(status) {
  return (STATUS[status] || { label: status }).label;
}

function fmtDuration(s) {
  if (s == null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} ч ${m} м` : `${m} м`;
}

function fmtSize(size) {
  if (!Array.isArray(size)) return "—";
  return size.map((n) => Math.round(n * 10) / 10).join(" × ") + " мм";
}

function shortId(id) {
  return String(id).replace(/^slc_/, "").slice(0, 8);
}
