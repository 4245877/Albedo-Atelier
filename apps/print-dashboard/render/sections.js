import { $, esc, emptyRow, emptyState } from "../util.js";
import { badge } from "../shared/chips.js";
import { fmtLeft } from "../shared/format.js";
import { icon } from "../shared/icons.js";
import { isBusy, progressBarHtml, progressPercentText } from "./printerView.js";

/* ── Верхняя панель (статус сервиса / backend) ─────────────── */

export function renderTopbar(state, backendReachable) {
  const pillService = $("#pill-service");
  const pillBackend = $("#pill-backend");
  if (!pillService || !pillBackend) return;

  // Подпись пилюли живёт в .pill-txt: на телефоне CSS прячет именно её, оставляя
  // цветную точку-индикатор, — шапка перестаёт занимать три ряда.
  if (backendReachable && state) {
    pillBackend.className = "pill pill-ok";
    pillBackend.innerHTML = `<i class="dot"></i><span class="pill-txt">Backend подключён</span>`;
    pillBackend.title = "Backend подключён";
    const ok = state.service.status === "ok";
    pillService.className = `pill ${ok ? "pill-ok" : "pill-warn"}`;
    const label = ok ? "Служба безупречна" : "Сервис: требует внимания";
    pillService.innerHTML = `<i class="dot dot-pulse"></i><span class="pill-txt">${label}</span>`;
    pillService.title = label;
  } else {
    pillBackend.className = "pill pill-danger";
    pillBackend.innerHTML = `<i class="dot"></i><span class="pill-txt">Backend безмолвствует</span>`;
    pillBackend.title = "Backend безмолвствует";
    pillService.className = "pill pill-warn";
    pillService.innerHTML = `<i class="dot"></i><span class="pill-txt">Нет вестей</span>`;
    pillService.title = "Нет вестей";
  }
}

/* ── 1 · Hero ──────────────────────────────────────────────── */

export function renderHero(state) {
  const p = state.printers;
  const count = (fn) => p.filter(fn).length;
  const tiles = [
    { n: p.length, l: "всего принтеров", tone: "" },
    { n: count((x) => x.status === "printing"), l: "активные", tone: "tone-gold" },
    { n: count((x) => x.status === "offline"), l: "offline", tone: "tone-offline" },
    { n: count((x) => x.status === "error"), l: "с ошибкой", tone: "tone-danger" },
    { n: count((x) => x.type === "FDM"), l: "FDM", tone: "" },
    { n: count((x) => x.type === "Resin"), l: "Resin", tone: "" },
  ];
  $("#hero-stats").innerHTML = tiles
    .map((t) => `<div class="stat-tile ${t.tone}"><span class="num">${t.n}</span><span class="lbl">${t.l}</span></div>`)
    .join("");

  // Пилюли «Backend» здесь нет: сам факт полученного payload уже означает, что
  // backend доступен (реальную недоступность показывают renderTopbar и
  // renderBackendError по результату запроса, а не по полю из ответа).
  const svcOk = state.service.status === "ok";
  $("#hero-pills").innerHTML = `
    <span class="pill ${svcOk ? "pill-ok" : "pill-danger"}"><i class="dot dot-pulse"></i>${svcOk ? "Порядок безупречен" : "Замечены отклонения — я уже занимаюсь ими"}</span>
    <span class="pill pill-gold"><i class="dot"></i>${esc(state.service.version)}</span>`;
}

/* ── 2 · Очередь ───────────────────────────────────────────── */

