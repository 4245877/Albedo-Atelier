import { $, badge, esc, emptyRow, fmtLeft } from "../util.js";

/* ── Верхняя панель (статус сервиса / backend) ─────────────── */

export function renderTopbar(state, backendReachable) {
  const pillService = $("#pill-service");
  const pillBackend = $("#pill-backend");
  if (!pillService || !pillBackend) return;

  if (backendReachable && state) {
    pillBackend.className = "pill pill-ok";
    pillBackend.innerHTML = `<i class="dot"></i>Backend подключён`;
    const ok = state.service.status === "ok";
    pillService.className = `pill ${ok ? "pill-ok" : "pill-warn"}`;
    pillService.innerHTML = `<i class="dot dot-pulse"></i>${ok ? "Сервис работает" : "Сервис: внимание"}`;
  } else {
    pillBackend.className = "pill pill-danger";
    pillBackend.innerHTML = `<i class="dot"></i>Backend недоступен`;
    pillService.className = "pill pill-warn";
    pillService.innerHTML = `<i class="dot"></i>Нет данных`;
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

  const svcOk = state.service.status === "ok";
  const beOk = state.service.backend === "ok";
  $("#hero-pills").innerHTML = `
    <span class="pill ${svcOk ? "pill-ok" : "pill-danger"}"><i class="dot dot-pulse"></i>${svcOk ? "Порядок безупречен" : "Обнаружены отклонения"}</span>
    <span class="pill ${beOk ? "pill-ok" : "pill-danger"}"><i class="dot"></i>Backend: ${beOk ? "подключён" : "недоступен"}</span>
    <span class="pill pill-gold"><i class="dot"></i>${esc(state.service.version)}</span>`;
}

/* ── 2 · Очередь ───────────────────────────────────────────── */

function queueRow(job) {
  const cls = job.status === "error" ? "row-danger" : job.status === "review" ? "row-warn" : "";
  const st =
    job.status === "ready" ? `<span class="badge badge-idle">готово к запуску</span>` :
    job.status === "review" ? `<span class="badge badge-paused">требует проверки</span>` :
    `<span class="badge badge-error">ошибка</span>`;
  return `
    <li class="row ${cls}">
      <div class="grow">
        <div class="row-title">${esc(job.title)}</div>
        <div class="row-sub">${esc(job.printer)} · ${esc(job.material)} · ${esc(job.eta)}${job.reason ? ` — ${esc(job.reason)}` : ""}</div>
      </div>
      ${st}
    </li>`;
}

export function renderQueue(state) {
  const active = state.printers.filter((p) => p.status === "printing" || p.status === "paused");
  const next = state.queue.find((j) => j.status === "ready");
  $("#queue-meta").textContent = `${active.length} активных · ${state.queue.length} в очереди`;

  $("#queue-body").innerHTML = `
    <div class="queue-cols">
      <div>
        <p class="sub-head">Сейчас печатается <span class="count">${active.length}</span></p>
        <ul class="row-list">
          ${active.map((p) => `
            <li class="row">
              <div class="grow">
                <div class="row-title">${esc(p.job || "задание не определено")}</div>
                <div class="row-sub">${esc(p.name)} · осталось ${fmtLeft(p.minutesLeft)}</div>
                ${p.progress != null ? `<div class="progress ${p.status === "paused" ? "is-paused" : ""}" style="margin-top:7px"><i style="width:${p.progress}%"></i></div>` : ""}
              </div>
              <span class="row-time">${p.progress != null ? `${Math.round(p.progress)}%` : "—"}</span>
            </li>`).join("") || emptyRow("Нет активных печатей")}
        </ul>
      </div>
      <div>
        <p class="sub-head">Очередь <span class="count">${state.queue.length}</span></p>
        <ul class="row-list">${state.queue.map(queueRow).join("") || emptyRow("Очередь пуста")}</ul>
      </div>
    </div>
    ${next ? `
      <div class="next-job">
        <span class="star">❖</span>
        <div class="grow">
          <div class="row-title">Следующее задание: ${esc(next.title)}</div>
          <div class="row-sub">${esc(next.printer)} · старт в ${esc(next.at)} · ${esc(next.eta)}</div>
        </div>
        <button class="btn btn-sm btn-primary" data-act="start-next">Запустить</button>
      </div>` : ""}`;
}

/* ── 3 · Ночная печать ─────────────────────────────────────── */

export function renderNight(state) {
  const n = state.night;
  const c = n.candidates[n.pick];
  $("#night-window").textContent = `окно ${n.window}`;

  const reco = c ? `
    <div class="night-reco">
      <span class="night-lbl">Рекомендуемая деталь на ночь</span>
      <div class="night-part">${esc(c.title)}</div>
      <div class="night-part-sub">${esc(c.printer)} · ${esc(c.eta)} · впишется в окно печати</div>
      <div class="risk-meter">
        <div class="risk-track"><span class="risk-pin" style="left:${c.risk}%"></span></div>
        <div class="risk-caption">
          <span>Оценка риска: <span class="risk-value">${c.risk}% · ${esc(c.riskLabel)}</span></span>
          <span>цель &lt; 35%</span>
        </div>
      </div>
    </div>` : `
    <div class="night-reco">
      <span class="night-lbl">Рекомендуемая деталь на ночь</span>
      <div class="night-part-sub" style="margin-top:6px">Кандидатов нет — добавьте в очередь готовые задания (с принтером и файлом) или включите «Подсказки ночной печати» в разделе автоматизаций.</div>
    </div>`;

  $("#night-body").innerHTML = `
    ${reco}
    <div class="night-facts">
      <span class="badge">☾ окно: ${esc(n.window)}</span>
    </div>
    <div class="night-actions">
      <button class="btn btn-ghost" data-act="night-pick" ${c ? "" : "disabled"}>Подобрать задание на ночь</button>
      <button class="btn btn-primary" data-act="night-start" ${c ? "" : "disabled"}>☾ Запустить ночную печать</button>
    </div>`;
}

/* ── 5 · Критические события ───────────────────────────────── */

export function renderCritical(state) {
  $("#critical-meta").textContent = state.critical.length ? `${state.critical.length} сейчас` : "нарушений нет";
  $("#critical-body").innerHTML = `
    <ul class="row-list">
      ${state.critical.map((e) => `
        <li class="row ${e.level === "err" ? "row-danger" : "row-warn"}">
          <span class="row-icon">${esc(e.icon)}</span>
          <div class="grow"><div class="row-title" style="font-weight:600">${esc(e.text)}</div></div>
          <span class="row-time">${esc(e.time)}</span>
        </li>`).join("") || emptyRow("Критических событий нет — порядок соблюдён")}
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
        <div class="level mat-level ${lvl}"><i style="width:${(ratio * 100).toFixed(0)}%"></i></div>
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
    <ul class="row-list">${emptyRow("Остатки материалов неизвестны — учёт склада пока не подключён к backend")}</ul>`;

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
        <span class="row-icon">◈</span>
        <div class="grow">
          <div class="row-title">Несоответствие материала</div>
          <div class="row-sub">«${esc(m.job)}» требует ${esc(m.needs)}, в ${esc(m.printer)} заправлен ${esc(m.loaded)}</div>
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
        <div class="kv"><span class="k">Обслуживание</span><span class="v">${p.maintenance}</span></div>
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
      </div>`).join("") || `<ul class="row-list">${emptyRow("Правила автоматизации не настроены — движок автоматизаций ещё не подключён")}</ul>`}
    <div class="row">
      <span class="row-icon">✠</span>
      <div class="grow"><div class="row-sub">Последний запуск: <b>${esc(state.automationLastRun || "нет данных")}</b></div></div>
    </div>`;
}

/* ── 11 · Обслуживание ─────────────────────────────────────── */

export function renderMaintenance(state) {
  const rows = state.maintenance;
  if (!rows.length) {
    $("#maint-meta").textContent = "нет данных";
    $("#maint-body").innerHTML = `<ul class="row-list">${emptyRow("История обслуживания не ведётся — реальный учёт пока не подключён")}</ul>`;
    return;
  }
  const due = rows.filter((m) => m.due);
  $("#maint-meta").textContent = due.length ? `${due.length} требуют внимания` : "всё в порядке";
  $("#maint-body").innerHTML = `
    ${due.length ? `<div class="chip-line">${due.map((m) => `<span class="badge badge-paused">⚙ ${esc(m.p)}: пора обслужить</span>`).join("")}</div>` : ""}
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
const QUICK = [
  ["＋", "Добавить принтер", { act: "add-printer" }],
  ["▦", "Добавить задание", { act: "add-job" }],
  ["⇪", "Загрузить файл", { act: "upload-file" }],
  ["☰", "Открыть очередь", { goto: "queue" }],
  ["☾", "Ночная печать", { goto: "night" }],
  ["◉", "Камеры", { goto: "cameras" }],
  ["◈", "Материалы", { goto: "materials" }],
  ["⚙", "Настройки", { act: "settings" }],
];

export function renderQuick() {
  $("#actions-body").innerHTML = QUICK
    .map(([i, l, target]) => {
      const attr = target.goto
        ? `data-goto="${esc(target.goto)}"`
        : `data-act="${esc(target.act)}"`;
      return `<button class="quick" ${attr}><span class="q-icon">${i}</span>${l}</button>`;
    })
    .join("");
}

/* ── 13 · Система ──────────────────────────────────────────── */

export function renderSystem(state) {
  const warn = state.system.filter((s) => s.ok !== "ok").length;
  $("#system-meta").textContent = warn ? `${warn} предупреждения` : "все компоненты в норме";
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

export function renderFeed(state) {
  $("#feed-body").innerHTML = `
    <ul class="feed-list">
      ${state.feed.slice(0, 8).map((e) => `
        <li class="feed-item f-${e.kind}">
          <div class="feed-text">${esc(e.icon)} ${esc(e.text)}</div>
          <div class="feed-time">${esc(e.time)}</div>
        </li>`).join("") || `<li class="feed-item f-info"><div class="feed-text">Событий пока нет — лента заполняется реальными переходами статусов принтеров</div></li>`}
    </ul>`;
}

/* ── 15 · Предупреждения ───────────────────────────────────── */

export function renderWarnings(state) {
  $("#warnings-meta").textContent = state.warnings.length
    ? `${state.warnings.length} требуют внимания`
    : "всё под контролем";
  $("#warnings-body").innerHTML = `
    <ul class="row-list">
      ${state.warnings.map((w) => `
        <li class="row ${w.level === "err" ? "row-danger" : w.level === "warn" ? "row-warn" : ""}">
          <span class="row-icon">${esc(w.icon)}</span>
          <div class="grow">
            <div class="row-title" style="font-weight:600">${esc(w.text)}</div>
            <div class="row-sub">${esc(w.hint)}</div>
          </div>
        </li>`).join("") || emptyRow("Предупреждений нет")}
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
        <div class="row-title">Следующая печать: ${esc(pl.next.title)}</div>
        <div class="row-sub">${esc(pl.next.printer)}</div>
      </div>
    </div>` : `
    <ul class="row-list">${emptyRow("Следующая печать не запланирована — планировщик пока не подключён, задания запускаются вручную")}</ul>`;

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
        ${pl.manual.map((m) => `<li class="row row-warn"><span class="row-icon">✎</span><div class="grow row-sub" style="color:var(--ink)">${esc(m)}</div></li>`).join("")}
      </ul>
    </div>` : "";

  $("#plan-body").innerHTML = `
    ${nextBlock}
    ${upcomingBlock}
    ${pl.nightReady ? `<div class="chip-line"><span class="badge badge-amethyst">☾ На ночь: ${esc(pl.nightReady)}</span></div>` : ""}
    ${manualBlock}`;
}
