/* ── Раздел «Планировщик печати»: view ─────────────────────────
   Чистая разметка панелей: (state) → HTML. Состоянием, опросом и мутациями
   владеет controller.js; снапшоты форм — editSnapshot.js. */

import { esc } from "../../util.js";
import { chip, panel } from "../../shared/chips.js";
import { fmtDate, fmtDuration, fmtTime, isoToInput } from "../../shared/format.js";

const VERDICT = {
  compatible: { label: "совместимо", cls: "ok" },
  review: { label: "проверить", cls: "warn" },
  blocked: { label: "заблокировано", cls: "error" }
};
const DAYNIGHT = { any: "любое", day: "день", night: "ночь" };

/* Ошибка опроса — отдельным баннером НАД данными: последние успешные данные
   остаются на месте, оператор не видит ложного пустого состояния. */
export function errorBanner(state) {
  if (!state.error) return "";
  return `<div class="slice-panel sch-poll-error"><div class="slice-warn">⚠ Часть данных не обновилась (${esc(state.error)}) — показаны последние полученные; повторю попытку автоматически.</div></div>`;
}

export function queueHtml(state) {
  if (!state.queue.length) {
    return panel("Очередь заданий", `<div class="slice-empty">Очередь пуста, Владыка — Назарик ожидает вашего слова. Соблаговолите добавить задание ниже.</div>`);
  }
  const rows = state.queue.map((row, i) => queueRow(state, row, i)).join("");
  return panel("Очередь заданий", `<ul class="slice-list sch-queue">${rows}</ul>`,
    `<span class="slice-hint">порядок = приоритет планирования</span>`);
}

function queueRow(state, row, index) {
  const t = row.task;
  const entry = row.entry;
  const tags = [];
  if (t.priority) tags.push(chip(`приоритет ${t.priority}`, "info"));
  if (t.pinnedPrinterId) tags.push(chip(`🔒 ${esc(t.pinnedPrinterId)}`, "info"));
  if (t.dayNightPreference && t.dayNightPreference !== "any") tags.push(chip(esc(DAYNIGHT[t.dayNightPreference] || t.dayNightPreference), "warn"));
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

export function addTaskHtml() {
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

export function compatibilityHtml(state) {
  const { printers, rows } = state.matrix;
  if (!printers.length) {
    return panel("Матрица совместимости", `<div class="slice-empty">В конфигурации фермы нет ни одного принтера — мне некого выстраивать, Владыка.</div>`);
  }
  if (!rows.length) {
    return panel("Матрица совместимости", `<div class="slice-empty">Нет заданий, которые надлежало бы проверить.</div>`);
  }
  const head = `<tr><th>Задание</th>${printers.map((p) => `<th>${esc(p.name)}</th>`).join("")}</tr>`;
  const body = rows.map((r) => {
    const cells = printers.map((p) => {
      const res = r.results.find((x) => x.printerId === p.id);
      if (!res) return `<td>—</td>`;
      const v = VERDICT[res.verdict] || { label: res.verdict, cls: "info" };
      const reasons = [...res.blockers, ...res.reviews, ...res.warnings].map((x) => x.message).join(" · ");
      const eta = res.eta && res.eta.seconds != null ? ` ${fmtDuration(res.eta.seconds)}` : "";
      return `<td title="${esc(reasons)}">${chip(esc(v.label) + eta, v.cls)}</td>`;
    }).join("");
    return `<tr><td class="sch-cell-task">${esc(r.title)}</td>${cells}</tr>`;
  }).join("");
  return panel("Матрица совместимости",
    `<div class="sch-matrix-wrap"><table class="sch-matrix"><thead>${head}</thead><tbody>${body}</tbody></table></div>`,
    `<span class="slice-hint">неизвестное критичное значение → «проверить», не «совместимо»</span>`);
}

export function planHtml(state) {
  const controls = `
    <button type="button" class="btn btn-primary btn-sm" data-sch-action="build-plan">Построить черновик</button>
    ${state.plan ? `<button type="button" class="btn btn-sm" data-sch-action="recompute" data-id="${esc(state.plan.plan.id)}">↻ Пересчитать</button>` : ""}
    ${state.plan && state.plan.plan.state === "DRAFT" ? `<button type="button" class="btn btn-ok btn-sm" data-sch-action="confirm" data-id="${esc(state.plan.plan.id)}">✓ Подтвердить</button>` : ""}`;

  if (!state.plan) {
    return panel("План печати", `<div class="slice-empty">Плана ещё нет, Владыка. Повелите — и я выстрою черновик из текущей очереди.</div>`, controls);
  }

  const plan = state.plan.plan;
  const stateChip = plan.state === "ACTIVE"
    ? chip(`подтверждён · ревизия ${plan.revision}`, "ok")
    : plan.state === "DRAFT"
      ? chip(`черновик · ревизия ${plan.revision}`, "warn")
      : chip(`${esc(plan.state)} · ревизия ${plan.revision}`, "info");
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

  // The state chip is HTML — it belongs in the (unescaped) panel body, not the
  // title (panel() esc()-escapes the title, which would show raw <span> markup).
  return panel("План печати",
    `<div class="sch-plan-status">${stateChip}${confirmed}</div><div class="sch-lanes">${timeline || `<div class="slice-empty">Ни одно задание не нашло себе места — я доложила причины ниже.</div>`}</div>${unplaced}`,
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

export function nightHtml(state) {
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
    : `<div class="slice-empty">Достойных ночи кандидатов нет, Владыка. Я требую от них: готовый слайс, утверждённый набор, известную ETA, достаток материала, свежую телеметрию, чистый стол и дозволение печатать без присмотра.</div>`;
  const rejected = (n.rejected || []).length
    ? `<details class="slice-details"><summary>Отклонённые кандидаты (${n.rejected.length})</summary>
        <ul class="slice-findings">${n.rejected.map((r) => `<li class="slice-warn">⚠ ${esc(r.title)} → ${esc(r.printerId)}: ${esc((r.reasons || []).join("; "))}</li>`).join("")}</ul>
       </details>`
    : "";
  return panel("Ночные кандидаты", `${candidates}${rejected}`, buffer);
}

/* ── Мелочи ─────────────────────────────────────────────────── */

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
