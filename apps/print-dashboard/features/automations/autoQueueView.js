/* ── Автоочередь: разметка ───────────────────────────────────────
   Чистые функции (состояние → HTML). Решает сервер: настроена ли автоочередь
   при развёртывании, включено ли правило, что она запустила бы сейчас и почему
   нет. Вид только показывает это и честно говорит, что выключено. */

import { esc } from "../../util.js";
import { chip } from "../../shared/chips.js";
import { icon } from "../../shared/icons.js";
import { fmtDate } from "../../shared/format.js";

const OUTCOME = {
  would_start: { label: "запустилось бы", tone: "ok" },
  started: { label: "запущено", tone: "ok" },
  waiting: { label: "ждёт", tone: "warn" },
  refused: { label: "отказ", tone: "error" },
  halted: { label: "аварийная остановка", tone: "error" },
  not_allowed: { label: "не для автоочереди", tone: "mute" }
};

function outcomeChip(outcome) {
  const o = OUTCOME[outcome] || { label: outcome, tone: "mute" };
  return chip(esc(o.label), o.tone);
}

/**
 * `vm`: { status (GET …/auto-queue → status), plan (→ plan), loading, error, busy }.
 */
export function autoQueueHtml(vm) {
  if (vm.loading) return `<div class="slice-loading">Сверяюсь с автоочередью…</div>`;
  if (!vm.status) {
    return `<div class="slice-empty">${esc(vm.error || "Состояние автоочереди недоступно.")}</div>`;
  }
  const s = vm.status;
  const head = [
    s.configured ? chip("разрешена на сервере", "ok") : chip("выключена на сервере", "mute"),
    s.armed ? chip("правило включено", "ok") : chip("правило выключено", "mute"),
    s.running ? chip("проход идёт", "info", true) : ""
  ].join(" ");
  const state = !s.configured
    ? `<p class="slice-hint">Автоматический запуск выключен при развёртывании (<code>AUTO_QUEUE_ENABLED=false</code>) — ничего не запускается, сколько ни включай правило. Ниже — что она запустила бы сейчас, если бы была включена.</p>`
    : s.armed
      ? `<p class="slice-hint">Каждые ${Math.round(s.intervalMs / 1000)} с запускает следующее разрешённое задание на свободном принтере — не больше ${s.maxStartsPerTick} за проход и никогда два на один принтер.</p>`
      : `<p class="slice-hint">Разрешена на сервере, но правило выключено — включите его в списке выше, когда будете готовы.</p>`;
  const halted = s.haltedReason
    ? `<div class="slice-block">${icon("blocked")}Автоочередь останавливала себя: ${esc(s.haltedReason)}</div>`
    : "";
  const plan = (vm.plan || []).length
    ? `<ul class="slice-list">${vm.plan.map(rowHtml).join("")}</ul>`
    : `<div class="slice-empty">В очереди нет заданий, ожидающих запуска.</div>`;
  const recent = (s.recent || []).length
    ? `<div class="panel-sub">Последние решения</div><ul class="slice-list">${s.recent.slice(0, 10).map(rowHtml).join("")}</ul>`
    : "";
  const busy = vm.busy ? " disabled" : "";
  const tick =
    s.configured && s.armed
      ? `<button type="button" class="btn btn-sm" data-aq-action="tick"${busy}>${icon("play")}<span>Сделать проход сейчас</span></button>`
      : "";
  return `
    <section class="slice-panel aq" aria-label="Автоочередь">
      <div class="slice-panel-head"><b>Автоочередь</b><span class="aq-chips">${head}</span></div>
      ${state}
      ${halted}
      <p class="slice-hint">Запускает только задания с разрешением «можно печатать без присутствия оператора», только когда стол
        отмечен свободным, материал известен с принтера, файл проверен на устройстве, и только тем же путём, что кнопка «Запустить».
        Ничего не подтверждает за человека. Если исход запуска потерян — выключает себя.</p>
      ${vm.error ? `<div class="form-error" role="alert">${esc(vm.error)}</div>` : ""}
      <div class="panel-sub">Что запустилось бы сейчас</div>
      ${plan}
      ${recent}
      <div class="np-row">
        <button type="button" class="btn btn-sm" data-aq-action="refresh"${busy}>${icon("refresh")}<span>Проверить</span></button>
        ${tick}
      </div>
      ${s.lastTickAt ? `<p class="slice-hint">Последний проход: ${esc(fmtDate(s.lastTickAt))}</p>` : ""}
    </section>`;
}

export function rowHtml(d) {
  return `<li class="slice-item"><div class="slice-item-head">
      <span class="slice-name">${esc(d.title)}</span>
      ${outcomeChip(d.outcome)}
      ${d.printerName ? `<span class="slice-tag">${esc(d.printerName)}</span>` : ""}
    </div>
    ${d.message && d.outcome !== "would_start" ? `<p class="slice-hint">${esc(d.message)}</p>` : ""}</li>`;
}
