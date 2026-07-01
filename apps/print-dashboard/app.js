/* ═══════════════════════════════════════════════════════════════
   Albedo Atelier — главная панель (front-end, мок-данные)
   Backend ещё не подключён: состояние живёт в этом файле и
   имитирует поведение фермы — прогресс, события, действия.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ── Состояние ─────────────────────────────────────────────── */

const state = {
  service: { status: "ok", backend: "ok", version: "v0.4.2", startedHoursAgo: 86 },

  printers: [
    {
      id: "aurora", name: "Aurora", model: "Bambu Lab X1 Carbon", type: "FDM",
      status: "printing", job: "Кронштейн купольной камеры", progress: 64,
      nozzle: [218, 220], bed: [60, 60], chamber: 38, minutesLeft: 154,
      material: "PLA · Слоновая кость", swatch: "#efe8d8",
      camera: "online", light: true, snapshotAt: "12:41",
    },
    {
      id: "kreide", name: "Kreide", model: "Prusa MK4", type: "FDM",
      status: "printing", job: "Шестерня экструдера ×4", progress: 27,
      nozzle: [239, 240], bed: [85, 85], chamber: null, minutesLeft: 318,
      material: "PETG · Графит", swatch: "#4c4f55",
      camera: "online", light: false, snapshotAt: "12:38",
    },
    {
      id: "terra", name: "Terra", model: "Voron 2.4 R2", type: "FDM",
      status: "idle", job: null, progress: 0,
      nozzle: [24, 0], bed: [23, 0], chamber: 26, minutesLeft: 0,
      material: "ABS · Терракота", swatch: "#b0603f",
      camera: "none", light: false, snapshotAt: null,
    },
    {
      id: "cecilia", name: "Cecilia", model: "Elegoo Saturn 3 Ultra", type: "Resin",
      status: "printing", job: "Маска витража — мастер-модель", progress: 82,
      nozzle: null, bed: null, chamber: 24, minutesLeft: 47,
      material: "Смола · Standard Grey", swatch: "#9aa0aa",
      camera: "online", light: true, snapshotAt: "12:42",
    },
    {
      id: "calx", name: "Calx", model: "Ender-3 S1 Pro", type: "FDM",
      status: "error", job: "Кейс электроники", progress: 41,
      nozzle: [17, 220], bed: [22, 60], chamber: null, minutesLeft: 0,
      material: "PLA · Небесный", swatch: "#7fb3d8",
      camera: "online", light: false, snapshotAt: "11:57",
      error: "Ошибка термистора сопла — печать остановлена",
    },
    {
      id: "opal", name: "Opal", model: "Anycubic Photon M3 Max", type: "Resin",
      status: "offline", job: null, progress: 0,
      nozzle: null, bed: null, chamber: null, minutesLeft: 0,
      material: "Смола · ABS-like", swatch: "#6f7d8c",
      camera: "offline", light: false, snapshotAt: "09:12",
    },
    {
      id: "golem", name: "Golem", model: "Prusa MK3S+", type: "FDM",
      status: "maintenance", job: null, progress: 0,
      nozzle: [21, 0], bed: [21, 0], chamber: null, minutesLeft: 0,
      material: "не заправлен", swatch: "#d8d4c8",
      camera: "offline", light: false, snapshotAt: "08:03",
      note: "Замена сопла 0.4 → 0.6, готов к вечеру",
    },
  ],

  queue: [
    { id: "q1", title: "Корпус датчика влажности", printer: "Terra", material: "ABS · Терракота", eta: "3 ч 40 м", status: "ready", at: "14:30" },
    { id: "q2", title: "Кронштейны рейки ×6", printer: "Kreide", material: "PETG · Графит", eta: "5 ч 10 м", status: "ready", at: "18:05" },
    { id: "q3", title: "Статуэтка «Цецилия»", printer: "Cecilia", material: "Смола · Standard Grey", eta: "6 ч 20 м", status: "ready", at: "ночь", night: true },
    { id: "q4", title: "Маска витража — литьевая форма", printer: "—", material: "Смола · ABS-like", eta: "8 ч 05 м", status: "review", reason: "не задан профиль печати" },
    { id: "q5", title: "Кейс электроники", printer: "Calx", material: "ABS (требуется)", eta: "4 ч 30 м", status: "error", reason: "несоответствие материала: в принтере PLA" },
  ],

  night: {
    window: "23:00 – 07:30",
    candidates: [
      { title: "Статуэтка «Цецилия»", printer: "Cecilia", eta: "6 ч 20 м", risk: 18, riskLabel: "низкий" },
      { title: "Корпус датчика влажности", printer: "Terra", eta: "3 ч 40 м", risk: 24, riskLabel: "низкий" },
      { title: "Кронштейны рейки ×6", printer: "Kreide", eta: "5 ч 10 м", risk: 43, riskLabel: "средний" },
    ],
    pick: 0,
  },

  critical: [
    { icon: "🌡", text: "Calx: ошибка термистора сопла — печать остановлена", time: "11:57", level: "err" },
    { icon: "⛓", text: "Opal потерял связь (MQTT timeout), 3 попытки переподключения", time: "09:12", level: "err" },
    { icon: "🧑‍🔧", text: "Кейс электроники: нужен оператор — сменить материал на ABS", time: "11:58", level: "warn" },
    { icon: "🧵", text: "Kreide: катушка PETG на исходе (~0.8 кг при потребности 1.1 кг)", time: "10:24", level: "warn" },
    { icon: "◉", text: "Камера Golem не отвечает (go2rtc: stream unavailable)", time: "08:03", level: "warn" },
  ],

  materials: {
    filament: [
      { name: "PLA · Слоновая кость", swatch: "#efe8d8", have: 2.4, unit: "кг", full: 3 },
      { name: "PETG · Графит", swatch: "#4c4f55", have: 0.8, unit: "кг", full: 3, low: true, need: 1.1 },
      { name: "ABS · Терракота", swatch: "#b0603f", have: 1.6, unit: "кг", full: 3 },
      { name: "TPU · Янтарь", swatch: "#d9a441", have: 0.3, unit: "кг", full: 1, low: true },
    ],
    resin: [
      { name: "Standard Grey", swatch: "#9aa0aa", have: 1.2, unit: "л", full: 2 },
      { name: "ABS-like Ivory", swatch: "#e8e0cc", have: 0.4, unit: "л", full: 1, low: true, need: 0.6 },
    ],
    mismatch: [
      { job: "Кейс электроники", needs: "ABS", printer: "Calx", loaded: "PLA" },
    ],
  },

  today: {
    done: 7, active: 3, failed: 1, hoursUsed: 26.4, hoursQueued: 18.2,
  },

  perf: {
    load: 72, free: 1, busy: 3, maintenance: 1, avgPrint: "4 ч 12 м", successRate: 93.4,
  },

  automations: [
    { id: "night", name: "Ночная печать", desc: "подбор и запуск безопасных заданий в окно 23:00–07:30", on: true },
    { id: "light", name: "Подсветка по событиям", desc: "включать при старте печати и на время снимка", on: true },
    { id: "snap", name: "Авто-снимки", desc: "каждые 10 минут во время активной печати", on: true },
    { id: "notify", name: "Уведомления об ошибках", desc: "Telegram + e-mail при критических событиях", on: true },
    { id: "runout", name: "Автопауза при обрыве филамента", desc: "по датчику filament runout", on: false },
  ],
  automationLastRun: "Авто-снимки · 6 минут назад · успешно",

  system: [
    { name: "Версия сервиса", val: "v0.4.2 · сборка 28.06", ok: "ok" },
    { name: "Запуск сервиса", val: "3 дн 14 ч назад", ok: "ok" },
    { name: "База данных", val: "PostgreSQL · 4 мс", ok: "ok" },
    { name: "MQTT", val: "подключено · 6/7 клиентов", ok: "warn" },
    { name: "go2rtc", val: "5 потоков · 2 offline", ok: "warn" },
    { name: "Очередь", val: "5 заданий · работает", ok: "ok" },
    { name: "Scheduler", val: "след. тик через 40 с", ok: "ok" },
    { name: "Automation worker", val: "активен · 5 правил", ok: "ok" },
  ],

  feed: [
    { icon: "▶", text: "<b>Cecilia</b> начала печать «Маска витража — мастер-модель»", time: "12:02", kind: "ok" },
    { icon: "⚠", text: "<b>Calx</b>: печать остановлена — ошибка термистора", time: "11:57", kind: "err" },
    { icon: "＋", text: "Задание «Кронштейны рейки ×6» добавлено в очередь", time: "11:31", kind: "info" },
    { icon: "⚗", text: "Автоматизация «Авто-снимки» выполнена для 3 принтеров", time: "11:30", kind: "info" },
    { icon: "✔", text: "<b>Aurora</b> завершила печать «Крышка корпуса» (успех)", time: "10:48", kind: "ok" },
    { icon: "⛓", text: "<b>Opal</b> ушёл offline", time: "09:12", kind: "err" },
    { icon: "🧑‍🔧", text: "Оператор перевёл <b>Golem</b> в режим обслуживания", time: "08:03", kind: "info" },
    { icon: "↺", text: "<b>Kreide</b> вернулся online после перезагрузки", time: "07:44", kind: "ok" },
  ],

  warnings: [
    { icon: "⛓", text: "Нет связи с принтером Opal", hint: "проверить питание и сеть", level: "err" },
    { icon: "◉", text: "У Terra не настроена камера", hint: "ночная печать на нём недоступна", level: "warn" },
    { icon: "🧵", text: "PETG · Графит заканчивается", hint: "для очереди нужно ещё 0.3 кг", level: "warn" },
    { icon: "▦", text: "«Маска витража — литьевая форма»: не задан профиль печати", hint: "задание ждёт проверки", level: "warn" },
    { icon: "⬡", text: "«Кейс электроники»: материал не совпадает с заправленным", hint: "нужен ABS, заправлен PLA", level: "warn" },
    { icon: "⚙", text: "У Golem не настроены capabilities", hint: "автоподбор заданий пропускает его", level: "info" },
  ],

  plan: {
    next: { title: "Корпус датчика влажности", printer: "Terra", at: "14:30" },
    upcoming: [
      { title: "Кронштейны рейки ×6", printer: "Kreide", at: "18:05" },
      { title: "Статуэтка «Цецилия»", printer: "Cecilia", at: "23:00 · ночь" },
      { title: "Маска витража — литьевая форма", printer: "—", at: "после проверки" },
    ],
    queueEta: "завтра · 09:40",
    nightReady: "Статуэтка «Цецилия» — риск 18%, камера и авто-снимки активны",
    manual: [
      "«Маска витража — литьевая форма» — задать профиль печати",
      "«Кейс электроники» — заправить ABS в Calx после ремонта",
    ],
  },
};

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
};

