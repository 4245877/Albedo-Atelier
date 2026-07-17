/* ═══════════════════════════════════════════════════════════════
   Раздел «Планировщик печати» — ручная очередь и планирование через
   новую SQLite-модель (/api/print/scheduler). Честно показывает:
   очередь заданий с приоритетом/дедлайном/notBefore/предпочтением
   день-ночь и закреплением принтера; матрицу совместимости
   task × printer (совместимо / проверить / заблокировано) с причинами;
   черновик плана с таймлайном по принтерам, объяснением рекомендаций
   (почему принтер, альтернативы, из чего сложился score, warnings),
   подтверждение плана и пересчёт (новая ревизия-черновик); отдельный
   блок ночных кандидатов. Никаких команд запуска принтера здесь нет.
   ═══════════════════════════════════════════════════════════════ */

import { apiGet, apiPost } from "../api.js";
import { $, esc, toast } from "../util.js";

const POLL_MS = 8000;

const state = {
  queue: [],
  matrix: { printers: [], rows: [] },
  plans: [],
  plan: null,
  night: null,
  loaded: false
};
let pollTimer = null;
let wired = false;

const VERDICT = {
  compatible: { label: "совместимо", cls: "ok" },
  review: { label: "проверить", cls: "warn" },
  blocked: { label: "заблокировано", cls: "error" }
};
const DAYNIGHT = { any: "любое", day: "день", night: "ночь" };

export function setupScheduler() {
  const body = $("#scheduler-body");
  if (!body) return;
  body.innerHTML = `<div class="slice-loading">Загрузка планировщика…</div>`;
  if (!wired) {
    wireDelegates();
    wired = true;
  }
  void loadAll();
}

async function loadAll() {
  try {
    const [queue, matrix, plans, night] = await Promise.all([
      apiGet("/api/print/scheduler/queue").catch(() => ({ queue: [] })),
      apiGet("/api/print/scheduler/compatibility").catch(() => ({ printers: [], rows: [] })),
      apiGet("/api/print/scheduler/plans").catch(() => ({ plans: [] })),
      apiGet("/api/print/scheduler/night").catch(() => null)
    ]);
    state.queue = queue.queue || [];
    state.matrix = { printers: matrix.printers || [], rows: matrix.rows || [] };
    state.plans = plans.plans || [];
    state.night = night;

    // Latest plan (highest revision) — show its assignments + explanations.
    const latest = pickLatestPlan(state.plans);
    state.plan = latest ? await apiGet(`/api/print/scheduler/plans/${latest.id}`).catch(() => null) : null;

    state.loaded = true;
    render();
    ensurePolling();
  } catch {
    const body = $("#scheduler-body");
    if (body) body.innerHTML = `<div class="slice-loading">Backend недоступен — раздел появится при восстановлении связи.</div>`;
  }
}

