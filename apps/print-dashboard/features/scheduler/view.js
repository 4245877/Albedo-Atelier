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

/* ── План = РЕКОМЕНДАЦИЯ ────────────────────────────────────────
   Раздел честно разделяет пять разных вещей, которые легко спутать:
     1) рекомендация      — что советует планировщик (черновик);
     2) подтверждённый план — что оператор утвердил (ACTIVE);
     3) подготовленный файл — байты доехали до принтера;
     4) DispatchEligibility — разрешение «можно стартовать сейчас»;
     5) фактический запуск  — печать реально идёт.
   Ни одна кнопка здесь не делает 3–5: это только 1 и 2. */

const RELEASE_LABEL = {
  FREE: "свободен",
  PRINTING: "печатает",
  MACHINE_BUSY_UNKNOWN: "занят, остаток времени неизвестен",
  AWAITING_OPERATOR: "ждёт оператора",
  OPERATION_IN_PROGRESS: "идёт ручная операция",
  RELEASE_UNKNOWN_SCHEDULE: "срок неизвестен: нет расписания оператора",
  RELEASE_UNKNOWN_DURATION: "срок неизвестен: нет длительности операции",
  FROZEN_ASSIGNMENT: "занят замороженным назначением"
};

const UNPLACED_LABEL = {
  NO_COMPATIBLE_PRINTER: "нет совместимых принтеров",
  PINNED_PRINTER_UNAVAILABLE: "закреплённый принтер недоступен",
  PRINTER_RELEASE_UNKNOWN: "неизвестно время освобождения принтера",
  ETA_UNKNOWN: "неизвестна длительность печати",
  UNKNOWN: "причина не записана"
};

const SEGMENT = {
  printing: { cls: "print", label: "печать" },
  operator_wait: { cls: "wait", label: "простой в ожидании оператора" },
  operation: { cls: "op", label: "ручная операция" },
  unknown: { cls: "unknown", label: "срок неизвестен" },
  frozen_print: { cls: "frozen", label: "заморожено" },
  planned_print: { cls: "planned", label: "рекомендация" },
  approx_print: { cls: "approx", label: "оценка, не план" }
};

export function planHtml(state) {
  const plan = state.plan;
  const controls = `
    <button type="button" class="btn btn-primary btn-sm" data-sch-action="recompute-all">↻ Пересчитать рекомендации</button>
    ${plan && plan.plan.state === "DRAFT"
      ? `<button type="button" class="btn btn-ok btn-sm" data-sch-action="confirm" data-id="${esc(plan.plan.id)}">✓ Подтвердить план вручную</button>`
      : ""}`;

  if (!plan) {
    return panel("Рекомендации планировщика",
      `<div class="slice-empty">Рекомендаций ещё нет, Владыка. Повелите пересчитать — и я выстрою их из текущей очереди.</div>`,
      controls);
  }

  const p = plan.plan;
  const stateChip = p.state === "ACTIVE"
    ? chip(`подтверждённый план · ревизия ${p.revision}`, "ok")
    : p.state === "DRAFT"
      ? chip(`рекомендация (не подтверждена) · ревизия ${p.revision}`, "warn")
      : chip(`${esc(p.state)} · ревизия ${p.revision}`, "info");
  const confirmed = p.confirmedAt ? `<span class="slice-hint">подтверждён ${fmtDate(p.confirmedAt)}</span>` : "";
  const stale = plan.staleness && plan.staleness.stale
    ? `<div class="slice-warn sch-stale-plan">⚠ План устарел: ${esc(plan.staleness.reason || "есть более новая рекомендация")} — пересчитайте, прежде чем подтверждать.</div>`
    : "";
  const generated = plan.generatedAt
    ? `<span class="slice-hint">рассчитан ${fmtDate(plan.generatedAt)}</span>`
    : "";
  const frozenUntil = plan.frozenUntil
    ? `<span class="slice-hint">заморожено до ${fmtTime(plan.frozenUntil)}</span>`
    : "";

  const explanations = new Map();
  for (const a of [...(plan.assignments || []), ...(plan.frozen || [])]) {
    explanations.set(a.assignment.taskId, a);
  }

  const lanes = (plan.timeline || []).map((lane) => timelineLane(lane, explanations)).join("");
  const cards = (plan.assignments || []).map(assignmentCard).join("");

  return panel("Рекомендации планировщика",
    `<div class="sch-plan-status">${stateChip}${confirmed}${generated}${frozenUntil}</div>
     ${stale}
     ${legendHtml()}
     <div class="sch-lanes">${lanes || `<div class="slice-empty">В конфигурации фермы нет принтеров — линии строить не из чего.</div>`}</div>
     ${cards ? `<div class="sch-cards">${cards}</div>` : ""}
     ${unplacedHtml(plan.unplaced)}`,
    controls);
}