function badge(status) {
  const s = STATUS[status] || STATUS.idle;
  return `<span class="badge ${s.badge}"><i class="dot${s.pulse ? " dot-pulse" : ""}"></i>${s.label}</span>`;
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
    <span class="pill pill-gold"><i class="dot"></i>${state.service.version}</span>`;
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
                <div class="row-title">${esc(p.job)}</div>
                <div class="row-sub">${esc(p.name)} · осталось ${fmtLeft(p.minutesLeft)}</div>
                <div class="progress ${p.status === "paused" ? "is-paused" : ""}" style="margin-top:7px"><i style="width:${p.progress}%"></i></div>
              </div>
              <span class="row-time">${Math.round(p.progress)}%</span>
            </li>`).join("") || `<li class="row"><div class="grow row-sub">Нет активных печатей</div></li>`}
        </ul>
      </div>
      <div>
        <p class="sub-head">Очередь <span class="count">${state.queue.length}</span></p>
        <ul class="row-list">${state.queue.map(queueRow).join("")}</ul>
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
  $("#night-body").innerHTML = `
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
    </div>
    <div class="night-facts">
      <span class="badge">☾ окно: ${esc(n.window)}</span>
      <span class="badge">◉ камера активна</span>
      <span class="badge">⚗ авто-снимки каждые 10 мин</span>
    </div>
    <div class="night-actions">
      <button class="btn btn-ghost" data-act="night-pick">Подобрать задание на ночь</button>
      <button class="btn btn-primary" data-act="night-start">☾ Запустить ночную печать</button>
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
  if (p.camera === "offline" || p.status === "offline") {
    return `<div class="cam"><div class="cam-offline">нет сигнала</div>
      ${p.snapshotAt ? `<span class="cam-tag"><i class="dot"></i>снимок ${p.snapshotAt}</span>` : ""}</div>`;
  }
  const live = p.status === "printing";
  return `
    <div class="cam ${p.light ? "cam-lit" : ""}">
      ${PRINTER_SVG}
      <span class="cam-tag ${live ? "live" : ""}"><i class="dot"></i>${live ? "LIVE" : `снимок ${p.snapshotAt || "—"}`}</span>
      <span class="cam-flash" data-flash="${p.id}"></span>
    </div>`;
}

function teleBlock(p) {
  const cells = [];
  if (p.nozzle) cells.push(["Сопло", `${p.nozzle[0]}°<span style="color:var(--ink-faint)">/${p.nozzle[1]}°</span>`]);
  if (p.bed) cells.push(["Стол", `${p.bed[0]}°<span style="color:var(--ink-faint)">/${p.bed[1]}°</span>`]);
  if (p.chamber != null) cells.push(["Камера", `${p.chamber}°`]);
  cells.push(["Осталось", fmtLeft(p.minutesLeft)]);
  return `<div class="telemetry">${cells
    .map(([l, v]) => `<div class="tele"><span class="t-lbl">${l}</span><span class="t-val">${v}</span></div>`)
    .join("")}</div>`;
}

function printerCard(p) {
  const busy = p.status === "printing" || p.status === "paused";
  const dead = p.status === "offline";
  const jobLine =
    busy && p.job ? `Печатает: <b>${esc(p.job)}</b>` :
    p.status === "error" ? `<span style="color:var(--danger);font-weight:700">${esc(p.error || "Ошибка")}</span>` :
    p.status === "maintenance" ? esc(p.note || "На обслуживании") :
    dead ? "Нет связи с принтером" : "Свободен — готов принять задание";

  const actions = `
    <button class="btn btn-sm" data-act="open" data-id="${p.id}">Открыть</button>
    <button class="btn btn-sm" data-act="pause" data-id="${p.id}" ${p.status !== "printing" ? "disabled" : ""}>⏸ Пауза</button>
    <button class="btn btn-sm" data-act="resume" data-id="${p.id}" ${p.status !== "paused" ? "disabled" : ""}>▶ Продолжить</button>
    <button class="btn btn-sm btn-danger" data-act="cancel" data-id="${p.id}" ${!busy ? "disabled" : ""}>✕ Отмена</button>
    <button class="btn btn-sm" data-act="light-on" data-id="${p.id}" ${p.light || dead ? "disabled" : ""}>☀ Подсветка</button>
    <button class="btn btn-sm" data-act="light-off" data-id="${p.id}" ${!p.light || dead ? "disabled" : ""}>☾ Погасить</button>
    <button class="btn btn-sm" data-act="snapshot" data-id="${p.id}" ${p.camera !== "online" || dead ? "disabled" : ""}>◉ Снимок</button>`;

  return `
    <article class="printer-card ${p.status === "error" ? "is-error" : ""} ${dead ? "is-offline" : ""}">
      ${camBlock(p)}
      <div class="printer-body">
        <div class="printer-top">
          <div>
            <h3 class="printer-name">${esc(p.name)}<span class="type-chip ${p.type === "FDM" ? "type-fdm" : "type-resin"}">${p.type}</span></h3>
            <div class="printer-model">${esc(p.model)}</div>
          </div>
          ${badge(p.status)}
        </div>
        <div class="printer-job">${jobLine}</div>
        ${busy ? `
          <div class="printer-progress">
            <div class="progress ${p.status === "paused" ? "is-paused" : ""}"><i style="width:${p.progress}%"></i></div>
            <div class="progress-caption"><b>${Math.round(p.progress)}%</b><span>осталось ${fmtLeft(p.minutesLeft)}</span></div>
          </div>` : ""}
        ${teleBlock(p)}
        <div class="printer-material"><span class="swatch" style="background:${p.swatch}"></span>${esc(p.material)}</div>
        <div class="printer-actions">${actions}</div>
      </div>
    </article>`;
}

function renderPrinters() {
  const p = state.printers;
  $("#printers-meta").textContent =
    `${p.filter((x) => x.status === "printing").length} печатают · ${p.filter((x) => x.status === "idle").length} свободны · ${p.length} всего`;
  $("#printer-grid").innerHTML = p.map(printerCard).join("");
}

/* ── 5 · Критические события ───────────────────────────────── */

function renderCritical() {
  $("#critical-meta").textContent = `${state.critical.length} за сегодня`;
  $("#critical-body").innerHTML = `
    <ul class="row-list">
      ${state.critical.map((e) => `
        <li class="row ${e.level === "err" ? "row-danger" : "row-warn"}">
          <span class="row-icon">${e.icon}</span>
          <div class="grow"><div class="row-title" style="font-weight:600">${esc(e.text)}</div></div>
          <span class="row-time">${e.time}</span>
        </li>`).join("")}
    </ul>`;
}

/* ── 6 · Материалы ─────────────────────────────────────────── */

function matItem(m) {
  const ratio = m.have / m.full;
  const lvl = ratio < 0.18 ? "crit" : ratio < 0.4 ? "low" : "";
  return `
    <div class="mat-item ${m.low ? "mat-low" : ""}">
      <div class="grow">
        <div class="mat-name"><span class="swatch" style="background:${m.swatch}"></span>${esc(m.name)}</div>
        <div class="level mat-level ${lvl}"><i style="width:${Math.min(100, ratio * 100)}%"></i></div>
      </div>
      <span class="mat-qty">${m.have} ${m.unit}${m.need ? ` / нужно ${m.need}` : ""}</span>
    </div>`;
}

function renderMaterials() {
  const mats = state.materials;
  const low = [...mats.filament, ...mats.resin].filter((m) => m.low);
  $("#materials-meta").textContent = `${low.length} заканчиваются`;

  const perPrinter = state.printers
    .map((p) => `<span class="badge badge-plain"><span class="swatch" style="background:${p.swatch};width:9px;height:9px"></span>${esc(p.name)}: ${esc(p.material)}</span>`)
    .join("");

  $("#materials-body").innerHTML = `
    <div class="mat-cols">
      <div><p class="sub-head">Филамент</p>${mats.filament.map(matItem).join("")}</div>
      <div><p class="sub-head">Смола</p>${mats.resin.map(matItem).join("")}</div>
    </div>
    <div>
      <p class="sub-head">Нужно для очереди</p>
      <div class="chip-line">
        <span class="badge badge-paused">PETG · Графит — ещё 0.3 кг</span>
        <span class="badge badge-paused">ABS-like — ещё 0.2 л</span>
        <span class="badge badge-idle">Standard Grey — хватает</span>
      </div>
    </div>
    <div>
      <p class="sub-head">В принтерах</p>
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
  const tiles = [
    { n: t.done, l: "завершено", tone: "tone-ok" },
    { n: t.active, l: "выполняется", tone: "tone-gold" },
    { n: t.failed, l: "провалено", tone: "tone-danger" },
    { n: `${t.hoursUsed} ч`, l: "часов печати", tone: "" },
    { n: `≈${t.hoursQueued} ч`, l: "осталось в очереди", tone: "" },
  ];
  $("#today-body").innerHTML = tiles
    .map((x) => `<div class="stat-tile ${x.tone}"><span class="num">${x.n}</span><span class="lbl">${x.l}</span></div>`)
    .join("");
}

