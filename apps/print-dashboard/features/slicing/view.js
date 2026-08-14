/* ── Раздел «Слайсинг и профили»: view ─────────────────────────
   Чистая разметка панелей раздела: (state) → HTML. Состоянием и сетью
   владеет controller.js; каждая функция получает state параметром и ничего
   не мутирует. */

import { esc } from "../../util.js";
import { chip } from "../../shared/chips.js";
import { fmtDuration, fmtWhen } from "../../shared/format.js";
import { createSetBlockReason, targetOptions } from "./formModel.js";

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

export function statusLabel(status) {
  return (STATUS[status] || { label: status }).label;
}

export function errorsHtml(state) {
  if (!state.errors.length) return "";
  return `
    <div class="slice-panel slice-errbox">
      <div class="slice-block">⛔ Мне не покорились: ${state.errors.map((e) => esc(e)).join(", ")}.
        Показываю последние достоверные данные; я буду взывать к ним снова сама.</div>
      <button type="button" class="btn btn-sm" data-slice-action="reload">↻ Обновить сейчас</button>
    </div>`;
}

/* Каждое состояние среды требует своего ремонта, поэтому «недоступен» больше не
   единственная надпись: подпись говорит, ЧТО сломано, а стадия — где искать.
   Полный технический текст (stderr, пути) прячем в <details> — он для админа. */
const RUNTIME_STATE = {
  ready: { label: "готов", cls: "ok" },
  not_configured: { label: "не настроен", cls: "warn" },
  executable_missing: { label: "файл не найден", cls: "error" },
  executable_corrupted: { label: "файл повреждён", cls: "error" },
  runtime_dependency_missing: { label: "нет системных библиотек", cls: "error" },
  cli_incompatible: { label: "несовместимый CLI", cls: "error" },
  resources_missing: { label: "нет resources/profiles", cls: "error" },
  version_mismatch: { label: "несовпадение версий", cls: "error" },
  smoke_failed: { label: "пробный слайсинг не прошёл", cls: "error" }
};

export function runtimeHtml(state) {
  const r = state.runtime;
  if (!r) return "";
  const rt = r.runtime || {};
  const ok = rt.available;
  const st = RUNTIME_STATE[rt.state] || { label: rt.state || "неизвестно", cls: ok ? "ok" : "error" };
  const badge = ok
    ? chip(`OrcaSlicer ${esc(rt.detectedVersion || "")} ${esc(st.label)}`, "ok")
    : chip(`OrcaSlicer: ${esc(st.label)}`, st.cls);
  const net = rt.networkIsolated ? `<span class="slice-tag">сеть отключена</span>` : "";

  // Сборка CLI (01.10.01.50) — это унаследованный от BambuStudio номер, он НЕ равен
  // релизу (2.3.0). Показываем оба, чтобы это расхождение больше никого не пугало.
  const build = rt.cliBuild ? `<span class="slice-tag">сборка CLI ${esc(rt.cliBuild)}</span>` : "";
  const smoke = rt.smoke
    ? rt.smoke.ok
      ? `<span class="slice-tag">✓ проверено слайсингом: ${Math.round((rt.smoke.gcodeBytes || 0) / 1024)} КБ G-code за ${rt.smoke.durationMs} мс</span>`
      : `<span class="slice-tag slice-tag-warn">пробный слайсинг не дал G-code</span>`
    : `<span class="slice-tag">слайсингом не проверено</span>`;

  const detail = rt.detail
    ? `<details class="slice-details"><summary>Техническая причина (для администратора)</summary>
         <pre class="slice-pre">${esc(rt.detail)}</pre></details>`
    : "";
  const err = !ok && rt.error ? `<div class="slice-block">⛔ ${esc(rt.error)}${detail}</div>` : "";
  const counts = r.profileCounts || {};
  const countRow = `
    <div class="slice-counts">
      ${chip(`активных: ${counts.active ?? 0}`, "ok")}
      ${chip(`карантин: ${counts.quarantined ?? 0}`, "warn")}
      ${chip(`невалидных: ${counts.invalid ?? 0}`, counts.invalid ? "error" : "info")}
    </div>`;

  const missing = (r.missingParents || []).length
    ? `<details class="slice-details"><summary>Не хватает базовых системных профилей (${r.missingParents.length}) — нажмите «↻ Импорт пресетов» или обновите каталог OrcaSlicer</summary>
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
        ${badge}${net}${build}${smoke}
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

export function profilesHtml(state) {
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
      <div class="slice-panel-head"><b>Профили</b><span class="slice-hint">Профили хранятся неизменяемыми ревизиями; в набор попадают только активные</span></div>
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
        ${chip(esc(st.label), st.cls)}
      </div>
      ${detail}
    </li>`;
}