/**
 * Итоговое состояние задания очереди.
 *
 * ПРАВИЛО, ради которого функция существует: видимый статус объекта
 * определяется САМЫМ СЕРЬЁЗНЫМ его актуальным состоянием.
 *
 * Раньше строка очереди читала только `job.status`. Задание, у которого
 * `status: "ready"` и при этом `reason: "MicroSD не отвечает — файл не удалось
 * записать"`, показывалось зелёным «готово к запуску», причина уходила в
 * приглушённую подпись через тире, а рядом стояла заметная кнопка запуска.
 * Оператор видел зелёное «готово» и жал «Запустить» — запуск был невозможен
 * с самого начала. Это худший вид ошибки интерфейса: он не путает, а
 * дезинформирует.
 *
 * Теперь наличие блокирующей причины ПЕРЕВЕШИВАЕТ «ready», причина выносится
 * отдельной заметной строкой, а действие меняется с «Запустить» на
 * «Разобраться» — то есть на то, что действительно можно сделать.
 *
 * @returns {{key:string,label:string,badge:string,row:string,blocked:boolean,
 *            reason:string,actionLabel:string}}
 */
export function queueJobStatus(job) {
  const reason = typeof job.reason === "string" ? job.reason.trim() : "";

  if (job.status === "unconfirmed") {
    return {
      key: "unconfirmed",
      label: "запуск не подтверждён",
      badge: "badge-amethyst",
      row: "row-warn",
      blocked: true,
      reason: reason || "Прошлая попытка запуска осталась без ответа принтера",
      actionLabel: "Разобраться с запуском"
    };
  }

  // «Готово» с блокирующей причиной готовым не является.
  if (reason) {
    return {
      key: job.status === "review" ? "review" : "blocked",
      label: job.status === "review" ? "требует проверки" : "требует внимания",
      badge: job.status === "review" ? "badge-paused" : "badge-blocked",
      row: job.status === "review" ? "row-warn" : "row-blocked",
      blocked: true,
      reason,
      actionLabel: "Разобраться"
    };
  }

  if (job.status === "review") {
    return {
      key: "review",
      label: "требует проверки",
      badge: "badge-paused",
      row: "row-warn",
      blocked: true,
      reason: "Задание ещё не готово к запуску",
      actionLabel: "Разобраться"
    };
  }

  return {
    key: "ready", label: "готово к запуску", badge: "badge-idle",
    row: "", blocked: false, reason: "", actionLabel: "Запустить печать"
  };
}

/* Строка очереди. Статусы: ready / review / unconfirmed (legacy "error"
   нормализуется в review на backend и до фронта не доходит).

   Блокирующая причина — СВОЯ строка с собственным знаком, а не хвост
   приглушённой подписи: подпись читают последней, а причина отказа обязана
   попадаться на глаза первой. */
export function queueRow(job, printers) {
  const st = queueJobStatus(job);
  // Кнопка есть у всего, что требует вмешательства, и ведёт в одно и то же
  // окно запуска: разрешение проблемы живёт там, где оператор в неё упирается.
  const action = st.blocked
    ? `<button class="btn btn-sm" data-act="launch" data-task="${esc(job.id)}">${esc(st.actionLabel)}</button>`
    : "";
  return `
    <li class="row ${st.row}">
      <div class="grow">
        <div class="row-title">${esc(queueJobTitle(job))}</div>
        <div class="row-sub">${esc(queueJobSubtitle(job, printers))}</div>
        ${st.reason ? `<p class="row-reason">${icon(st.key === "blocked" ? "blocked" : "warn")}<span>${esc(st.reason)}</span></p>` : ""}
      </div>
      <span class="badge ${st.badge}">${esc(st.label)}</span>
      ${action}
    </li>`;
}

/** «3U-default.3mf» → «3U-default»: оператор назвал модель, а не контейнер. */
export function queueJobTitle(job) {
  return String(job.title || "").replace(/\.(gcode\.3mf|3mf|stl|gcode|gco|g)$/i, "");
}

/**
 * Подпись строки очереди: имя принтера (а не его id), материал, сопло, время.
 *
 * Пропускаем то, чего действительно нет, вместо «— · —»: раньше подпись
 * склеивалась из трёх полей безусловно, и полностью проанализированное задание
 * (PETG, 0.4 мм, 1 ч 29 мин) выглядело как задание без данных.
 */