/* ── 8 · Производительность ────────────────────────────────── */

function renderPerf() {
  const p = state.perf;
  const R = 46, C = 2 * Math.PI * R;
  $("#perf-body").innerHTML = `
    <div class="perf-load">
      <div class="gauge" role="img" aria-label="Загрузка фермы ${p.load}%">
        <svg viewBox="0 0 108 108">
          <circle class="track" cx="54" cy="54" r="${R}" fill="none" stroke-width="9"/>
          <circle class="fill" cx="54" cy="54" r="${R}" fill="none" stroke-width="9"
            stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - p.load / 100)}"/>
        </svg>
        <span class="gauge-num">${p.load}%</span>
      </div>
      <div class="perf-side">
        <div class="kv"><span class="k">Свободны</span><span class="v">${p.free}</span></div>
        <div class="kv"><span class="k">Заняты</span><span class="v">${p.busy}</span></div>
        <div class="kv"><span class="k">Обслуживание</span><span class="v">${p.maintenance}</span></div>
        <div class="kv"><span class="k">Среднее время печати</span><span class="v">${p.avgPrint}</span></div>
        <div class="kv"><span class="k">Успешных печатей</span><span class="v" style="color:var(--ok)">${p.successRate}%</span></div>
      </div>
    </div>`;
}

