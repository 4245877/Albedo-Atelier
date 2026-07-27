/* ── Раздел «Оператор и ручные операции»: view ──────────────────
   Чистая разметка: (state) → HTML. Состоянием, опросом и мутациями владеет
   controller.js. Здесь нет ни одного fetch и ни одного решения — только то,
   как честно показать оператору три вещи:

     • когда он, по расписанию, доступен / спит / отсутствует;
     • какие физические операции ждут его рук и с какого момента;
     • сколько принтер уже простаивает вынужденно, ожидая человека.

   Принципиально: кнопка подтверждения выполнения — единственный способ
   закрыть операцию. Никакого «принтер показывает idle → считаем модель
   снятой»: именно в этом состоянии деталь и лежит на столе. */

import { esc } from "../../util.js";
import { chip, panel } from "../../shared/chips.js";
import { fmtDate } from "../../shared/format.js";

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

const PRESENCE = {
  AVAILABLE: { label: "оператор доступен", cls: "ok" },
  ASLEEP: { label: "оператор спит", cls: "warn" },
  AWAY: { label: "оператор отсутствует", cls: "warn" },
  OFF: { label: "вне рабочего окна", cls: "info" },
  UNKNOWN: { label: "расписание неизвестно", cls: "error" }
};

const OP_STATE = {
  PENDING: { label: "ожидает", cls: "info" },
  READY: { label: "можно выполнять", cls: "ok" },
  IN_PROGRESS: { label: "выполняется", cls: "warn" },
  FAILED: { label: "не удалась", cls: "error" },
  COMPLETED: { label: "выполнена", cls: "ok" },
  CANCELLED: { label: "отменена", cls: "info" }
};

export function errorBanner(state) {
  if (!state.error) return "";
  return `<div class="slice-panel sch-poll-error"><div class="slice-warn">⚠ Часть данных не обновилась (${esc(state.error)}) — показаны последние полученные; повторю попытку автоматически.</div></div>`;
}

/* ── Расписание оператора ──────────────────────────────────── */

export function scheduleHtml(state) {
  const view = state.schedule;
  if (!view) {
    return panel(
      "Расписание оператора",
      `<div class="slice-empty">Оператор не заведён — расписание недоступно.</div>`
    );
  }
  const a = view.availability || {};
  const presence = PRESENCE[a.presence] || PRESENCE.UNKNOWN;

  /* Нерешённое расписание — не «выходной», а отсутствие ответа. Показываем это
     явно: именно оно fail-closed блокирует автоматическое продолжение. */
  const unresolvedNote = a.resolved
    ? ""
    : `<div class="slice-warn">⚠ ${esc(a.reason || "расписание не разобрано")} — автоматическое продолжение очереди заблокировано (fail-closed).</div>`;

  const facts = [
    chip(presence.label, presence.cls),
    view.operator?.timeZone
      ? chip(`таймзона ${esc(view.operator.timeZone)}`, "info")
      : chip("таймзона не задана", "error"),
    a.nextAvailableAt ? chip(`доступен с ${fmtDate(a.nextAvailableAt)}`, "info") : "",
    a.availableUntil ? chip(`до ${fmtDate(a.availableUntil)}`, "info") : ""
  ].join("");

  return panel(
    "Расписание оператора",
    `${unresolvedNote}
     <div class="sch-tags">${facts}</div>
     ${weekTable("Рабочие окна", view.available)}
     ${weekTable("Сон", view.sleep)}
     ${scheduleForm(view)}
     ${exceptionsHtml(state, view)}
     ${absencesHtml(view)}`,
    `<span class="slice-hint">локальное время фермы</span>`
  );
}

function weekTable(title, windows) {
  if (!windows || !windows.length) {
    return `<div class="ops-week"><h4>${esc(title)}</h4><div class="slice-empty">не задано</div></div>`;
  }
  const byDay = new Map();
  for (const w of windows) {
    if (!byDay.has(w.weekday)) byDay.set(w.weekday, []);
    byDay.get(w.weekday).push(`${esc(w.start)}–${esc(w.end)}`);
  }
  const rows = WEEKDAYS.map((name, day) => {
    const spans = byDay.get(day);
    return `<li class="ops-week-row"><span class="ops-day">${name}</span><span>${
      spans ? esc(spans.join(", ")) : `<span class="slice-hint">—</span>`
    }</span></li>`;
  }).join("");
  return `<div class="ops-week"><h4>${esc(title)}</h4><ul class="ops-week-list">${rows}</ul></div>`;
}

/* Недельное расписание правится целиком: частично применённая неделя
   выглядела бы как настоящее расписание, поэтому форма отправляет весь набор. */
