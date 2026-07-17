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

const state = { runtime: null, profiles: [], sets: [], variants: [], models: [], loaded: false };
let pollTimer = null;
let wired = false;

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
  try {
    const [runtime, profiles, sets, variants, artifacts] = await Promise.all([
      apiGet("/api/print/slicing/runtime").catch(() => null),
      apiGet("/api/print/slicing/profiles").catch(() => ({ profiles: [] })),
      apiGet("/api/print/slicing/profile-sets").catch(() => ({ sets: [] })),
      apiGet("/api/print/slicing/variants").catch(() => ({ variants: [] })),
      apiGet("/api/print/artifacts").catch(() => ({ artifacts: [] }))
    ]);
    state.runtime = runtime;
    state.profiles = profiles.profiles || [];
    state.sets = sets.sets || [];
    state.variants = variants.variants || [];
    state.models = (artifacts.artifacts || []).filter(
      (a) => a.analysis && a.analysis.verdict === "needs_preparation"
    );
    state.loaded = true;
    render();
    ensurePolling();
  } catch {
    const body = $("#slicing-body");
    if (body) body.innerHTML = `<div class="slice-loading">Backend недоступен — раздел появится при восстановлении связи.</div>`;
  }
}

function ensurePolling() {
  const busy = state.variants.some((v) => v.state === "pending" || v.state === "running");
  if (busy && pollTimer === null) {
    pollTimer = setInterval(() => void loadAll(), POLL_MS);
  } else if (!busy && pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* ── Отрисовка ──────────────────────────────────────────────── */

function render() {
  const body = $("#slicing-body");
  if (!body) return;
  body.innerHTML = [
    runtimeHtml(),
    profilesHtml(),
    setsHtml(),
    createSetHtml(),
    variantsHtml(),
    newSliceHtml()
  ].join("");
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

  const gaps = (r.coverage || []).filter((c) => !c.hasAnyProfile);
  const coverage = gaps.length
    ? `<div class="slice-block">⛔ Нет профиля принтера для: ${gaps.map((c) => esc(c.printerName)).join(", ")}</div>`
    : "";

  return `
    <div class="slice-panel slice-runtime">
      <div class="slice-panel-head">
        <b>Среда OrcaSlicer</b>
        ${badge}${net}
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
  const opt = (list) => list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.status)}</option>`).join("");
  const machines = state.profiles.filter((p) => p.type === "machine");
  const processes = state.profiles.filter((p) => p.type === "process");
  const filaments = state.profiles.filter((p) => p.type === "filament");
  const printers = [...new Set(state.models.map(() => null))]; // placeholder; printers via coverage
  const coverage = (state.runtime && state.runtime.coverage) || [];
  const printerOpts = coverage.map((c) => `<option value="${esc(c.printerId)}">${esc(c.printerName)}</option>`).join("");
  return `
    <form class="slice-panel slice-form" data-slice-form="create-set">
      <div class="slice-panel-head"><b>Новый набор</b></div>
      <div class="slice-grid">
        <label>Имя<input type="text" name="name" required placeholder="K2 · PETG · Balance" /></label>
        <label>Принтер профиля<select name="machine" required>${opt(machines)}</select></label>
        <label>Печать<select name="process" required>${opt(processes)}</select></label>
        <label>Филамент<select name="filament" required>${opt(filaments)}</select></label>
        <label>Целевой принтер<select name="printer">${printerOpts || `<option value="">—</option>`}</select></label>
      </div>
      <button type="submit" class="btn btn-primary btn-sm">Создать и проверить</button>
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
  return `
    <form class="slice-panel slice-form" data-slice-form="slice">
      <div class="slice-panel-head"><b>Запуск слайсинга</b></div>
      <div class="slice-grid">
        <label>Модель<select name="artifactId" required>${modelOpts}</select></label>
        <label>Набор профилей<select name="profileSetId" required>${setOpts}</select></label>
      </div>
      <button type="submit" class="btn btn-primary btn-sm">Нарезать</button>
    </form>`;
}

/* ── Действия (делегированные) ──────────────────────────────── */

function wireDelegates() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-slice-action]");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const id = btn.dataset.id;
    const action = btn.dataset.sliceAction;
    if (action === "import") void run(() => apiPost("/api/print/slicing/presets/import"), "Пресеты импортированы");
    else if (action === "approve") void run(() => apiPost(`/api/print/slicing/profile-sets/${id}/approve`), "Набор утверждён");
    else if (action === "rerun") void run(() => apiPost(`/api/print/slicing/variants/${id}/rerun`), "Слайсинг перезапущен");
  });

  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-slice-form]");
    if (!form) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (form.dataset.sliceForm === "create-set") {
      void run(() => apiPost("/api/print/slicing/profile-sets", data), "Набор создан");
    } else if (form.dataset.sliceForm === "slice") {
      void run(() => apiPost("/api/print/slicing/slice", data), "Слайсинг запущен");
    }
  });
}

async function run(fn, okMsg) {
  try {
    await fn();
    toast(okMsg, "toast-ok");
    await loadAll();
  } catch (err) {
    toast(esc(err.message || "Не удалось выполнить действие"), "toast-danger");
    await loadAll();
  }
}

/* ── Мелочи отрисовки ───────────────────────────────────────── */

function chip(label, cls, pulse = false) {
  return `<span class="upload-chip chip-${cls}"><i class="dot${pulse ? " dot-pulse" : ""}"></i>${esc(label)}</span>`;
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