/* ── 9 · Автоматизации ─────────────────────────────────────── */

function renderAutomations() {
  const on = state.automations.filter((a) => a.on).length;
  $("#auto-meta").textContent = `${on} из ${state.automations.length} активны`;
  $("#auto-body").innerHTML = `
    ${state.automations.map((a) => `
      <div class="rule">
        <button class="toggle ${a.on ? "on" : ""}" data-act="rule" data-id="${a.id}"
          role="switch" aria-checked="${a.on}" aria-label="${esc(a.name)}"></button>
        <div class="grow">
          <div class="row-title">${esc(a.name)}</div>
          <div class="row-sub">${esc(a.desc)}</div>
        </div>
      </div>`).join("")}
    <div class="row">
      <span class="row-icon">⚗</span>
      <div class="grow"><div class="row-sub">Последний запуск: <b>${esc(state.automationLastRun)}</b></div></div>
      <button class="btn btn-sm" data-act="goto-page" data-page="автоматизации">Открыть автоматизации</button>
    </div>`;
}

/* ── 10 · Камеры ───────────────────────────────────────────── */

function renderCameras() {
  const cams = state.printers.filter((p) => p.camera !== "none");
  const online = cams.filter((p) => p.camera === "online" && p.status !== "offline");
  $("#cameras-meta").textContent = `${online.length} online · ${cams.length - online.length} offline`;
  $("#cameras-body").innerHTML = `
    <div class="cam-grid">
      ${cams.map((p) => `
        <div class="cam-thumb" data-act="open" data-id="${p.id}" title="Открыть ${esc(p.name)}">
          <span class="cam-thumb-name">${esc(p.name)}</span>
          ${camBlock(p)}
        </div>`).join("")}
    </div>
    <div style="display:flex;justify-content:flex-end">
      <button class="btn btn-sm" data-act="goto-page" data-page="камеры">Смотреть все камеры →</button>
    </div>`;
}