function scheduleForm(view) {
  const rows = WEEKDAYS.map((name, day) => {
    const av = (view.available || []).find((w) => w.weekday === day);
    const sl = (view.sleep || []).find((w) => w.weekday === day);
    return `
      <li class="ops-edit-row" data-weekday="${day}">
        <span class="ops-day">${name}</span>
        <label>работа<input type="time" name="av-start" value="${esc(av?.start || "")}" /></label>
        <label>–<input type="time" name="av-end" value="${esc(av?.end || "")}" /></label>
        <label>сон<input type="time" name="sl-start" value="${esc(sl?.start || "")}" /></label>
        <label>–<input type="time" name="sl-end" value="${esc(sl?.end || "")}" /></label>
      </li>`;
  }).join("");

  return `
    <details class="ops-details">
      <summary>Настроить недельное расписание и сон</summary>
      <form class="sch-edit" data-ops-form="schedule">
        <label>Таймзона (IANA)
          <input type="text" name="timeZone" placeholder="Europe/Moscow"
                 value="${esc(view.operator?.timeZone || "")}" />
        </label>
        <p class="slice-hint">Окно сна может пересекать полночь: 23:00 → 07:00 указывается как есть.</p>
        <ul class="ops-edit-list">${rows}</ul>
        <div class="ops-actions">
          <button type="submit" class="btn btn-sm" data-ops-action="save-schedule">Сохранить расписание</button>
        </div>
      </form>
    </details>`;
}

function exceptionsHtml(state, view) {
  const items = (view.exceptions || []).length
    ? (view.exceptions || [])
        .map(
          (e) => `
          <li class="slice-item" data-exception="${esc(e.id)}">
            <span class="slice-name">${esc(e.date)}</span>
            ${chip(exceptionLabel(e), e.kind === "off" ? "warn" : "info")}
            ${e.note ? `<span class="slice-hint">${esc(e.note)}</span>` : ""}
            <span class="slice-spacer"></span>
            <button type="button" class="btn btn-sm" data-ops-action="drop-exception" data-id="${esc(e.id)}">✕</button>
          </li>`
        )
        .join("")
    : `<li class="slice-empty">исключений нет</li>`;

  return `
    <details class="ops-details">
      <summary>Исключения на конкретные даты (${(view.exceptions || []).length})</summary>
      <ul class="slice-list">${items}</ul>
      <form class="sch-edit" data-ops-form="exception">
        <label>Дата<input type="date" name="date" value="${esc(state.localToday || "")}" required /></label>
        <label>Тип
          <select name="kind">
            <option value="available">рабочее окно (заменяет обычное)</option>
            <option value="sleep">сон (заменяет обычный)</option>
            <option value="off">выходной — весь день</option>
          </select>
        </label>
        <label>с<input type="time" name="start" /></label>
        <label>по<input type="time" name="end" /></label>
        <label>Примечание<input type="text" name="note" maxlength="200" /></label>
        <div class="ops-actions">
          <button type="submit" class="btn btn-sm" data-ops-action="add-exception">Добавить исключение</button>
        </div>
      </form>
    </details>`;
}

function exceptionLabel(e) {
  if (e.kind === "off") return "выходной";
  const span =
    e.startMinutes != null && e.endMinutes != null
      ? ` ${minutes(e.startMinutes)}–${minutes(e.endMinutes)}`
      : "";
  return `${e.kind === "sleep" ? "сон" : "работа"}${span}`;
}