export function setsHtml(state) {
  if (!state.sets.length) {
    return `<div class="slice-panel"><div class="slice-panel-head"><b>Наборы профилей</b></div>
      <div class="slice-empty">Наборов пока нет, Владыка. Соблаговолите создать первый ниже.</div></div>`;
  }
  const rows = state.sets.map(setRow).join("");
  return `<div class="slice-panel"><div class="slice-panel-head"><b>Наборы профилей</b></div>
    <ul class="slice-list">${rows}</ul></div>`;
}

function setRow(s) {
  const v = VALIDATION[s.validation] || { label: s.validation, cls: "info" };
  // Причина, по которой утвердить нельзя, доступна не только как title (мышь), но и
  // как aria-label — скринридер прочитает её на disabled-кнопке.
  const blockedReason = "Утвердить нельзя: есть блокеры — устраните их и обновите набор";
  const approved = s.approved
    ? chip("утверждён", "ok")
    : `<button type="button" class="btn btn-sm" data-slice-action="approve" data-id="${esc(s.id)}"${
        s.validation === "blocked" ? ` disabled title="${esc(blockedReason)}" aria-label="${esc(blockedReason)}"` : ""
      }>Утвердить</button>`;
  const blockers = (s.blockers || []).map((b) => `<li class="slice-block-li">⛔ ${esc(b.message)}</li>`).join("");
  const warnings = (s.warnings || []).map((w) => `<li class="slice-warn">⚠ ${esc(w.message)}</li>`).join("");
  const target = s.printerId ? `принтер ${esc(s.printerId)}` : s.printerClass ? `класс ${esc(s.printerClass)}` : "—";
  return `
    <li class="slice-item">
      <div class="slice-item-head">
        <span class="slice-name">${esc(s.name)}</span>
        ${chip(esc(v.label), v.cls)} <span class="slice-tag">${target}</span>
        <span class="slice-spacer"></span>
        ${approved}
      </div>
      ${blockers || warnings ? `<ul class="slice-findings">${blockers}${warnings}</ul>` : ""}
    </li>`;
}

export function createSetHtml(state) {
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
  const { printers, classes } = targetOptions(coverage);
  const printerOpts = printers
    .map(
      (c) =>
        `<option value="${esc(c.printerId)}">${esc(c.printerName)}${c.hasActiveProfile ? "" : " · нет активного профиля"}</option>`
    )
    .join("");
  const classOpts = classes.map((cls) => `<option value="${esc(cls)}">${esc(cls)}</option>`).join("");
  const hasClasses = classes.length > 0;

  // Причина, по которой набор создать нельзя (пустой список принтеров/coverage или
  // нет active-профилей), — единый источник и текста, и блокировки кнопки. Молча
  // отдавать пустую форму с невыбираемой целью нельзя.
  const blockReason = createSetBlockReason(coverage, missingActive);
  const note = blockReason
    ? `<div class="slice-block">⛔ ${esc(blockReason)}</div>`
    : `<div class="slice-hint">В набор попадают только active-профили; неактивные показаны, но недоступны для выбора. Цель — ровно одна: конкретный принтер или класс взаимозаменяемых принтеров.</div>`;
  const disabledAttr = blockReason ? " disabled" : "";

  return `
    <form class="slice-panel slice-form" data-slice-form="create-set">
      <div class="slice-panel-head"><b>Новый набор</b></div>
      <div class="slice-grid">
        <label>Имя<input type="text" name="name" required placeholder="K2 · PETG · Balance" /></label>
        <label>Принтер профиля<select name="machine" required>${opts(machines)}</select></label>
        <label>Печать<select name="process" required>${opts(processes)}</select></label>
        <label>Филамент<select name="filament" required>${opts(filaments)}</select></label>
      </div>
      <fieldset class="slice-target">
        <legend>Цель набора</legend>
        <label class="slice-target-opt"><input type="radio" name="targetType" value="printer" data-slice-target-type checked /> Конкретный принтер</label>
        <label class="slice-target-opt"><input type="radio" name="targetType" value="class" data-slice-target-type${hasClasses ? "" : " disabled"} /> Класс взаимозаменяемых принтеров${hasClasses ? "" : " · классы не заданы"}</label>
        <label data-target-input="printer">Принтер<select name="printer">${printerOpts || `<option value="">—</option>`}</select></label>
        <label data-target-input="class" hidden>Класс<select name="printerClass" disabled>${classOpts || `<option value="">—</option>`}</select></label>
      </fieldset>
      ${note}
      <button type="submit" class="btn btn-primary btn-sm"${disabledAttr}>Создать и проверить</button>
    </form>`;
}