function legendHtml() {
  const items = [
    ["planned", "рекомендация"],
    ["frozen", "подтверждено и заморожено"],
    ["print", "печать идёт"],
    ["wait", "вынужденный простой (сон/отсутствие оператора)"],
    ["op", "ручная операция"],
    ["approx", "оценка, не план"],
    ["unknown", "срок неизвестен"]
  ];
  return `<div class="sch-legend">
    ${items.map(([cls, label]) => `<span class="sch-legend-item"><i class="sch-seg-dot sch-seg-${cls}"></i>${esc(label)}</span>`).join("")}
    <span class="slice-hint">Рекомендация ≠ подтверждённый план ≠ подготовленный файл ≠ разрешение DispatchEligibility ≠ фактический запуск. Здесь только первые два — ни один файл не загружается и ни один принтер не запускается.</span>
  </div>`;
}

function timelineLane(lane, explanations) {
  const release = lane.releaseAtMs != null
    ? chip(`свободен с ${fmtTime(lane.releaseAtMs)}`, lane.waitingForOperator ? "warn" : "ok")
    : chip("время освобождения неизвестно", "error");
  const code = chip(esc(RELEASE_LABEL[lane.releaseCode] || lane.releaseCode || "—"), "info");
  const segments = (lane.segments || []).map((s) => segmentHtml(s, explanations)).join("") ||
    `<span class="slice-empty">ничего не запланировано</span>`;
  return `
    <div class="sch-lane">
      <div class="sch-lane-head">${esc(lane.name || lane.printerId)}</div>
      <div class="sch-lane-meta">${release}${code}</div>
      <div class="sch-lane-reason slice-hint">${esc(lane.releaseReason || "")}</div>
      <div class="sch-lane-body">${segments}</div>
    </div>`;
}

function segmentHtml(seg, explanations) {
  const meta = SEGMENT[seg.kind] || { cls: "unknown", label: seg.kind };
  const window = seg.endMs != null
    ? `${fmtTime(seg.startMs)}–${fmtTime(seg.endMs)}`
    : `${fmtTime(seg.startMs)} — конец неизвестен`;
  const view = seg.taskId ? explanations.get(seg.taskId) : null;
  const ex = view?.explanation || null;
  const flags = [];
  if (ex?.manualStartRequired) flags.push(chip("старт вручную", "warn"));
  if (ex?.requiresUpload) flags.push(chip("файл не подготовлен", "warn"));
  if (seg.approximate) flags.push(chip("оценка", "warn"));
  return `
    <div class="sch-seg sch-seg-${meta.cls}">
      <div class="sch-seg-head"><span class="sch-seg-time">${esc(window)}</span><span class="sch-seg-kind">${esc(meta.label)}</span></div>
      <div class="sch-seg-label">${esc(seg.label || "")}</div>
      ${flags.length ? `<div class="sch-tags">${flags.join("")}</div>` : ""}
    </div>`;
}