/* ── 11 · Обслуживание ─────────────────────────────────────── */

const MAINT = [
  { p: "Aurora", clean: "3 дн", nozzle: "12 дн", fep: "—", calib: "3 дн", success: "сегодня 10:48", due: false },
  { p: "Kreide", clean: "6 дн", nozzle: "24 дн", fep: "—", calib: "6 дн", success: "вчера 22:10", due: false },
  { p: "Terra", clean: "1 дн", nozzle: "8 дн", fep: "—", calib: "1 дн", success: "вчера 18:32", due: false },
  { p: "Cecilia", clean: "2 дн", nozzle: "—", fep: "9 дн", calib: "9 дн", success: "сегодня 07:15", due: false },
  { p: "Calx", clean: "19 дн", nozzle: "41 дн", fep: "—", calib: "19 дн", success: "28.06", due: true },
  { p: "Opal", clean: "11 дн", nozzle: "—", fep: "34 дн", calib: "34 дн", success: "24.06", due: true },
  { p: "Golem", clean: "сейчас", nozzle: "сейчас", fep: "—", calib: "после ремонта", success: "27.06", due: false },
];

function renderMaintenance() {
  const due = MAINT.filter((m) => m.due);
  $("#maint-meta").textContent = due.length ? `${due.length} требуют внимания` : "всё в порядке";
  $("#maint-body").innerHTML = `
    ${due.length ? `<div class="chip-line">${due.map((m) => `<span class="badge badge-paused">⚙ ${m.p}: пора обслужить</span>`).join("")}</div>` : ""}
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th>Принтер</th><th>Чистка</th><th>Сопло</th><th>FEP-плёнка</th><th>Калибровка</th><th>Успешная печать</th>
        </tr></thead>
        <tbody>
          ${MAINT.map((m) => `
            <tr>
              <td><b>${m.p}</b></td>
              <td class="${m.due ? "td-due" : "td-ok"}">${m.clean}</td>
              <td class="${m.due ? "td-due" : "td-ok"}">${m.nozzle}</td>
              <td class="td-ok">${m.fep}</td>
              <td class="td-ok">${m.calib}</td>
              <td class="td-ok">${m.success}</td>
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
          <div class="feed-text">${e.icon} ${e.text}</div>
          <div class="feed-time">${e.time}</div>
        </li>`).join("")}
    </ul>`;
}