export function variantsHtml(state) {
  if (!state.variants.length) return "";
  const rows = state.variants.map((v) => variantRow(state, v)).join("");
  // aria-live: смена статусов (в очереди → слайсинг… → готово/ошибка) объявляется
  // скринридером без перефокусировки.
  return `<div class="slice-panel"><div class="slice-panel-head"><b>Варианты слайсинга</b></div>
    <ul class="slice-list" role="status" aria-live="polite">${rows}</ul></div>`;
}

function variantRow(state, v) {
  const st = VARIANT_STATE[v.state] || { label: v.state, cls: "info" };

  // Прослеживаемость: что именно нарезалось, из какого набора и на какой принтер —
  // а не только короткий ID.
  const target = v.targetPrinterId
    ? printerName(state, v.targetPrinterId)
    : v.targetPrinterClass
      ? `класс «${esc(v.targetPrinterClass)}»`
      : "любой совместимый принтер";
  const facts = `
    <div class="slice-facts">
      <span>Модель: ${esc(modelName(state, v.sourceArtifactId))}</span>
      <span>Набор: ${esc(setName(state, v.profileSetId))}</span>
      <span>Принтер: ${esc(target)}</span>
    </div>`;

  const meta = [];
  if (v.orcaEtaS != null) meta.push(`Время печати (по OrcaSlicer): ${fmtDuration(v.orcaEtaS)}`);
  if (v.filamentG != null) meta.push(`Расход филамента: ${v.filamentG} г`);
  if (v.dimensions && v.dimensions.size) meta.push(`Габариты: ${fmtSize(v.dimensions.size)}`);
  const metaRow = meta.length ? `<div class="slice-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>` : "";

  // Выходной G-code показываем только у готового варианта: у заблокированного или
  // ошибочного output относится к прошлой попытке (при повторе он сбрасывается).
  const out =
    v.state === "ready" && v.outputArtifactId
      ? `<div class="slice-out">Готовый G-code: <code>${esc(v.outputArtifactId)}</code></div>`
      : "";

  // Рендерим И предупреждения (cache-hit, неполный анализ), И блокеры — раньше
  // warnings терялись, и было не видно, что результат переиспользован из кэша.
  const warnings = (v.warnings || []).map((w) => `<li class="slice-warn">⚠ ${esc(w.message)}</li>`).join("");
  const blockers = (v.blockers || []).map((b) => `<li class="slice-block-li">⛔ ${esc(b.message)}</li>`).join("");
  const findings = blockers || warnings ? `<ul class="slice-findings">${blockers}${warnings}</ul>` : "";

  const err = v.error && v.state === "failed" ? `<div class="slice-block">⛔ ${esc(v.error)}</div>` : "";

  const when = fmtWhen(v.endedAt || v.updatedAt || v.createdAt);
  const timeRow = when ? `<div class="slice-when">Обновлено: ${esc(when)}</div>` : "";

  const rerun =
    v.state === "failed" || v.state === "blocked"
      ? `<button type="button" class="btn btn-sm" data-slice-action="rerun" data-id="${esc(v.id)}">↻ Повторить</button>`
      : "";
  return `
    <li class="slice-item">
      <div class="slice-item-head">
        <span class="slice-name" title="ID варианта: ${esc(v.id)}">${esc(modelName(state, v.sourceArtifactId))}</span>
        ${chip(esc(st.label), st.cls, st.pulse)}
        <span class="slice-spacer"></span>
        ${rerun}
      </div>
      ${facts}${metaRow}${out}${err}${findings}${timeRow}${promoteHtml(state, v)}
    </li>`;
}

/* «Добавить в очередь» — переход от готового слайса к исполнимому заданию.
   Показываем ровно то, что оператор должен видеть перед решением: материал,
   сопло, размер результата, статус анализа G-code и состояние продвижения.
   Кнопка активна только для варианта, который сервер действительно примет;
   сервер всё равно перепроверяет — это подсказка, а не разрешение. */
