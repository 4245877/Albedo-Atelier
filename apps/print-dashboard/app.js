/* ═══════════════════════════════════════════════════════════════
   Albedo Atelier — главная панель (front-end)
   Данные приходят с backend (print-orchestrator) через nginx-прокси
   /api/print-orchestrator/*. Состояние загружается из GET /api/dashboard,
   действия отправляются POST-запросами, панель периодически обновляется.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* Backend доступен по тому же origin: nginx отдаёт эту страницу и
   проксирует /api/print-orchestrator/* в сервис print-orchestrator. */
const API_BASE = "/api/print-orchestrator";

/* Состояние фермы — заполняется из GET /api/dashboard. До первой удачной
   загрузки равно null. */
let state = null;
let backendReachable = false;
let everLoaded = false;
let revealed = false;
/* Снимок последних отрисованных данных: если новый ответ идентичен,
   DOM не пересобираем (камеры не мигают, нет лишних перекачек кадров). */
let lastRenderedJson = null;

/* ── Клиент API ────────────────────────────────────────────── */

async function apiError(res) {
  const body = await res.json().catch(() => null);
  const message = body?.error?.message || `HTTP ${res.status}`;
  const err = new Error(message);
  err.code = body?.error?.code;
  return err;
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

async function apiPost(path, body) {
  const opts = { method: "POST", headers: { Accept: "application/json" } };
  // Отправляем тело (и Content-Type) только когда оно есть — иначе Fastify
  // отвергнет пустое тело при заявленном application/json.
  if (body !== undefined && body !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) throw await apiError(res);
  return res.json().catch(() => ({}));
}

/* ── Утилиты ───────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtLeft(min) {
  if (!min || min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} ч ${String(m).padStart(2, "0")} м` : `${m} м`;
}

const STATUS = {
  printing: { label: "печатает", badge: "badge-printing", pulse: true },
  idle: { label: "готов", badge: "badge-idle" },
  paused: { label: "пауза", badge: "badge-paused" },
  error: { label: "ошибка", badge: "badge-error", pulse: true },
  offline: { label: "offline", badge: "badge-offline" },
  maintenance: { label: "обслуживание", badge: "badge-maint" },
  unknown: { label: "неизвестно", badge: "badge-offline" },
};

function badge(status) {
  const s = STATUS[status] || STATUS.unknown;
  return `<span class="badge ${s.badge}"><i class="dot${s.pulse ? " dot-pulse" : ""}"></i>${s.label}</span>`;
}

/** Пустое состояние секции: данных реально нет — не подставляем выдуманные. */
function emptyRow(text) {
  return `<li class="row"><div class="grow row-sub">${esc(text)}</div></li>`;
}

/* ── Тосты ─────────────────────────────────────────────────── */

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="star">✦</span><span>${msg}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 3400);
}

/* ── Верхняя панель (статус сервиса / backend) ─────────────── */