function pushEvent(icon, text, kind = "info") {
  const t = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  state.feed.unshift({ icon, text, time: t, kind });
  renderFeed();
}

/* ── 15 · Предупреждения ───────────────────────────────────── */

function renderWarnings() {
  $("#warnings-meta").textContent = `${state.warnings.length} требуют внимания`;
  $("#warnings-body").innerHTML = `
    <ul class="row-list">
      ${state.warnings.map((w) => `
        <li class="row ${w.level === "err" ? "row-danger" : w.level === "warn" ? "row-warn" : ""}">
          <span class="row-icon">${w.icon}</span>
          <div class="grow">
            <div class="row-title" style="font-weight:600">${esc(w.text)}</div>
            <div class="row-sub">${esc(w.hint)}</div>
          </div>
        </li>`).join("")}
    </ul>`;
}

/* ── 16 · План ─────────────────────────────────────────────── */

function renderPlan() {
  const pl = state.plan;
  $("#plan-meta").textContent = `очередь завершится ${pl.queueEta}`;
  $("#plan-body").innerHTML = `
    <div class="plan-next">
      <span class="when">${esc(pl.next.at)}</span>
      <div class="grow">
        <div class="row-title">Следующая печать: ${esc(pl.next.title)}</div>
        <div class="row-sub">${esc(pl.next.printer)} · материал заправлен, стол свободен</div>
      </div>
    </div>
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
    </div>
    <div class="chip-line">
      <span class="badge badge-teal">☾ На ночь: ${esc(pl.nightReady)}</span>
    </div>
    <div>
      <p class="sub-head">Требует ручной подготовки</p>
      <ul class="row-list">
        ${pl.manual.map((m) => `<li class="row row-warn"><span class="row-icon">✎</span><div class="grow row-sub" style="color:var(--ink)">${esc(m)}</div></li>`).join("")}
      </ul>
    </div>`;
}