function promoteHtml(state, v) {
  if (v.state !== "ready" || !v.outputArtifactId) return "";

  const promotedTask = (state.tasks || []).find((t) => t.sliceVariantId === v.id);
  const output = (state.outputs || []).find((a) => a.artifact && a.artifact.id === v.outputArtifactId);
  const analysis = output && output.analysis;

  const details = [];
  if (analysis && analysis.material) details.push(`Материал: ${analysis.material}`);
  if (analysis && analysis.nozzleDiameterMm != null) details.push(`Сопло: ${analysis.nozzleDiameterMm} мм`);
  if (output && output.artifact && output.artifact.sizeBytes != null) {
    details.push(`Размер файла: ${fmtBytes(output.artifact.sizeBytes)}`);
  }
  const detailRow = details.length
    ? `<div class="slice-meta">${details.map((d) => `<span>${esc(d)}</span>`).join("")}</div>`
    : "";

  // Честный статус анализа выходного файла: без завершённого schedulable-анализа
  // продвижение запрещено, и мы объясняем это, а не просто гасим кнопку.
  const analysisReady = analysis && analysis.state === "ready" && analysis.verdict === "schedulable";
  const analysisChip = !analysis
    ? chip("анализ G-code: нет", "warn")
    : analysis.state !== "ready"
      ? chip(`анализ G-code: ${esc(analysis.state)}`, "info", true)
      : analysisReady
        ? chip("анализ G-code: пройден", "ok")
        : chip(`анализ G-code: ${esc(analysis.verdict || "не пройден")}`, "error");

  const outBlockers = ((analysis && analysis.blockers) || [])
    .map((b) => `<li class="slice-block-li">⛔ ${esc(b.message)}</li>`)
    .join("");
  const outWarnings = ((analysis && analysis.warnings) || [])
    .map((w) => `<li class="slice-warn">⚠ ${esc(w.message)}</li>`)
    .join("");
  const outFindings = outBlockers || outWarnings
    ? `<ul class="slice-findings">${outBlockers}${outWarnings}</ul>`
    : "";

  if (promotedTask) {
    // Состояние продвижения сохраняется на сервере, поэтому переживает F5.
    return `
      <div class="slice-promote">
        ${detailRow}
        <div class="slice-meta">${analysisChip} ${chip(`в очереди: ${esc(promotedTask.state)}`, "ok")}</div>
        <div class="slice-out">Задание: <code>${esc(promotedTask.title)}</code>
          — файл <code>${esc(promotedTask.onDeviceFile || "—")}</code></div>
        <button type="button" class="btn btn-sm" data-goto="scheduler">→ Перейти к очереди</button>
      </div>`;
  }

  const disabled = analysisReady ? "" : ' disabled title="Выходной файл не прошёл проверку анализа"';
  return `
    <div class="slice-promote">
      ${detailRow}
      <div class="slice-meta">${analysisChip}</div>
      ${outFindings}
      <button type="button" class="btn btn-primary btn-sm"
        data-slice-action="promote" data-id="${esc(v.id)}"${disabled}>＋ Добавить в очередь</button>
    </div>`;
}

/* ── Исполнение: подготовка файла → проверка → запуск ──────────
   Разделяем «запланировано», «файл готов» и «разрешено к запуску» явно —
   оператор не должен догадываться, на каком шаге стоит задание. */
export function executionHtml(state) {
  const rows = state.assignments || [];
  if (!rows.length) return "";
  const items = rows.map((row) => assignmentRow(state, row)).join("");
  return `<div class="slice-panel"><div class="slice-panel-head"><b>Исполнение</b></div>
    <ul class="slice-list" role="status" aria-live="polite">${items}</ul></div>`;
}

// Only VERIFIED is startable — every other state is shown as what it is, never
// as "probably ready". FAILED (the transfer died), INVALID (the bytes there are
// not the artifact's) and STALE (valid, for a job we would no longer print) are
// deliberately distinct: they tell the operator what to do next.
const DEVICE_STATE = {
  NOT_PRESENT: { label: "файла нет на принтере", cls: "warn" },
  UPLOADING: { label: "загрузка…", cls: "info", pulse: true },
  PRESENT_UNVERIFIED: { label: "файл есть, не сверен", cls: "warn" },
  VERIFIED: { label: "файл сверен", cls: "ok" },
  INVALID: { label: "файл на принтере не совпал", cls: "error" },
  FAILED: { label: "перенос не удался", cls: "error" },
  STALE: { label: "файл устарел — подготовьте заново", cls: "warn" }
};