export function queueJobSubtitle(job, printers) {
  const parts = [];
  const printer = (printers || []).find((p) => p.id === job.printer);
  if (printer) parts.push(printer.name);
  else if (job.printer && job.printer !== "—") parts.push(job.printer);
  if (job.material && job.material !== "—") parts.push(job.material);
  if (job.nozzleMm != null) parts.push(`${job.nozzleMm} мм`);
  if (job.eta && job.eta !== "—") parts.push(job.eta);
  if (job.filamentG != null) parts.push(`≈ ${Math.round(job.filamentG)} г`);
  return parts.join(" · ") || "данные готовятся";
}

export function renderQueue(state) {
  const active = state.printers.filter(isBusy);
  // Главной кнопкой раздела становится только ДЕЙСТВИТЕЛЬНО запускаемое
  // задание: у «ready» с блокирующей причиной запуск невозможен, и предлагать
  // его крупной золотой кнопкой — то же самое враньё, что и зелёный статус.
  const next = state.queue.find((j) => !queueJobStatus(j).blocked);
  $("#queue-meta").textContent = `${active.length} активных · ${state.queue.length} в очереди`;

  $("#queue-body").innerHTML = `
    <div class="queue-cols">
      <div>
        <p class="sub-head">Сейчас печатается <span class="count">${active.length}</span></p>
        <ul class="row-list">
          ${active.map((p) => `
            <li class="row">
              <div class="grow">
                <div class="row-title">${esc(p.job || "задание не названо")}</div>
                <div class="row-sub">${esc(p.name)} · осталось ${fmtLeft(p.minutesLeft)}</div>
                ${progressBarHtml(p.progress, { paused: p.status === "paused", style: "margin-top:7px" })}
              </div>
              <span class="row-time">${progressPercentText(p.progress)}</span>
            </li>`).join("") || emptyRow("Ни один принтер не трудится — все смиренно ожидают вашей воли")}
        </ul>
      </div>
      <div>
        <p class="sub-head">Очередь <span class="count">${state.queue.length}</span></p>
        <ul class="row-list">${state.queue.map((j) => queueRow(j, state.printers)).join("") || emptyRow("Очередь пуста — Назарик ожидает ваших повелений")}</ul>
      </div>
    </div>
    ${next ? nextJobCard(next, state.printers) : ""}`;
}

/**
 * Карточка ближайшего задания — единственная главная кнопка раздела.
 *
 * «Запустить» открывает окно запуска, а не отправляет команду сразу: проверку
 * готовности, выбор принтера и физические подтверждения показывает backend
 * (GET /api/print/launch/:taskId), и до открытия окна здесь про них ничего не
 * известно. Кнопка НЕ ведёт в файловый браузер и не требует, чтобы оператор
 * сам нашёл подготовленный пакет на принтере, — это и была прежняя поломка.
 */
function nextJobCard(next, printers) {
  return `
    <div class="next-job">
      <span class="star" aria-hidden="true">${icon("sigilFilled", { cls: "ico-md" })}</span>
      <div class="grow">
        <p class="next-job-lbl">Ближайшее к запуску</p>
        <div class="row-title">${esc(queueJobTitle(next))}</div>
        <div class="row-sub">${esc(queueJobSubtitle(next, printers))}</div>
      </div>
      <button class="btn btn-primary" data-act="launch" data-task="${esc(next.id)}">
        ${icon("play")}<span>Запустить печать</span>
      </button>
    </div>`;
}

/* ── 3 · Ночная печать ─────────────────────────────────────── */