/* ── Действия ──────────────────────────────────────────────── */

function findPrinter(id) {
  return state.printers.find((p) => p.id === id);
}

function refreshPrinterViews() {
  renderHero();
  renderPrinters();
  renderQueue();
  renderCameras();
}

const actions = {
  open(p) { toast(`Открываю страницу принтера «${p.name}» — раздел в разработке`); },

  pause(p) {
    p.status = "paused";
    toast(`«${p.name}»: печать поставлена на паузу`, "toast-ok");
    pushEvent("⏸", `Оператор поставил <b>${p.name}</b> на паузу`, "info");
    refreshPrinterViews();
  },

  resume(p) {
    p.status = "printing";
    toast(`«${p.name}»: печать продолжена`, "toast-ok");
    pushEvent("▶", `<b>${p.name}</b> продолжил печать`, "ok");
    refreshPrinterViews();
  },

  cancel(p) {
    if (!window.confirm(`Отменить печать «${p.job}» на ${p.name}?`)) return;
    pushEvent("✕", `Печать «${esc(p.job)}» на <b>${p.name}</b> отменена оператором`, "err");
    p.status = "idle";
    p.job = null;
    p.progress = 0;
    p.minutesLeft = 0;
    toast(`«${p.name}»: печать отменена`, "toast-danger");
    refreshPrinterViews();
  },

  "light-on"(p) {
    p.light = true;
    toast(`«${p.name}»: подсветка включена ☀`);
    refreshPrinterViews();
  },

  "light-off"(p) {
    p.light = false;
    toast(`«${p.name}»: подсветка выключена ☾`);
    refreshPrinterViews();
  },

  snapshot(p) {
    const flash = document.querySelector(`[data-flash="${p.id}"]`);
    if (flash) {
      flash.classList.remove("go");
      void flash.offsetWidth;
      flash.classList.add("go");
    }
    p.snapshotAt = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    toast(`«${p.name}»: снимок сохранён ◉`, "toast-ok");
    pushEvent("◉", `Сделан снимок с камеры <b>${p.name}</b>`, "info");
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
    toast(`Раздел «${el.dataset.page}» появится вместе с backend — пока это витрина`);
    return;
  }
  if (act === "night-pick") {
    state.night.pick = (state.night.pick + 1) % state.night.candidates.length;
    renderNight();
    toast("Подобрано следующее безопасное задание на ночь ☾");
    return;
  }
  if (act === "night-start") {
    const c = state.night.candidates[state.night.pick];
    toast(`Ночная печать «${c.title}» запланирована на ${state.night.window.split(" ")[0]}`, "toast-ok");
    pushEvent("☾", `Запланирована ночная печать «${esc(c.title)}» на <b>${esc(c.printer)}</b>`, "ok");
    return;
  }
  if (act === "start-next") {
    toast("Задание отправлено на принтер — ждём подтверждения", "toast-ok");
    pushEvent("▶", `Задание «Корпус датчика влажности» отправлено на <b>Terra</b>`, "ok");
    return;
  }
  if (act === "rule") {
    const rule = state.automations.find((a) => a.id === el.dataset.id);
    if (rule) {
      rule.on = !rule.on;
      renderAutomations();
      toast(`Правило «${rule.name}» ${rule.on ? "включено" : "выключено"}`);
    }
    return;
  }

  const printer = findPrinter(el.dataset.id);
  if (printer && actions[act]) actions[act](printer);
});

/* ── Часы и «жизнь» фермы ──────────────────────────────────── */

function tickClock() {
  $("#clock").textContent = new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function tickFarm() {
  let changed = false;
  for (const p of state.printers) {
    if (p.status !== "printing" || p.progress >= 99.5) continue;
    p.progress = Math.min(99.5, p.progress + 0.35 + Math.random() * 0.3);
    p.minutesLeft = Math.max(1, p.minutesLeft - 0.5);
    if (p.nozzle) p.nozzle[0] = p.nozzle[1] - Math.round(Math.random() * 3);
    changed = true;
  }
  if (changed) {
    renderPrinters();
    renderQueue();
  }
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

/* ── Старт ─────────────────────────────────────────────────── */

function renderAll() {
  renderNav();
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

renderAll();
setupReveal();
tickClock();
setInterval(tickClock, 1000);
setInterval(tickFarm, 6000);