function pickLatestPlan(plans) {
  if (!plans.length) return null;
  return [...plans].sort((a, b) => (b.revision - a.revision) || (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function ensurePolling() {
  if (pollTimer === null) pollTimer = setInterval(() => void loadAll(), POLL_MS);
}

/* ── Отрисовка ──────────────────────────────────────────────── */

function render() {
  const body = $("#scheduler-body");
  if (!body) return;
  body.innerHTML = [
    queueHtml(),
    addTaskHtml(),
    compatibilityHtml(),
    planHtml(),
    nightHtml()
  ].join("");
}

function queueHtml() {
  if (!state.queue.length) {
    return panel("Очередь заданий", `<div class="slice-empty">Очередь пуста. Добавьте задание ниже.</div>`);
  }
  const rows = state.queue.map((row, i) => queueRow(row, i)).join("");
  return panel("Очередь заданий", `<ul class="slice-list sch-queue">${rows}</ul>`,
    `<span class="slice-hint">порядок = приоритет планирования</span>`);
}

function queueRow(row, index) {
  const t = row.task;
  const entry = row.entry;
  const tags = [];
  if (t.priority) tags.push(chip(`приоритет ${t.priority}`, "info"));
  if (t.pinnedPrinterId) tags.push(chip(`🔒 ${esc(t.pinnedPrinterId)}`, "info"));
  if (t.dayNightPreference && t.dayNightPreference !== "any") tags.push(chip(DAYNIGHT[t.dayNightPreference] || t.dayNightPreference, "warn"));
  if (t.unattendedAllowed) tags.push(chip("без присмотра", "warn"));
  if (t.deadline) tags.push(chip(`дедлайн ${fmtDate(t.deadline)}`, "info"));
  if (t.notBefore) tags.push(chip(`не ранее ${fmtDate(t.notBefore)}`, "info"));

  const printerOpts = state.matrix.printers
    .map((p) => `<option value="${esc(p.id)}"${t.pinnedPrinterId === p.id ? " selected" : ""}>${esc(p.name)}</option>`)
    .join("");

  return `
    <li class="slice-item sch-row" data-task="${esc(t.id)}" data-version="${entry.version}">
      <div class="slice-item-head">
        <span class="sch-ord">${index + 1}</span>
        <span class="slice-name">${esc(t.title)}</span>
        ${t.material ? chip(esc(t.material), "info") : ""}
        <span class="slice-spacer"></span>
        <button type="button" class="btn btn-sm" data-sch-action="up" title="выше">↑</button>
        <button type="button" class="btn btn-sm" data-sch-action="down" title="ниже">↓</button>
        <button type="button" class="btn btn-sm" data-sch-action="toggle-edit">✎ параметры</button>
      </div>
      <div class="sch-tags">${tags.join("") || `<span class="slice-hint">без ограничений</span>`}</div>
      <form class="sch-edit" data-sch-form="params" hidden>
        <label>Приоритет<input type="number" name="priority" value="${t.priority}" /></label>
        <label>День/ночь<select name="dayNightPreference">
          ${["any", "day", "night"].map((v) => `<option value="${v}"${t.dayNightPreference === v ? " selected" : ""}>${DAYNIGHT[v]}</option>`).join("")}
        </select></label>
        <label>Не ранее<input type="datetime-local" name="notBefore" value="${isoToInput(t.notBefore)}" /></label>
        <label>Дедлайн<input type="datetime-local" name="deadline" value="${isoToInput(t.deadline)}" /></label>
        <label class="sch-check"><input type="checkbox" name="unattended"${t.unattendedAllowed ? " checked" : ""} /> без присмотра (ночь)</label>
        <label>Закрепить принтер<select name="pin"><option value="">— не закреплять —</option>${printerOpts}</select></label>
        <div class="sch-edit-actions">
          <button type="submit" class="btn btn-primary btn-sm">Сохранить</button>
          ${t.pinnedPrinterId ? `<button type="button" class="btn btn-sm" data-sch-action="unpin">Снять закрепление</button>` : ""}
        </div>
      </form>
    </li>`;
}

function addTaskHtml() {
  return `
    <form class="slice-panel slice-form" data-sch-form="add">
      <div class="slice-panel-head"><b>Добавить задание</b></div>
      <div class="slice-grid">
        <label>Название<input type="text" name="title" required placeholder="Кронштейн v2" /></label>
        <label>Материал<input type="text" name="material" placeholder="PETG" /></label>
        <label>Приоритет<input type="number" name="priority" value="0" /></label>
        <label>Дедлайн<input type="datetime-local" name="deadline" /></label>
      </div>
      <button type="submit" class="btn btn-primary btn-sm">Добавить в очередь</button>
    </form>`;
}

function compatibilityHtml() {
  const { printers, rows } = state.matrix;
  if (!printers.length) {
    return panel("Матрица совместимости", `<div class="slice-empty">Нет принтеров в конфигурации фермы.</div>`);
  }
  if (!rows.length) {
    return panel("Матрица совместимости", `<div class="slice-empty">Нет заданий для проверки.</div>`);
  }
  const head = `<tr><th>Задание</th>${printers.map((p) => `<th>${esc(p.name)}</th>`).join("")}</tr>`;
  const body = rows.map((r) => {
    const cells = printers.map((p) => {
      const res = r.results.find((x) => x.printerId === p.id);
      if (!res) return `<td>—</td>`;
      const v = VERDICT[res.verdict] || { label: res.verdict, cls: "info" };
      const reasons = [...res.blockers, ...res.reviews, ...res.warnings].map((x) => x.message).join(" · ");
      const eta = res.eta && res.eta.seconds != null ? ` ${fmtDuration(res.eta.seconds)}` : "";
      return `<td title="${esc(reasons)}">${chip(v.label + eta, v.cls)}</td>`;
    }).join("");
    return `<tr><td class="sch-cell-task">${esc(r.title)}</td>${cells}</tr>`;
  }).join("");
  return panel("Матрица совместимости",
    `<div class="sch-matrix-wrap"><table class="sch-matrix"><thead>${head}</thead><tbody>${body}</tbody></table></div>`,
    `<span class="slice-hint">неизвестное критичное значение → «проверить», не «совместимо»</span>`);
}

function planHtml() {
  const controls = `
    <button type="button" class="btn btn-primary btn-sm" data-sch-action="build-plan">Построить черновик</button>
    ${state.plan ? `<button type="button" class="btn btn-sm" data-sch-action="recompute" data-id="${esc(state.plan.plan.id)}">↻ Пересчитать</button>` : ""}
    ${state.plan && state.plan.plan.state === "DRAFT" ? `<button type="button" class="btn btn-ok btn-sm" data-sch-action="confirm" data-id="${esc(state.plan.plan.id)}">✓ Подтвердить</button>` : ""}`;

  if (!state.plan) {
    return panel("План печати", `<div class="slice-empty">Плана ещё нет. Постройте черновик из текущей очереди.</div>`, controls);
  }

  const plan = state.plan.plan;
  const stateChip = plan.state === "ACTIVE"
    ? chip(`подтверждён · ревизия ${plan.revision}`, "ok")
    : plan.state === "DRAFT"
      ? chip(`черновик · ревизия ${plan.revision}`, "warn")
      : chip(`${plan.state} · ревизия ${plan.revision}`, "info");
  const confirmed = plan.confirmedAt ? `<span class="slice-hint">подтверждён ${fmtDate(plan.confirmedAt)}</span>` : "";

  const byPrinter = groupByPrinter(state.plan.assignments);
  const timeline = state.matrix.printers.length
    ? state.matrix.printers.map((p) => timelineLane(p, byPrinter.get(p.id) || [])).join("")
    : [...byPrinter.keys()].map((id) => timelineLane({ id, name: id }, byPrinter.get(id))).join("");

  const unplaced = (state.plan.unplaced || []).length
    ? `<div class="sch-unplaced"><b>Не размещены:</b><ul class="slice-findings">
        ${state.plan.unplaced.map((u) => `<li class="slice-warn">⚠ ${esc(u.title)} — ${esc(u.reason)}</li>`).join("")}
       </ul></div>`
    : "";

  return panel(`План печати ${stateChip}`,
    `${confirmed}<div class="sch-lanes">${timeline || `<div class="slice-empty">Ни одно задание не размещено.</div>`}</div>${unplaced}`,
    controls);
}

function timelineLane(printer, assignments) {
  const cards = assignments.map(assignmentCard).join("") ||
    `<span class="slice-empty">свободен</span>`;
  return `
    <div class="sch-lane">
      <div class="sch-lane-head">${esc(printer.name)}</div>
      <div class="sch-lane-body">${cards}</div>
    </div>`;
}

function assignmentCard(view) {
  const ex = view.explanation || {};
  const task = view.task || {};
  const eta = ex.etaSeconds != null
    ? `${fmtDuration(ex.etaSeconds)}${ex.etaPreliminary ? " (предв.)" : ""} · ${etaSourceLabel(ex.etaSource)}`
    : "ETA неизвестна";
  const window = ex.startMs
    ? `${fmtTime(ex.startMs)}${ex.endMs ? "–" + fmtTime(ex.endMs) : ""}`
    : "";
  const score = Array.isArray(ex.scoreBreakdown) && ex.scoreBreakdown.length
    ? `<details class="slice-details"><summary>score ${ex.score ?? 0}</summary>
        <ul class="slice-findings">${ex.scoreBreakdown.map((c) => `<li>${esc(c.label)}: ${c.value > 0 ? "+" : ""}${c.value}</li>`).join("")}</ul>
       </details>`
    : "";
  const alts = Array.isArray(ex.alternatives) && ex.alternatives.length
    ? `<div class="slice-hint">альтернативы: ${ex.alternatives.map((a) => `${esc(a.printerId)} (${a.score})`).join(", ")}</div>`
    : "";
  const warns = Array.isArray(ex.warnings) && ex.warnings.length
    ? `<ul class="slice-findings">${ex.warnings.map((w) => `<li class="slice-warn">⚠ ${esc(w)}</li>`).join("")}</ul>`
    : "";
  return `
    <div class="sch-assign">
      <div class="sch-assign-head"><span class="slice-name">${esc(task.title || view.assignment.taskId)}</span>${window ? `<span class="slice-tag">${window}</span>` : ""}</div>
      <div class="sch-assign-meta">${esc(eta)}</div>
      <div class="slice-hint">${esc(ex.reason || "")}</div>
      ${score}${alts}${warns}
    </div>`;
}

function nightHtml() {
  const n = state.night;
  if (!n) return "";
  const buffer = `<span class="slice-hint">окно ${esc(n.window)} · буфер +${Math.round((n.safetyBufferRatio || 0) * 100)}% (предварительно, без исторического P90)</span>`;
  const candidates = (n.candidates || []).length
    ? `<ul class="slice-list">${n.candidates.map((c) => `
        <li class="slice-item">
          <div class="slice-item-head">
            <span class="slice-name">${esc(c.title)}</span>
            ${chip(`принтер ${esc(c.printerId)}`, "ok")}
            ${c.bufferedEtaSeconds != null ? chip(`≈ ${fmtDuration(c.bufferedEtaSeconds)}${c.preliminary ? " предв." : ""}`, "info") : ""}
          </div>
        </li>`).join("")}</ul>`
    : `<div class="slice-empty">Нет кандидатов на ночь: нужны готовый слайс, утверждённый набор, известная ETA, достаточно материала, свежая телеметрия, чистый стол, разрешение на печать без присмотра.</div>`;
  const rejected = (n.rejected || []).length
    ? `<details class="slice-details"><summary>Отклонённые кандидаты (${n.rejected.length})</summary>
        <ul class="slice-findings">${n.rejected.map((r) => `<li class="slice-warn">⚠ ${esc(r.title)} → ${esc(r.printerId)}: ${esc((r.reasons || []).join("; "))}</li>`).join("")}</ul>
       </details>`
    : "";
  return panel("Ночные кандидаты", `${candidates}${rejected}`, buffer);
}

/* ── Действия (делегированные) ──────────────────────────────── */

function wireDelegates() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sch-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.schAction;
    if (!action) return;
    e.preventDefault();
    const id = btn.dataset.id;
    const rowEl = btn.closest("[data-task]");
    const taskId = rowEl?.dataset.task;

    if (action === "toggle-edit") {
      const form = rowEl?.querySelector('[data-sch-form="params"]');
      if (form) form.hidden = !form.hidden;
    } else if (action === "up" || action === "down") {
      void moveTask(taskId, action);
    } else if (action === "unpin") {
      void run(() => apiPost(`/api/print/scheduler/tasks/${taskId}/unpin`), "Закрепление снято");
    } else if (action === "build-plan") {
      void run(() => apiPost("/api/print/scheduler/plans", {}), "Черновик плана построен");
    } else if (action === "recompute") {
      void run(() => apiPost(`/api/print/scheduler/plans/${id}/recompute`), "План пересчитан (новая ревизия)");
    } else if (action === "confirm") {
      void run(() => apiPost(`/api/print/scheduler/plans/${id}/confirm`), "План подтверждён");
    }
  });

  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-sch-form]");
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.schForm;
    if (kind === "add") {
      const d = Object.fromEntries(new FormData(form).entries());
      const payload = { title: d.title };
      if (d.material) payload.material = d.material;
      if (d.priority) payload.priority = Number(d.priority);
      if (d.deadline) payload.deadline = inputToIso(d.deadline);
      void run(() => apiPost("/api/print/scheduler/queue", payload), "Задание добавлено");
    } else if (kind === "params") {
      const rowEl = form.closest("[data-task]");
      const taskId = rowEl?.dataset.task;
      const d = Object.fromEntries(new FormData(form).entries());
      void saveParams(taskId, form, d);
    }
  });
}