function assignmentCard(view) {
  const ex = view.explanation || {};
  const task = view.task || {};
  const binding = view.assignment?.binding || {};
  const eta = ex.etaSeconds != null
    ? `${fmtDuration(ex.etaSeconds)} · ${etaConfidenceLabel(ex.etaConfidence)} · ${etaSourceLabel(ex.etaSource)}`
    : "ETA неизвестна";
  const window = ex.startMs
    ? `${fmtTime(ex.startMs)}${ex.endMs ? "–" + fmtTime(ex.endMs) : ""}`
    : "";
  const bed = ex.bedReleaseMs != null
    ? `стол освободится ≈ ${fmtTime(ex.bedReleaseMs)}${ex.bedReleaseEstimated ? " (оценка)" : ""}`
    : "время освобождения стола неизвестно";
  const revisions = [
    binding.sliceVariantId ? `слайс ${binding.sliceVariantId}` : null,
    binding.machineRevisionId ? `machine ${binding.machineRevisionId}` : null,
    binding.processRevisionId ? `process ${binding.processRevisionId}` : null,
    binding.filamentRevisionId ? `filament ${binding.filamentRevisionId}` : null
  ].filter(Boolean);
  const ops = Array.isArray(ex.manualOperations) && ex.manualOperations.length
    ? `<div class="slice-hint">ручные операции: ${ex.manualOperations
        .map((op) => `${esc(op.label)} (${op.when === "before" ? "до" : "после"}${op.minutes != null ? `, ~${op.minutes} мин` : ""})`)
        .join("; ")}</div>`
    : "";
  const score = Array.isArray(ex.scoreBreakdown) && ex.scoreBreakdown.length
    ? `<details class="slice-details"><summary>почему этот принтер (score ${ex.score ?? 0})</summary>
        <ul class="slice-findings">${ex.scoreBreakdown.map((c) => `<li>${esc(c.label)}: ${c.value > 0 ? "+" : ""}${c.value}</li>`).join("")}</ul>
       </details>`
    : "";
  const alts = Array.isArray(ex.alternatives) && ex.alternatives.length
    ? `<div class="slice-hint">альтернативы: ${ex.alternatives.map((a) => `${esc(a.printerId)} (${a.score})`).join(", ")}</div>`
    : "";
  const blockers = Array.isArray(ex.blockers) && ex.blockers.length
    ? `<ul class="slice-findings">${ex.blockers.map((b) => `<li class="slice-error">✖ ${esc(b)}</li>`).join("")}</ul>`
    : "";
  const warns = Array.isArray(ex.warnings) && ex.warnings.length
    ? `<ul class="slice-findings">${ex.warnings.map((w) => `<li class="slice-warn">⚠ ${esc(w)}</li>`).join("")}</ul>`
    : "";
  return `
    <div class="sch-assign${ex.frozen ? " sch-assign-frozen" : ""}">
      <div class="sch-assign-head">
        <span class="slice-name">${esc(task.title || view.assignment.taskId)}</span>
        ${chip(esc(ex.printerId || view.assignment.printerId), "info")}
        ${window ? `<span class="slice-tag">${window}</span>` : ""}
        ${ex.frozen ? chip("заморожено", "ok") : chip("рекомендация", "warn")}
      </div>
      <div class="sch-assign-meta">${esc(eta)} · ${esc(bed)}</div>
      <div class="slice-hint">${esc(ex.reason || "")}</div>
      ${revisions.length ? `<div class="slice-hint">ревизии: ${esc(revisions.join(" · "))}</div>` : ""}
      ${ops}${score}${alts}${blockers}${warns}
    </div>`;
}

function unplacedHtml(unplaced) {
  if (!Array.isArray(unplaced) || !unplaced.length) return "";
  return `<div class="sch-unplaced"><b>Не поставлены в план:</b><ul class="slice-findings">
      ${unplaced.map((u) => `<li class="slice-warn">⚠ ${esc(u.title)} — <code>${esc(u.code || "UNKNOWN")}</code> ${esc(UNPLACED_LABEL[u.code] || "")}: ${esc(u.reason)}${
        u.hint ? ` <span class="slice-hint">(${esc(u.hint.note)}: ${esc(u.hint.printerId)} ${fmtTime(u.hint.startMs)}–${fmtTime(u.hint.endMs)})</span>` : ""
      }</li>`).join("")}
     </ul></div>`;
}

function etaConfidenceLabel(confidence) {
  return confidence === "exact" ? "точная ETA"
    : confidence === "preliminary" ? "предварительная ETA"
    : "достоверность ETA неизвестна";
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

function etaSourceLabel(source) {
  return source === "slice_variant" ? "слайс"
    : source === "gcode_analysis" ? "G-code"
    : "нет данных";
}