function minutes(value) {
  const h = String(Math.floor(value / 60)).padStart(2, "0");
  const m = String(value % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function absencesHtml(view) {
  const items = (view.absences || []).length
    ? (view.absences || [])
        .map(
          (a) => `
          <li class="slice-item" data-absence="${esc(a.id)}">
            <span class="slice-name">${fmtDate(a.startsAt)} → ${a.endsAt ? fmtDate(a.endsAt) : "бессрочно"}</span>
            ${a.reason ? `<span class="slice-hint">${esc(a.reason)}</span>` : ""}
            <span class="slice-spacer"></span>
            <button type="button" class="btn btn-sm" data-ops-action="drop-absence" data-id="${esc(a.id)}">✕</button>
          </li>`
        )
        .join("")
    : `<li class="slice-empty">отсутствий нет</li>`;

  return `
    <details class="ops-details">
      <summary>Временное отсутствие (${(view.absences || []).length})</summary>
      <ul class="slice-list">${items}</ul>
      <form class="sch-edit" data-ops-form="absence">
        <label>С<input type="datetime-local" name="startsAt" required /></label>
        <label>По<input type="datetime-local" name="endsAt" /></label>
        <label>Причина<input type="text" name="reason" maxlength="200" /></label>
        <div class="ops-actions">
          <button type="submit" class="btn btn-sm" data-ops-action="add-absence">Записать отсутствие</button>
        </div>
      </form>
    </details>`;
}

/* ── Ожидающие операции ────────────────────────────────────── */

export function operationsHtml(state) {
  const rows = state.operations || [];
  if (!rows.length) {
    return panel(
      "Ручные операции",
      `<div class="slice-empty">Ожидающих операций нет — ни один принтер не удерживается.</div>`,
      openOperationForm(state)
    );
  }
  return panel(
    "Ручные операции",
    `<ul class="slice-list ops-list">${rows.map(operationRow).join("")}</ul>
     ${openOperationForm(state)}`,
    `<span class="slice-hint">подтверждение выполняет человек</span>`
  );
}

function operationRow(row) {
  const op = row.operation;
  const st = OP_STATE[op.state] || OP_STATE.PENDING;
  const tags = [
    chip(st.label, st.cls),
    chip(esc(op.printerId), "info"),
    op.blocking ? chip("удерживает принтер", "warn") : chip("не блокирует", "info"),
    row.expectedMinutes != null
      ? chip(`≈ ${row.expectedMinutes} мин`, "info")
      : chip("длительность неизвестна", "error")
  ].join("");

  /* Для неготовой операции показываем ПОЧЕМУ и С КАКОГО МОМЕНТА — это и есть
     ответ на «печать кончилась в 03:00, а снять можно с 08:00». */
  const waiting = row.ready
    ? ""
    : `<div class="slice-hint">${esc(row.reason)}${
        row.earliestAt ? ` · можно с ${fmtDate(row.earliestAt)}` : " · срок неизвестен"
      }</div>`;

  const actions = op.state === "IN_PROGRESS" || row.ready
    ? `<button type="button" class="btn btn-sm" data-ops-action="complete" data-id="${esc(op.id)}">✓ выполнено</button>
       <button type="button" class="btn btn-sm" data-ops-action="fail" data-id="${esc(op.id)}">не удалось</button>`
    : "";

  return `
    <li class="slice-item ops-row" data-operation="${esc(op.id)}">
      <div class="slice-item-head">
        <span class="slice-name">${esc(row.label)}</span>
        <span class="slice-spacer"></span>
        ${op.state === "READY" ? `<button type="button" class="btn btn-sm" data-ops-action="claim" data-id="${esc(op.id)}">взять в работу</button>` : ""}
        ${actions}
        <button type="button" class="btn btn-sm" data-ops-action="cancel-op" data-id="${esc(op.id)}">✕</button>
      </div>
      <div class="sch-tags">${tags}</div>
      ${op.reason ? `<div class="slice-hint">${esc(op.reason)}</div>` : ""}
      ${waiting}
      <form class="sch-edit ops-confirm" data-ops-form="complete" data-id="${esc(op.id)}">
        <label>Фактическая длительность, мин<input type="number" name="actualMinutes" min="0" step="1" /></label>
        <label>Кто подтвердил<input type="text" name="actor" maxlength="60" /></label>
        <label>Примечание<input type="text" name="note" maxlength="200" /></label>
      </form>
    </li>`;
}

function openOperationForm(state) {
  const types = (state.types || [])
    .map((t) => `<option value="${esc(t.type)}">${esc(t.label)} (≈ ${t.defaultMinutes} мин)</option>`)
    .join("");
  const printers = (state.printers || [])
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`)
    .join("");
  return `
    <details class="ops-details">
      <summary>Создать операцию вручную</summary>
      <form class="sch-edit" data-ops-form="open">
        <label>Тип<select name="type" required>${types}</select></label>
        <label>Принтер<select name="printerId" required>${printers}</select></label>
        <label>Длительность, мин<input type="number" name="estimatedMinutes" min="0" step="1" /></label>
        <label>Причина<input type="text" name="reason" maxlength="200" /></label>
        <div class="ops-actions">
          <button type="submit" class="btn btn-sm" data-ops-action="open-op">Создать</button>
        </div>
      </form>
    </details>`;
}

/* ── Вынужденный простой принтеров ─────────────────────────── */

export function holdsHtml(state) {
  const holds = (state.holds || []).filter((h) => !h.free);
  if (!holds.length) return "";
  const rows = holds
    .map((h) => {
      const tags = [
        chip(esc(h.printerId), "info"),
        h.waitingForOperator ? chip("ждёт оператора", "warn") : chip("операция выполняется", "info"),
        /* releaseAt = null означает «неизвестно», и это НЕ «скоро»: показываем
           честно, иначе цифра читается как обещание. */
        h.releaseAt
          ? chip(`освободится ${fmtDate(h.releaseAt)}`, "info")
          : chip("срок неизвестен", "error"),
        h.forcedIdleMinutes != null ? chip(`простой ${h.forcedIdleMinutes} мин`, "warn") : ""
      ].join("");
      return `
        <li class="slice-item">
          <div class="slice-item-head"><span class="slice-name">${esc(h.printerId)}</span></div>
          <div class="sch-tags">${tags}</div>
          <div class="slice-hint">${esc(h.reason)}</div>
        </li>`;
    })
    .join("");
  return panel(
    "Вынужденный простой",
    `<ul class="slice-list">${rows}</ul>`,
    `<span class="slice-hint">принтер удерживается до подтверждения операции</span>`
  );
}