async function saveParams(taskId, form, d) {
  const payload = {
    priority: Number(d.priority) || 0,
    dayNightPreference: d.dayNightPreference || "any",
    notBefore: d.notBefore ? inputToIso(d.notBefore) : null,
    deadline: d.deadline ? inputToIso(d.deadline) : null,
    unattendedAllowed: form.querySelector('[name="unattended"]').checked
  };
  try {
    await apiPost(`/api/print/scheduler/tasks/${taskId}/params`, payload);
    const pin = d.pin;
    if (pin) await apiPost(`/api/print/scheduler/tasks/${taskId}/pin`, { printer: pin });
    toast("Параметры сохранены", "toast-ok");
    await loadAll();
  } catch (err) {
    toast(esc(err.message || "Не удалось сохранить"), "toast-danger");
    await loadAll();
  }
}

async function moveTask(taskId, dir) {
  const idx = state.queue.findIndex((r) => r.task.id === taskId);
  if (idx < 0) return;
  const row = state.queue[idx];
  const neighbourIdx = dir === "up" ? idx - 1 : idx + 1;
  const neighbour = state.queue[neighbourIdx];
  if (!neighbour) return;
  // Move past the neighbour: server re-sorts by position.
  const position = dir === "up" ? neighbour.entry.position - 1 : neighbour.entry.position + 1;
  await run(
    () => apiPost(`/api/print/scheduler/tasks/${taskId}/reorder`, {
      position,
      expectedVersion: row.entry.version
    }),
    "Порядок обновлён"
  );
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

/* ── Мелочи ─────────────────────────────────────────────────── */

function panel(title, inner, head = "") {
  return `
    <div class="slice-panel">
      <div class="slice-panel-head"><b>${esc(title)}</b>${head ? ` ${head}` : ""}</div>
      ${inner}
    </div>`;
}

function chip(label, cls, pulse = false) {
  return `<span class="upload-chip chip-${cls}"><i class="dot${pulse ? " dot-pulse" : ""}"></i>${label}</span>`;
}

function groupByPrinter(assignments) {
  const map = new Map();
  for (const a of assignments || []) {
    const id = a.assignment.printerId;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(a);
  }
  return map;
}

function etaSourceLabel(source) {
  return source === "slice_variant" ? "слайс"
    : source === "gcode_analysis" ? "G-code"
    : "нет данных";
}

function fmtDuration(s) {
  if (s == null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} ч ${m} м` : `${m} м`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtTime(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** ISO → значение для input[type=datetime-local] в локальном времени. */
function isoToInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Значение datetime-local (локальное) → ISO. */
function inputToIso(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