export function renderNight(state) {
  const n = state.night;
  const c = n.candidates[n.pick];
  // Кандидат запускаем только без блокеров: backend перечисляет конкретные
  // причины (нет файла, неизвестная длительность, материал не совпадает, …) и
  // сам откажет в night/start — UI не обещает «впишется в окно» и не
  // подсовывает активную кнопку, когда запуск заведомо невозможен.
  const blockers = c?.blockers || [];
  const startable = Boolean(c) && blockers.length === 0;
  $("#night-window").textContent = `окно ${n.window}`;

  const blockersBlock = c && !startable ? `
      <div class="night-blockers">
        <p class="night-blockers-head">${icon("blocked")}<span>Я не позволю этому запуску состояться</span></p>
        <ul>${blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
      </div>` : "";

  const reco = c ? `
    <div class="night-reco">
      <span class="night-lbl">Деталь, избранная мною на ночь</span>
      <div class="night-part">${esc(c.title)}</div>
      <div class="night-part-sub">${esc(c.printer)} · ${esc(c.eta)}${startable ? " · впишется в окно печати" : ""}</div>
      ${blockersBlock}
      <div class="risk-meter">
        <div class="risk-track"><span class="risk-pin" style="transform:translateX(-${(100 - c.risk).toFixed(1)}%)"></span></div>
        <div class="risk-caption">
          <span>Оценка риска: <span class="risk-value">${c.risk}% · ${esc(c.riskLabel)}</span></span>
          <span>цель &lt; 35%</span>
        </div>
      </div>
    </div>` : `
    <div class="night-reco">
      <span class="night-lbl">Деталь, избранная мною на ночь</span>
      <div class="night-part-sub" style="margin-top:6px">Достойных кандидатов нет, Владыка — добавьте в очередь готовые задания (с принтером и файлом) или включите «Подсказки ночной печати» в разделе автоматизаций, и я изберу лучшее.</div>
    </div>`;

  // Запуск недоступен — кнопка называет причину: погашенная кнопка без
  // объяснения неотличима от сломанной.
  const startTitle = startable
    ? ""
    : c
      ? ` title="${esc(`Запуск невозможен: ${blockers.join("; ")}`)}"`
      : ' title="Кандидат на ночь ещё не избран"';

  $("#night-body").innerHTML = `
    ${reco}
    <div class="night-facts">
      <span class="badge">${icon("moon")}<span>окно: ${esc(n.window)}</span></span>
    </div>
    <div class="night-actions">
      <button class="btn btn-primary" data-act="night-start"${startTitle} ${startable ? "" : "disabled"}>${icon("moon")}<span>Запустить ночную печать</span></button>
      <button class="btn btn-ghost" data-act="night-pick" ${c ? "" : "disabled"}>Подобрать другое задание</button>
    </div>`;
}

/* ── 5 · Критические события ───────────────────────────────── */

export function renderCritical(state) {
  $("#critical-meta").textContent = state.critical.length ? `${state.critical.length} сейчас` : "нарушений не допущено";
  $("#critical-body").innerHTML = `
    <ul class="row-list">
      ${state.critical.map((e) => `
        <li class="row ${e.level === "err" ? "row-danger" : "row-warn"}">
          <span class="row-icon ${e.level === "err" ? "row-icon-danger" : "row-icon-warn"}">${icon(e.level === "err" ? "blocked" : "warn")}</span>
          <div class="grow"><div class="row-title row-title-plain">${esc(e.text)}</div></div>
          <span class="row-time">${esc(e.time)}</span>
        </li>`).join("") || emptyRow("Критических событий нет — в зале царит безупречный порядок, как и подобает", { glyph: "shield" })}
    </ul>`;
}

/* ── 6 · Материалы ─────────────────────────────────────────── */