function renderTopbar() {
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

/* ── Навигация по секциям ──────────────────────────────────── */

const NAV = [
  ["summary", "Статус"], ["queue", "Очередь"], ["night", "Ночь"], ["printers", "Принтеры"],
  ["critical", "События"], ["materials", "Материалы"], ["today", "Сегодня"], ["performance", "Ферма"],
  ["automations", "Автоматизации"], ["cameras", "Камеры"], ["maintenance", "Обслуживание"],
  ["actions", "Действия"], ["system", "Система"], ["feed", "Лента"], ["warnings", "Внимание"], ["plan", "План"],
];

function renderNav() {
  $("#section-nav").innerHTML = NAV
    .map(([id, label]) => `<button class="nav-chip" data-goto="${id}">${label}</button>`)
    .join("");
}

/* ── 1 · Hero ──────────────────────────────────────────────── */

function renderHero() {
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
    <span class="pill ${svcOk ? "pill-ok" : "pill-danger"}"><i class="dot dot-pulse"></i>${svcOk ? "Все системы в норме" : "Есть проблемы"}</span>
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

function renderQueue() {
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
        <span class="star">✦</span>
        <div class="grow">
          <div class="row-title">Следующее задание: ${esc(next.title)}</div>
          <div class="row-sub">${esc(next.printer)} · старт в ${esc(next.at)} · ${esc(next.eta)}</div>
        </div>
        <button class="btn btn-sm btn-primary" data-act="start-next">Запустить</button>
      </div>` : ""}`;
}

/* ── 3 · Ночная печать ─────────────────────────────────────── */

function renderNight() {
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
      <div class="night-part-sub" style="margin-top:6px">Кандидатов нет — планировщик ночной печати пока не подключён. Добавьте задания в очередь.</div>
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

/* ── 4 · Принтеры ──────────────────────────────────────────── */

const PRINTER_SVG = `
  <svg viewBox="0 0 100 60" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
    <path d="M14 54 L14 10 L86 10 L86 54" opacity=".7"/>
    <path d="M6 54 L94 54" />
    <path d="M22 22 L78 22" opacity=".5"/>
    <rect x="42" y="22" width="16" height="10" rx="2"/>
    <path d="M50 32 L50 38" />
    <path d="M30 46 L70 46" stroke-dasharray="3 4" opacity=".8"/>
  </svg>`;

function camBlock(p) {
  if (p.camera === "none") {
    return `<div class="cam"><div class="cam-offline">камера не настроена</div></div>`;
  }
  if (p.camera === "offline") {
    return `<div class="cam"><div class="cam-offline">нет сигнала</div>
      ${p.snapshotAt ? `<span class="cam-tag"><i class="dot"></i>снимок ${p.snapshotAt}</span>` : ""}</div>`;
  }
  // Камера online — показываем реальный кадр с backend; при ошибке загрузки
  // остаётся заглушка-силуэт (снимок мог устареть между опросами).
  const live = p.status === "printing";
  return `
    <div class="cam ${p.light ? "cam-lit" : ""}">
      ${PRINTER_SVG}
      <img class="cam-img" alt="Камера ${esc(p.name)}" loading="lazy"
        src="${API_BASE}/api/printers/${encodeURIComponent(p.id)}/camera.jpg?t=${encodeURIComponent(p.snapshotAt || Date.now())}"
        onerror="this.remove()">
      <span class="cam-tag ${live ? "live" : ""}"><i class="dot"></i>${live ? "LIVE" : `снимок ${p.snapshotAt || "—"}`}</span>
      <span class="cam-flash" data-flash="${p.id}"></span>
    </div>`;
}

/** Температура вида «тек/цель»; цель может быть неизвестна — тогда только текущая. */
function tempCell(pair) {
  const target = pair[1] != null ? `<span style="color:var(--ink-faint)">/${pair[1]}°</span>` : "";
  return `${pair[0]}°${target}`;
}

function teleBlock(p) {
  const cells = [];
  if (p.nozzle) cells.push(["Сопло", tempCell(p.nozzle)]);
  if (p.bed) cells.push(["Стол", tempCell(p.bed)]);
  if (p.chamber != null) cells.push(["Камера", `${p.chamber}°`]);
  cells.push(["Осталось", fmtLeft(p.minutesLeft)]);
  if (cells.length === 1 && p.minutesLeft == null) {
    return `<div class="telemetry"><div class="tele"><span class="t-lbl">Телеметрия</span><span class="t-val">недоступна</span></div></div>`;
  }
  return `<div class="telemetry">${cells
    .map(([l, v]) => `<div class="tele"><span class="t-lbl">${l}</span><span class="t-val">${v}</span></div>`)
    .join("")}</div>`;
}

function printerCard(p) {
  const busy = p.status === "printing" || p.status === "paused";
  const dead = p.status === "offline";
  const jobLine =
    busy && p.job ? `Печатает: <b>${esc(p.job)}</b>` :
    busy ? "Печатает — название задания не определено" :
    p.status === "error" ? `<span style="color:var(--danger);font-weight:700">${esc(p.error || "Ошибка")}</span>` :
    p.status === "maintenance" ? esc(p.note || "На обслуживании") :
    p.status === "unknown" ? esc(p.error || "Состояние неизвестно — принтер ещё не ответил") :
    dead ? esc(p.error ? `Нет связи: ${p.error}` : "Нет связи с принтером") :
    "Свободен — готов принять задание";

  // light === null: устройство не поддерживает управление подсветкой.
  const lightUnknown = p.light == null;
  const actions = `
    <button class="btn btn-sm" data-act="open" data-id="${p.id}">Открыть</button>
    <button class="btn btn-sm" data-act="pause" data-id="${p.id}" ${p.status !== "printing" ? "disabled" : ""}>⏸ Пауза</button>
    <button class="btn btn-sm" data-act="resume" data-id="${p.id}" ${p.status !== "paused" ? "disabled" : ""}>▶ Продолжить</button>
    <button class="btn btn-sm btn-danger" data-act="cancel" data-id="${p.id}" ${!busy ? "disabled" : ""}>✕ Отмена</button>
    <button class="btn btn-sm" data-act="light-on" data-id="${p.id}" ${lightUnknown || p.light || dead ? "disabled" : ""}>☀ Подсветка</button>
    <button class="btn btn-sm" data-act="light-off" data-id="${p.id}" ${lightUnknown || !p.light || dead ? "disabled" : ""}>☾ Погасить</button>
    <button class="btn btn-sm" data-act="snapshot" data-id="${p.id}" ${p.camera !== "online" || dead ? "disabled" : ""}>◉ Снимок</button>`;

  const progressBlock = !busy ? "" : p.progress != null ? `
    <div class="printer-progress">
      <div class="progress ${p.status === "paused" ? "is-paused" : ""}"><i style="width:${p.progress}%"></i></div>
      <div class="progress-caption"><b>${Math.round(p.progress)}%</b><span>осталось ${fmtLeft(p.minutesLeft)}</span></div>
    </div>` : `
    <div class="printer-progress">
      <div class="progress-caption"><b>—%</b><span>прогресс не сообщается принтером</span></div>
    </div>`;

  return `
    <article class="printer-card ${p.status === "error" ? "is-error" : ""} ${dead ? "is-offline" : ""}">
      ${camBlock(p)}
      <div class="printer-body">
        <div class="printer-top">
          <div>
            <h3 class="printer-name">${esc(p.name)}<span class="type-chip ${p.type === "FDM" ? "type-fdm" : "type-resin"}">${p.type}</span></h3>
            <div class="printer-model">${esc(p.model || "модель не указана")}</div>
          </div>
          ${badge(p.status)}
        </div>
        <div class="printer-job">${jobLine}</div>
        ${progressBlock}
        ${teleBlock(p)}
        <div class="printer-material">${p.swatch ? `<span class="swatch" style="background:${esc(p.swatch)}"></span>` : ""}${esc(p.material || "материал не указан")}</div>
        <div class="printer-actions">${actions}</div>
      </div>
    </article>`;
}

function renderPrinters() {
  const p = state.printers;
  $("#printers-meta").textContent =
    `${p.filter((x) => x.status === "printing").length} печатают · ${p.filter((x) => x.status === "idle").length} свободны · ${p.length} всего`;
  $("#printer-grid").innerHTML = p.map(printerCard).join("") ||
    `<div class="row"><div class="grow row-sub">Принтеры не настроены — добавьте их в config/printers.json на backend</div></div>`;
}

/* ── 5 · Критические события ───────────────────────────────── */

function renderCritical() {
  $("#critical-meta").textContent = state.critical.length ? `${state.critical.length} сейчас` : "нет проблем";
  $("#critical-body").innerHTML = `
    <ul class="row-list">
      ${state.critical.map((e) => `
        <li class="row ${e.level === "err" ? "row-danger" : "row-warn"}">
          <span class="row-icon">${esc(e.icon)}</span>
          <div class="grow"><div class="row-title" style="font-weight:600">${esc(e.text)}</div></div>
          <span class="row-time">${esc(e.time)}</span>
        </li>`).join("") || emptyRow("Критических событий нет")}
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

function renderMaterials() {
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
        <span class="row-icon">⬡</span>
        <div class="grow">
          <div class="row-title">Несоответствие материала</div>
          <div class="row-sub">«${esc(m.job)}» требует ${esc(m.needs)}, в ${esc(m.printer)} заправлен ${esc(m.loaded)}</div>
        </div>
      </div>`).join("")}`;
}

/* ── 7 · Сегодня ───────────────────────────────────────────── */

function renderToday() {
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

function renderPerf() {
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

function renderAutomations() {
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
      <span class="row-icon">⚗</span>
      <div class="grow"><div class="row-sub">Последний запуск: <b>${esc(state.automationLastRun || "нет данных")}</b></div></div>
    </div>`;
}

/* ── 10 · Камеры ───────────────────────────────────────────── */

function renderCameras() {
  const cams = state.printers.filter((p) => p.camera !== "none");
  const online = cams.filter((p) => p.camera === "online");
  $("#cameras-meta").textContent = cams.length
    ? `${online.length} online · ${cams.length - online.length} offline`
    : "не настроены";
  $("#cameras-body").innerHTML = `
    <div class="cam-grid">
      ${cams.map((p) => `
        <div class="cam-thumb" data-act="open" data-id="${p.id}" title="Открыть ${esc(p.name)}">
          <span class="cam-thumb-name">${esc(p.name)}</span>
          ${camBlock(p)}
        </div>`).join("") || `<ul class="row-list" style="grid-column:1/-1">${emptyRow("Ни у одного принтера не настроена камера (snapshotUrl в конфигурации)")}</ul>`}
    </div>`;
}

/* ── 11 · Обслуживание ─────────────────────────────────────── */

function renderMaintenance() {
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

const QUICK = [
  ["＋", "Добавить принтер", "добавление принтера"],
  ["▦", "Добавить задание", "создание задания печати"],
  ["⇪", "Загрузить файл", "загрузка файла печати"],
  ["☰", "Открыть очередь", "очередь"],
  ["☾", "Ночная печать", "ночная печать"],
  ["◉", "Камеры", "камеры"],
  ["⬡", "Материалы", "материалы"],
  ["⚙", "Настройки", "настройки"],
];

function renderQuick() {
  $("#actions-body").innerHTML = QUICK
    .map(([i, l, page]) => `<button class="quick" data-act="goto-page" data-page="${esc(page)}"><span class="q-icon">${i}</span>${l}</button>`)
    .join("");
}

/* ── 13 · Система ──────────────────────────────────────────── */

function renderSystem() {
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

function renderFeed() {
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

function renderWarnings() {
  $("#warnings-meta").textContent = state.warnings.length
    ? `${state.warnings.length} требуют внимания`
    : "всё спокойно";
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

function renderPlan() {
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
    ${pl.nightReady ? `<div class="chip-line"><span class="badge badge-teal">☾ На ночь: ${esc(pl.nightReady)}</span></div>` : ""}
    ${manualBlock}`;
}

/* ── Действия (реальные вызовы backend) ────────────────────── */

function findPrinter(id) {
  return state?.printers.find((p) => p.id === id);
}

/** Выполнить действие, обновить состояние и показать тост об успехе/ошибке. */
async function runAction(path, body, okMsg, okKind = "toast-ok") {
  try {
    const res = await apiPost(path, body);
    await refresh();
    if (okMsg) toast(okMsg, okKind);
    return res;
  } catch (err) {
    toast(esc(err.message), "toast-danger");
    return null;
  }
}

const actions = {
  open(p) { toast(`Открываю страницу принтера «${esc(p.name)}» — раздел в разработке`); },

  pause(p) { runAction(`/api/printers/${p.id}/pause`, null, `«${esc(p.name)}»: печать поставлена на паузу`); },

  resume(p) { runAction(`/api/printers/${p.id}/resume`, null, `«${esc(p.name)}»: печать продолжена`); },

  cancel(p) {
    const jobLabel = p.job ? `«${p.job}»` : "текущего задания";
    if (!window.confirm(`Отменить печать ${jobLabel} на ${p.name}?`)) return;
    runAction(`/api/printers/${p.id}/cancel`, null, `«${esc(p.name)}»: печать отменена`, "toast-danger");
  },

  "light-on"(p) { runAction(`/api/printers/${p.id}/light`, { on: true }, `«${esc(p.name)}»: подсветка включена ☀`); },

  "light-off"(p) { runAction(`/api/printers/${p.id}/light`, { on: false }, `«${esc(p.name)}»: подсветка выключена ☾`); },

  snapshot(p) {
    const flash = document.querySelector(`[data-flash="${p.id}"]`);
    if (flash) {
      flash.classList.remove("go");
      void flash.offsetWidth;
      flash.classList.add("go");
    }
    runAction(`/api/printers/${p.id}/snapshot`, null, `«${esc(p.name)}»: снимок сохранён ◉`);
  },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act], [data-goto]");
  if (!el) return;

  const goto = el.dataset.goto;
  if (goto) {
    document.getElementById(goto)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const act = el.dataset.act;

  if (act === "goto-page") {
    toast(`Раздел «${el.dataset.page}» ещё в разработке`);
    return;
  }
  if (act === "night-pick") {
    runAction("/api/queue/night/pick", null, "Подобрано следующее безопасное задание на ночь ☾");
    return;
  }
  if (act === "night-start") {
    runAction("/api/queue/night/start", null, null).then((res) => {
      if (res?.candidate) {
        toast(`Ночная печать «${esc(res.candidate.title)}» запланирована на ${esc(String(res.window).split(" ")[0])}`, "toast-ok");
      }
    });
    return;
  }
  if (act === "start-next") {
    runAction("/api/queue/start-next", null, null).then((res) => {
      if (res?.job) toast(`Задание «${esc(res.job.title)}» отправлено на ${esc(res.job.printer)}`, "toast-ok");
    });
    return;
  }
  if (act === "rule") {
    runAction(`/api/automations/${el.dataset.id}/toggle`, null, null).then((res) => {
      if (res?.automation) toast(`Правило «${esc(res.automation.name)}» ${res.automation.on ? "включено" : "выключено"}`);
    });
    return;
  }

  const printer = findPrinter(el.dataset.id);
  if (printer && actions[act]) actions[act](printer);
});

/* ── Часы ──────────────────────────────────────────────────── */

function tickClock() {
  $("#clock").textContent = new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/* ── Появление секций ──────────────────────────────────────── */

function setupReveal() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
  );
  document.querySelectorAll(".reveal").forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i * 60, 240)}ms`;
    io.observe(el);
  });
}

function ensureReveal() {
  if (revealed) return;
  revealed = true;
  setupReveal();
}

/* ── Смещения под липкие шапку и навигацию ─────────────────── */
/* Высота шапки на мобильных зависит от переноса пилюль, поэтому меряем её
   в рантайме и отдаём в CSS-переменные — навигация липнет ровно под шапкой,
   а якорный скролл не прячет заголовки секций. */

function syncStickyOffsets() {
  const topbar = $(".topbar");
  if (!topbar) return;
  const nav = $(".section-nav");
  const topH = Math.ceil(topbar.getBoundingClientRect().height);
  const navH = nav ? Math.ceil(nav.getBoundingClientRect().height) : 0;
  const root = document.documentElement.style;
  root.setProperty("--topbar-h", `${topH}px`);
  root.setProperty("--stack-h", `${topH + navH + 12}px`);
}

function setupStickyOffsets() {
  syncStickyOffsets();
  const topbar = $(".topbar");
  if (topbar && "ResizeObserver" in window) {
    new ResizeObserver(syncStickyOffsets).observe(topbar);
  }
  window.addEventListener("resize", syncStickyOffsets);
  // Веб-шрифты меняют высоту бренда — пересчитываем после их загрузки.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncStickyOffsets);
}

/* ── Загрузка данных и отрисовка ───────────────────────────── */

function renderBoard() {
  renderHero();
  renderQueue();
  renderNight();
  renderPrinters();
  renderCritical();
  renderMaterials();
  renderToday();
  renderPerf();
  renderAutomations();
  renderCameras();
  renderMaintenance();
  renderQuick();
  renderSystem();
  renderFeed();
  renderWarnings();
  renderPlan();
}

function renderAll() {
  if (!state) return;
  const snapshot = JSON.stringify(state);
  if (snapshot === lastRenderedJson) {
    // Данные не изменились — трогаем только шапку (статус связи), DOM доски
    // оставляем как есть, чтобы не пересоздавать <img> камер (без мерцания).
    renderTopbar();
    return;
  }
  lastRenderedJson = snapshot;
  renderNav();
  renderBoard();
  renderTopbar();
  ensureReveal();
}

async function loadDashboard() {
  const data = await apiGet("/api/dashboard");
  state = data;
  backendReachable = true;
  return data;
}

function renderBackendError(err) {
  const pills = $("#hero-pills");
  if (pills) {
    pills.innerHTML = `
      <span class="pill pill-danger"><i class="dot dot-pulse"></i>Backend недоступен</span>
      <span class="pill pill-warn"><i class="dot"></i>Повторная попытка каждые 6 с…</span>`;
  }
  toast(`Не удалось загрузить данные фермы: ${esc(err.message)}`, "toast-danger");
}

/** Перезагрузить состояние и перерисовать. По умолчанию тихо (для поллинга). */
async function refresh({ silent = true } = {}) {
  const wasReachable = backendReachable;
  try {
    await loadDashboard();
    renderAll();
    if (everLoaded && !wasReachable) toast("Соединение с backend восстановлено", "toast-ok");
    everLoaded = true;
  } catch (err) {
    backendReachable = false;
    renderTopbar();
    if (!silent) renderBackendError(err);
  }
}

/* ── Старт ─────────────────────────────────────────────────── */

renderNav();
renderTopbar();
tickClock();
setInterval(tickClock, 1000);

// Видимость секций не должна зависеть от загрузки данных: если backend
// недоступен на первом заходе, доска (и сообщение об ошибке в hero) всё равно
// проявляется, а не остаётся с opacity:0.
ensureReveal();
setupStickyOffsets();

refresh({ silent: false });
setInterval(() => { void refresh(); }, 6000);