function assignmentRow(state, row) {
  const a = row.assignment;
  const dev = row.deviceArtifact;
  const devState = dev ? DEVICE_STATE[dev.state] || { label: dev.state, cls: "info" } : null;

  const facts = [
    `Принтер: ${esc(printerName(state, a.printerId))}`,
    `Источник: ${a.source === "plan" ? "план" : a.source === "manual" ? "оператор" : "прямой запуск"}`,
    a.binding.expectedRemotePath ? `Файл: ${esc(a.binding.expectedRemotePath)}` : null,
    a.binding.material ? `Материал: ${esc(a.binding.material)}` : null,
    a.binding.nozzleMm != null ? `Сопло: ${a.binding.nozzleMm} мм` : null,
    a.binding.etaS != null ? `Время печати: ${fmtDuration(a.binding.etaS)}` : null
  ].filter(Boolean);

  const stale = a.invalidatedAt
    ? `<div class="slice-block">⛔ Назначение устарело${a.invalidatedReason ? `: ${esc(a.invalidatedReason)}` : ""}.
         Требуется перепланирование.</div>`
    : "";

  // Ручной перенос — единственный честный режим для адаптеров без загрузки:
  // показываем точный путь и требуем именное подтверждение.
  const manual =
    dev && dev.transferMode === "manual_file_transfer" && !row.fileReady
      ? `<div class="slice-block">Адаптер принтера не умеет загружать файлы. Скопируйте
           <code>${esc(dev.remotePath)}</code> на принтер вручную и подтвердите перенос.</div>`
      : "";

  const verification = dev && dev.verification
    ? `<span class="slice-tag">проверка: ${esc(dev.verification)}</span>`
    : "";

  let action = "";
  if (a.invalidatedAt) action = "";
  else if (row.nextAction === "prepare-file") {
    action = `<button type="button" class="btn btn-sm" data-slice-action="prepare-file" data-id="${esc(a.id)}">↑ Подготовить файл</button>`;
  } else if (row.nextAction === "confirm-file") {
    action = `<button type="button" class="btn btn-sm" data-slice-action="confirm-file" data-id="${esc(a.id)}">✓ Файл перенесён</button>`;
  } else if (row.nextAction === "start") {
    action = `<button type="button" class="btn btn-primary btn-sm" data-slice-action="start-assignment" data-id="${esc(a.id)}">▶ Запустить</button>`;
  }

  return `
    <li class="slice-item">
      <div class="slice-item-head">
        <span class="slice-name" title="Назначение ${esc(a.id)}">${esc(taskTitle(state, a.taskId))}</span>
        ${chip(esc(a.state), a.state === "ACTIVE" ? "ok" : "info")}
        ${devState ? chip(esc(devState.label), devState.cls, devState.pulse) : chip("файл не готовился", "warn")}
        ${verification}
        <span class="slice-spacer"></span>
        ${action}
      </div>
      <div class="slice-facts">${facts.map((f) => `<span>${f}</span>`).join("")}</div>
      ${manual}${stale}
      ${dev && dev.lastError ? `<div class="slice-block">⛔ ${esc(dev.lastError)}</div>` : ""}
    </li>`;
}

function taskTitle(state, id) {
  const t = (state.tasks || []).find((x) => x.id === id);
  return t ? t.title : shortId(id);
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} КБ`;
  return `${Math.round(bytes / (1024 * 104.8)) / 10} МБ`;
}

export function newSliceHtml(state) {
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
  const runtimeState = state.runtime?.runtime?.state;
  const runtimeLabel = (RUNTIME_STATE[runtimeState] || {}).label || "недоступен";
  const runtimeBlock = runtimeDown
    ? `<div class="slice-block" id="slice-runtime-block">⛔ OrcaSlicer: ${esc(runtimeLabel)} — запуск невозможен${runtimeMsg ? `: ${esc(runtimeMsg)}` : ""}.
         Восстановите среду (проверьте контейнер OrcaSlicer, затем ↻ Импорт пресетов) и повторите.</div>`
    : "";
  // Причина блокировки доступна скринридеру через aria-describedby, а не только title.
  const disabledAttr = runtimeDown
    ? ' disabled title="OrcaSlicer недоступен" aria-describedby="slice-runtime-block"'
    : "";

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

/* Дружелюбные имена вместо голых ID — из уже загруженного state. */
function setName(state, id) {
  const s = state.sets.find((x) => x.id === id);
  return s ? s.name : shortId(id);
}
function modelName(state, id) {
  const m = state.models.find((x) => x.artifact && x.artifact.id === id);
  return m && m.artifact ? m.artifact.name : shortId(id);
}
function printerName(state, id) {
  const cov = (state.runtime && state.runtime.coverage) || [];
  const c = cov.find((x) => x.printerId === id);
  return c ? c.printerName : id;
}

function fmtSize(size) {
  if (!Array.isArray(size)) return "—";
  return size.map((n) => Math.round(n * 10) / 10).join(" × ") + " мм";
}

function shortId(id) {
  return String(id).replace(/^slc_/, "").slice(0, 8);
}