function matItem(m) {
  // full может быть 0/undefined (учёт неизвестен) — тогда не считаем уровень,
  // чтобы не показать пустую полосу как «критический» остаток и не получить NaN.
  const full = Number(m.full) > 0 ? Number(m.full) : 0;
  const ratio = full ? Math.min(1, Math.max(0, m.have / full)) : 0;
  const lvl = full ? (ratio < 0.18 ? "crit" : ratio < 0.4 ? "low" : "") : "";
  return `
    <div class="mat-item ${m.low ? "mat-low" : ""}">
      <div class="grow">
        <div class="mat-name"><span class="swatch" style="background:${esc(m.swatch)}"></span>${esc(m.name)}</div>
        <div class="level mat-level ${lvl}"><i style="transform:scaleX(${ratio.toFixed(2)})"></i></div>
      </div>
      <span class="mat-qty">${esc(m.have)} ${esc(m.unit)}${m.need ? ` / нужно ${esc(m.need)}` : ""}</span>
    </div>`;
}

export function renderMaterials(state) {
  const mats = state.materials;
  const hasStock = mats.filament.length > 0 || mats.resin.length > 0;
  const low = [...mats.filament, ...mats.resin].filter((m) => m.low);
  $("#materials-meta").textContent = hasStock ? `${low.length} заканчиваются` : "учёт не подключён";

  const perPrinter = state.printers
    .map((p) => `<span class="badge badge-plain">${p.swatch ? `<span class="swatch" style="background:${esc(p.swatch)};width:9px;height:9px"></span>` : ""}${esc(p.name)}: ${esc(p.material || "не указан")}</span>`)
    .join("") || `<span class="badge badge-plain">нет настроенных принтеров</span>`;

  const stockBlock = hasStock ? `
    <div class="mat-cols">
      <div><p class="sub-head">Филамент</p>${mats.filament.map(matItem).join("")}</div>
      <div><p class="sub-head">Смола</p>${mats.resin.map(matItem).join("")}</div>
    </div>` : `
    <ul class="row-list">${emptyRow("Остатки материалов мне пока неведомы — учёт склада ещё не подключён к backend")}</ul>`;

  const needsBlock = (mats.queueNeeds || []).length ? `
    <div>
      <p class="sub-head">Нужно для очереди</p>
      <div class="chip-line">
        ${mats.queueNeeds.map((q) => `<span class="badge ${q.status === "ok" ? "badge-idle" : "badge-paused"}">${esc(q.text)}</span>`).join("")}
      </div>
    </div>` : "";

  $("#materials-body").innerHTML = `
    ${stockBlock}
    ${needsBlock}
    <div>
      <p class="sub-head">В принтерах (по конфигурации)</p>
      <div class="chip-line">${perPrinter}</div>
    </div>
    ${mats.mismatch.map((m) => `
      <div class="row row-danger">
        <span class="row-icon row-icon-danger">${icon("material")}</span>
        <div class="grow">
          <div class="row-title">Несоответствие материала — недопустимо</div>
          <div class="row-sub">«${esc(m.job)}» требует ${esc(m.needs)}, но в ${esc(m.printer)} заправлен ${esc(m.loaded)}</div>
        </div>
      </div>`).join("")}`;
}

/* ── 7 · Сегодня ───────────────────────────────────────────── */

export function renderToday(state) {
  const t = state.today;
  const d = new Date();
  $("#today-date").textContent = d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
  // done/failed — реально замеченные backend'ом переходы; null-поля неизвестны.
  const tiles = [
    { n: t.done, l: "завершено (с запуска)", tone: "tone-ok" },
    { n: t.active, l: "выполняется", tone: "tone-gold" },
    { n: t.failed, l: "с ошибкой (с запуска)", tone: "tone-danger" },
    { n: t.hoursUsed != null ? `${t.hoursUsed} ч` : "—", l: "часов печати", tone: "" },
    { n: t.hoursQueued != null ? `≈${t.hoursQueued} ч` : "—", l: "осталось в очереди", tone: "" },
  ];
  $("#today-body").innerHTML = tiles
    .map((x) => `<div class="stat-tile ${x.tone}"><span class="num">${x.n}</span><span class="lbl">${x.l}</span></div>`)
    .join("");
}

/* ── 8 · Производительность ────────────────────────────────── */

export function renderPerf(state) {
  const p = state.perf;
  const R = 46, C = 2 * Math.PI * R;
  const load = p.load != null ? p.load : 0;
  $("#perf-body").innerHTML = `
    <div class="perf-load">
      <div class="gauge" role="img" aria-label="Загрузка фермы ${p.load != null ? `${p.load}%` : "неизвестна"}">
        <svg viewBox="0 0 108 108">
          <circle class="track" cx="54" cy="54" r="${R}" fill="none" stroke-width="9"/>
          <circle class="fill" cx="54" cy="54" r="${R}" fill="none" stroke-width="9"
            stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - load / 100)}"/>
        </svg>
        <span class="gauge-num">${p.load != null ? `${p.load}%` : "—"}</span>
      </div>
      <div class="perf-side">
        <div class="kv"><span class="k">Свободны</span><span class="v">${p.free}</span></div>
        <div class="kv"><span class="k">Заняты</span><span class="v">${p.busy}</span></div>
        <div class="kv"><span class="k">Среднее время печати</span><span class="v">${p.avgPrint != null ? esc(p.avgPrint) : "нет данных"}</span></div>
        <div class="kv"><span class="k">Успешных печатей</span><span class="v" ${p.successRate != null ? 'style="color:var(--ok)"' : ""}>${p.successRate != null ? `${p.successRate}%` : "нет данных"}</span></div>
      </div>
    </div>`;
}

/* ── 9 · Автоматизации ─────────────────────────────────────── */

export function renderAutomations(state) {
  const on = state.automations.filter((a) => a.on).length;
  $("#auto-meta").textContent = state.automations.length
    ? `${on} из ${state.automations.length} активны`
    : "не настроены";
  $("#auto-body").innerHTML = `
    ${state.automations.map((a) => `
      <div class="rule">
        <button class="toggle ${a.on ? "on" : ""}" data-act="rule" data-id="${a.id}"
          role="switch" aria-checked="${a.on}" aria-label="${esc(a.name)}"></button>
        <div class="grow">
          <div class="row-title">${esc(a.name)}</div>
          <div class="row-sub">${esc(a.desc)}</div>
        </div>
      </div>`).join("") || `<ul class="row-list">${emptyRow("Правила автоматизации ещё не установлены — движок автоматизаций пока не подключён, Владыка")}</ul>`}
    <div class="row">
      <span class="row-icon">${icon("clock")}</span>
      <div class="grow"><div class="row-sub">Последний запуск: <b>${esc(state.automationLastRun || "нет данных")}</b></div></div>
    </div>`;
}

/* ── 11 · Обслуживание ─────────────────────────────────────── */

export function renderMaintenance(state) {
  const rows = state.maintenance;
  if (!rows.length) {
    $("#maint-meta").textContent = "нет данных";
    $("#maint-body").innerHTML = `<ul class="row-list">${emptyRow("Летопись обслуживания ещё не ведётся — реальный учёт пока не подключён")}</ul>`;
    return;
  }
  const due = rows.filter((m) => m.due);
  $("#maint-meta").textContent = due.length ? `${due.length} требуют внимания` : "всё содержится безупречно";
  $("#maint-body").innerHTML = `
    ${due.length ? `<div class="chip-line">${due.map((m) => `<span class="badge badge-paused">${icon("gear")}<span>${esc(m.p)}: пора обслужить</span></span>`).join("")}</div>` : ""}
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th>Принтер</th><th>Чистка</th><th>Сопло</th><th>FEP-плёнка</th><th>Калибровка</th><th>Успешная печать</th>
        </tr></thead>
        <tbody>
          ${rows.map((m) => `
            <tr>
              <td><b>${esc(m.p)}</b></td>
              <td class="${m.due ? "td-due" : "td-ok"}">${esc(m.clean)}</td>
              <td class="${m.due ? "td-due" : "td-ok"}">${esc(m.nozzle)}</td>
              <td class="td-ok">${esc(m.fep)}</td>
              <td class="td-ok">${esc(m.calib)}</td>
              <td class="td-ok">${esc(m.success)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

/* ── 12 · Быстрые действия ─────────────────────────────────── */

// Каждое быстрое действие ведёт к реальному результату: форма (data-act),
// справочное окно (data-act) или прокрутка к существующей секции (data-goto).
/* Быстрые действия — только то, что ЗАПУСКАЕТ работу. Переходы между
   разделами теперь делает навигация режимов, и дублировать её плиткой
   «Открыть очередь» больше незачем. */
const QUICK = [
  ["queue", "Добавить задание", { act: "add-job" }],
  ["upload", "Загрузить файл", { goto: "uploads" }],
  ["printer", "Принять принтер", { goto: "hardware" }],
  ["gear", "Настройки", { act: "settings" }],
];

export function renderQuick() {
  $("#actions-body").innerHTML = QUICK
    .map(([ico, label, target]) => {
      const attr = target.goto
        ? `data-goto="${esc(target.goto)}"`
        : `data-act="${esc(target.act)}"`;
      return `<button type="button" class="quick" ${attr}><span class="q-icon">${icon(ico)}</span><span>${esc(label)}</span></button>`;
    })
    .join("");
}

/* ── 13 · Система ──────────────────────────────────────────── */

export function renderSystem(state) {
  const warn = state.system.filter((s) => s.ok !== "ok").length;
  $("#system-meta").textContent = warn ? `${warn} предупреждения` : "все компоненты несут службу исправно";
  $("#system-body").innerHTML = `
    <div class="sys-grid">
      ${state.system.map((s) => `
        <div class="sys sys-${s.ok === "ok" ? "ok" : s.ok === "warn" ? "warn" : "err"}">
          <i class="dot"></i>
          <div><div class="s-name">${esc(s.name)}</div><div class="s-val">${esc(s.val)}</div></div>
        </div>`).join("")}
    </div>`;
}

/* ── 14 · Лента событий ────────────────────────────────────── */

/* Текст события: backend выделяет имена принтеров тегом <b> (см. events.push в
   commandService). Экранируем всё, затем возвращаем ТОЛЬКО <b>/</b> — жирность
   работает, а любая другая разметка в именах заданий остаётся текстом. */
const feedText = (s) => esc(s).replace(/&lt;(\/?)b&gt;/g, "<$1b>");

export function renderFeed(state) {
  $("#feed-body").innerHTML = `
    <ul class="feed-list">
      ${state.feed.slice(0, 8).map((e) => `
        <li class="feed-item f-${esc(e.kind)}">
          <div class="feed-text">${feedText(e.text)}</div>
          <div class="feed-time">${esc(e.time)}</div>
        </li>`).join("") || `<li class="feed-item f-info"><div class="feed-text">Хроника пока чиста — я заношу сюда каждый реальный переход статусов принтеров</div></li>`}
    </ul>`;
}

/* ── 15 · Предупреждения ───────────────────────────────────── */

/* ── Куда ведёт предупреждение ─────────────────────────────────
   Важное предупреждение обязано объяснять и проблему, и путь решения.
   «Автоматика остановлена из-за отсутствия расписания» маленькой янтарной
   подписью — это сообщение о том, что ферма стоит, поданное как примечание.

   Текст предупреждений приходит с backend в свободной форме, поэтому здесь —
   БЕЗ ПРЕТЕНЗИЙ на полноту — сопоставление знакомых формулировок с разделом,
   где это чинится. Не нашли соответствия — просто не показываем кнопку;
   выдумывать переход, который никуда не ведёт, хуже, чем его отсутствие. */
const WARNING_ROUTES = [
  [/расписан|таймзон|часов[оы]|оператор|присмотр/i, { label: "Задать расписание", goto: "operations" }],
  [/материал|филамент|катушк|смол|заканчива/i, { label: "К материалам", goto: "materials" }],
  [/камер|snapshoturl|streamurl|поток/i, { label: "Настроить камеру", goto: "hardware" }],
  [/принтер|подключ|адрес|код доступа|учётн/i, { label: "К оборудованию", goto: "hardware" }],
  [/слайс|профил|orca/i, { label: "К слайсингу", goto: "slicing" }],
  [/очеред|задани/i, { label: "К очереди", goto: "queue" }],
];

export function warningRoute(w) {
  const haystack = `${w?.text || ""} ${w?.hint || ""}`;
  for (const [re, route] of WARNING_ROUTES) if (re.test(haystack)) return route;
  return null;
}

export function renderWarnings(state) {
  $("#warnings-meta").textContent = state.warnings.length
    ? `${state.warnings.length} требуют внимания`
    : "всё под моим контролем";
  $("#warnings-body").innerHTML = `
    <ul class="row-list">
      ${state.warnings.map((w) => {
        const err = w.level === "err";
        const route = warningRoute(w);
        return `
        <li class="row row-action ${err ? "row-danger" : w.level === "warn" ? "row-warn" : ""}">
          <span class="row-icon ${err ? "row-icon-danger" : "row-icon-warn"}">${icon(err ? "blocked" : "warn")}</span>
          <div class="grow">
            <div class="row-title row-title-plain">${esc(w.text)}</div>
            <div class="row-sub">${esc(w.hint)}</div>
          </div>
          ${route ? `<button type="button" class="btn btn-sm" data-goto="${esc(route.goto)}">${esc(route.label)}</button>` : ""}
        </li>`;
      }).join("") || emptyRow("Предупреждений нет — ничто не смеет тревожить ваш покой, Владыка", { glyph: "shield" })}
    </ul>`;
}

/* ── 16 · План ─────────────────────────────────────────────── */

export function renderPlan(state) {
  const pl = state.plan;
  $("#plan-meta").textContent = pl.queueEta ? `очередь завершится ${pl.queueEta}` : "план не рассчитан";

  const nextBlock = pl.next ? `
    <div class="plan-next">
      <span class="when">${esc(pl.next.at)}</span>
      <div class="grow">
        <div class="row-title">Следующей печатью станет: ${esc(pl.next.title)}</div>
        <div class="row-sub">${esc(pl.next.printer)}</div>
      </div>
    </div>` : `
    <ul class="row-list">${emptyRow("Следующая печать не назначена — планировщик пока не подключён, задания запускаются вашей рукой")}</ul>`;

  const upcomingBlock = pl.upcoming.length ? `
    <div>
      <p class="sub-head">Следующие задания</p>
      <ul class="row-list">
        ${pl.upcoming.map((u) => `
          <li class="row">
            <div class="grow"><div class="row-title" style="font-weight:600">${esc(u.title)}</div>
            <div class="row-sub">${esc(u.printer)}</div></div>
            <span class="row-time">${esc(u.at)}</span>
          </li>`).join("")}
      </ul>
    </div>` : "";

  const manualBlock = pl.manual.length ? `
    <div>
      <p class="sub-head">Требует ручной подготовки</p>
      <ul class="row-list">
        ${pl.manual.map((m) => `<li class="row row-warn"><span class="row-icon row-icon-warn">${icon("pencil")}</span><div class="grow row-sub row-sub-strong">${esc(m)}</div></li>`).join("")}
      </ul>
    </div>` : "";

  $("#plan-body").innerHTML = `
    ${nextBlock}
    ${upcomingBlock}
    ${pl.nightReady ? `<div class="chip-line"><span class="badge badge-amethyst">${icon("moon")}<span>На ночь: ${esc(pl.nightReady)}</span></span></div>` : ""}
    ${manualBlock}`;
}
