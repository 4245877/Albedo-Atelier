/* ── Browser smoke: раскладка на четырёх ширинах ─────────────────
   Рабочие экраны — Зал (принтеры, очередь), «Новая печать», «История»,
   «Автоматизации» и окно запуска — на компьютере, ноутбуке, планшете и
   телефоне, с НАСЫЩЕННЫМИ данными: длинные имена файлов, принтер, ждущий
   снятия детали, офлайн-принтер, причины блокировки длиной в предложение.
   Пустая доска не переполняется никогда — переполняет реальная.

   Проверяется то, что ломается незаметно для чистых функций:
     · страница не прокручивается по горизонтали;
     · ни один видимый элемент не вылезает за правый край экрана (кроме тех,
       что лежат в собственной горизонтальной прокрутке — ленты вкладок);
     · главные кнопки каждого экрана видимы и имеют ненулевой размер.

   SMOKE_SCREENSHOTS_DIR=<каталог> — дополнительно сохраняет снимки каждого
   экрана на каждой ширине, для глазной проверки. Как и остальные smoke-тесты,
   SKIP-ается без браузера (CHROME_CDP_URL, по умолчанию :9222). */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MOCK_DASHBOARD, startMockServer } from "./mockServer.mjs";

const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
const SHOTS = process.env.SMOKE_SCREENSHOTS_DIR || "";

const VIEWPORTS = [
  { name: "desktop", width: 1920, height: 1080, mobile: false },
  { name: "laptop", width: 1366, height: 768, mobile: false },
  { name: "tablet", width: 820, height: 1180, mobile: true },
  { name: "phone", width: 390, height: 844, mobile: true }
];

async function probeCdp() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const exceptions = [];
  let seq = 0;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      exceptions.push(d?.exception?.description || d?.text || "uncaught exception");
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { send, exceptions, close: () => ws.close() };
}

// ── A busy farm ──────────────────────────────────────────────────────────────

const ISO = "2026-10-14T10:00:00.000Z";
const LONG = "кронштейн-крепления-светильника-для-мастерской-усиленный-вариант-v7-final.gcode";

const printers = [
  {
    ...MOCK_DASHBOARD.printers[0],
    id: "creality-k2",
    name: "Creality K2",
    job: LONG,
    progress: 62,
    minutesLeft: 95,
    bedCycle: { state: "RUNNING", awaitingClearance: false, operationId: null, confirmable: false }
  },
  {
    ...MOCK_DASHBOARD.printers[1],
    id: "bambu-a1",
    name: "Bambu Lab A1 Combo",
    status: "idle",
    readiness: {
      state: "awaiting_clearance",
      canAcceptJob: false,
      label: "Ждёт снятия детали",
      detail: "печать «крышка-корпуса-датчика.gcode» завершена в 09:41 — снимите деталь и подтвердите, что стол свободен"
    },
    bedCycle: { state: "AWAITING_CLEARANCE", awaitingClearance: true, operationId: "op_1", confirmable: true }
  },
  {
    ...MOCK_DASHBOARD.printers[1],
    id: "ender3-v3-ke",
    name: "Creality Ender 3 V3 KE",
    status: "offline",
    model: "Creality Ender 3 V3 KE",
    error: "Нет связи: connect ECONNREFUSED 192.168.0.141:9999",
    readiness: { state: "bed_unknown", canAcceptJob: false, label: "Стол не подтверждён", detail: null },
    bedCycle: { state: "UNKNOWN", awaitingClearance: false, operationId: null, confirmable: true }
  }
];

const queue = [
  { id: "t1", title: LONG, printer: "Creality K2", material: "PETG", eta: "3 ч 12 мин", status: "ready", at: "22:00" },
  { id: "t2", title: "крышка-корпуса-датчика.gcode", printer: "Bambu Lab A1 Combo", material: "PLA", eta: "47 мин", status: "ready", at: "—" },
  { id: "t3", title: "ручка.stl", printer: "—", material: "PETG", eta: "—", status: "ready", at: "—" }
];

const readinessRows = [
  {
    taskId: "t1",
    state: "blocked",
    summary: "Принтер занят другим заданием (Creality K2)",
    printerId: "creality-k2",
    printerName: "Creality K2",
    canLaunch: false,
    needsConfirmation: false,
    alternativeCount: 0,
    primaryProblem: { code: "PRINTER_RESERVED", kind: "blocker", title: "Принтер занят другим заданием", action: "На принтере размещено другое задание. Запустите его или выберите другой принтер.", technical: "…", overridable: false }
  },
  {
    taskId: "t2",
    state: "needs_confirmation",
    summary: "стол свободен — подтвердите и запускайте на «Bambu Lab A1 Combo»",
    printerId: "bambu-a1",
    printerName: "Bambu Lab A1 Combo",
    canLaunch: true,
    needsConfirmation: true,
    alternativeCount: 0,
    primaryProblem: null
  },
  {
    taskId: "t3",
    state: "blocked",
    summary: "Модель ещё не нарезана",
    printerId: null,
    printerName: null,
    canLaunch: false,
    needsConfirmation: false,
    alternativeCount: 0,
    primaryProblem: null
  }
];

const candidate = (over) => ({
  verdict: "compatible",
  blockers: [],
  reviews: [],
  warnings: [],
  online: true,
  status: "idle",
  loadedMaterial: "PLA",
  requiredMaterial: "PLA",
  printerNozzleMm: 0.4,
  requiredNozzleMm: 0.4,
  deviceFile: "missing",
  queueLength: 0,
  pendingManualOperations: 0,
  remoteStartSupported: true,
  eligible: true,
  score: 90,
  scoreBreakdown: [],
  reason: "",
  problems: [],
  ...over
});

const launchPreview = {
  taskId: "t2",
  title: "крышка-корпуса-датчика.gcode",
  displayTitle: "крышка-корпуса-датчика",
  state: "needs_confirmation",
  material: "PLA",
  nozzleMm: 0.4,
  etaSeconds: 2820,
  etaText: "≈ 47 мин",
  filamentG: 14.2,
  materialSource: "external",
  recommendedPrinterId: "bambu-a1",
  alternativeCount: 0,
  selectedPrinterId: "bambu-a1",
  selectionSource: "auto",
  selectionNote: "Bambu Lab A1 Combo — единственный принтер, готовый принять это задание",
  candidates: [
    candidate({
      printerId: "bambu-a1",
      printerName: "Bambu Lab A1 Combo",
      reviews: [{ code: "BED_NOT_CLEAR", message: "на столе осталась готовая модель", confirmation: "bed_clear", overridable: false }],
      problems: [{ code: "BED_NOT_CLEAR", kind: "confirmable", title: "На столе готовая модель", action: "Снимите деталь и подтвердите, что стол свободен.", technical: "BED_NOT_CLEAR", overridable: false, confirmation: "bed_clear" }]
    }),
    candidate({
      printerId: "creality-k2",
      printerName: "Creality K2",
      eligible: false,
      status: "printing",
      loadedMaterial: "PETG",
      blockers: [
        { code: "TARGET_PRINTER_MISMATCH", message: "файл нарезан для «Bambu Lab A1», а принтер — «Creality K2»", overridable: false },
        { code: "PRINTER_BUSY", message: "принтер печатает «" + LONG + "»", overridable: false }
      ],
      problems: [
        { code: "TARGET_PRINTER_MISMATCH", kind: "blocker", title: "Файл нарезан для другого принтера", action: "Нарежьте модель под этот принтер или выберите тот, для которого файл собран.", technical: "TARGET_PRINTER_MISMATCH", overridable: false },
        { code: "PRINTER_BUSY", kind: "blocker", title: "Принтер занят", action: "Дождитесь окончания печати «" + LONG + "».", technical: "PRINTER_BUSY", overridable: false }
      ]
    }),
    candidate({
      printerId: "ender3-v3-ke",
      printerName: "Creality Ender 3 V3 KE",
      eligible: false,
      online: false,
      status: "offline",
      remoteStartSupported: false,
      blockers: [{ code: "PRINTER_OFFLINE", message: "принтер не отвечает", overridable: false }],
      problems: [{ code: "PRINTER_OFFLINE", kind: "blocker", title: "Принтер не отвечает", action: "Проверьте питание и сеть принтера.", technical: "PRINTER_OFFLINE", overridable: false }]
    })
  ],
  confirmations: [
    { code: "bed_clear", label: "Стол свободен", detail: "На столе осталась готовая модель — снимите её перед запуском.", required: true, effect: "Подтверждение записывает очистку стола от вашего имени." }
  ],
  activeRunId: null,
  primaryProblem: null,
  unresolvedRunId: null,
  feed: null
};

const artifacts = [
  {
    artifact: { id: "art_stl", name: "держатель-для-инструмента-настенный-большой.stl", kind: "model", createdAt: ISO, sizeBytes: 1_284_000 },
    task: { id: "task_stl", state: "DRAFT", title: "держатель-для-инструмента-настенный-большой.stl" },
    analysis: { state: "ready", verdict: "needs_preparation", detectedFormat: "stl", warnings: [], blockers: [] },
    status: { executable: false, next: { kind: "slice", label: "Нарезать", explanation: "Это модель — её нужно нарезать под принтер", actionable: true, taskId: "task_stl" } }
  },
  {
    artifact: { id: "art_g", name: LONG, kind: "gcode", createdAt: ISO, sizeBytes: 4_812_000 },
    task: { id: "t1", state: "QUEUED", title: LONG },
    analysis: { state: "ready", verdict: "schedulable", detectedFormat: "gcode", warnings: [], blockers: [] },
    status: { executable: true, next: { kind: "queued", explanation: "В очереди", taskId: "t1" } }
  }
];

const sets = [
  { id: "set_k2", name: "K2 · PETG 0.4 · стандарт", approved: true, validation: "valid", printerId: "creality-k2", printerClass: null, warnings: [], blockers: [] },
  { id: "set_a1", name: "A1 · PLA 0.4 · качество", approved: true, validation: "valid", printerId: "bambu-a1", printerClass: null, warnings: [], blockers: [] }
];

const historyEntry = (over) => ({
  taskId: "task_done",
  title: LONG,
  state: "COMPLETED",
  reason: null,
  createdAt: ISO,
  closedAt: ISO,
  material: "PETG",
  run: { id: "run_1", printerId: "creality-k2", printerName: "Creality K2", state: "SUCCEEDED", startedAt: ISO, endedAt: ISO, durationS: 11_400, filamentUsedG: 41 },
  runCount: 1,
  file: { artifactId: "art_g", name: LONG, sha256: "a".repeat(64), sizeBytes: 4_812_000 },
  source: { artifactId: "art_stl", name: "держатель-для-инструмента-настенный-большой.stl" },
  recipe: {
    variantId: "slc_1",
    profileSetId: "set_k2",
    profileSetName: "K2 · PETG 0.4 · стандарт",
    profileSetUsable: true,
    machine: "Creality K2 PETG 0.4",
    process: "K2 PETG 0.4",
    filament: "PETG @K2",
    targetPrinterId: "creality-k2",
    targetPrinterClass: null,
    scaleFactor: 1,
    orcaVersion: "2.3.0",
    etaS: 11_000,
    filamentG: 40
  },
  lineage: { reprintOf: null, previousTaskId: null, reprintedAs: [] },
  actions: {
    reprint: { allowed: true, code: null, reason: null, route: "variant" },
    retry: { allowed: false, code: "not_failed", reason: null },
    reprepare: { artifactId: "art_stl", printerId: "creality-k2", profileSetId: "set_k2" }
  },
  ...over
});

const history = [
  historyEntry({}),
  historyEntry({
    taskId: "task_failed",
    title: "крышка-корпуса-датчика.gcode",
    state: "FAILED",
    reason: "отлип от стола на 34-м слое",
    run: { id: "run_2", printerId: "bambu-a1", printerName: "Bambu Lab A1 Combo", state: "FAILED", startedAt: ISO, endedAt: ISO, durationS: 1900, filamentUsedG: 6 },
    actions: {
      reprint: { allowed: true, code: null, reason: null, route: "executable" },
      retry: { allowed: true, code: null, reason: null },
      reprepare: null
    }
  }),
  historyEntry({
    taskId: "task_gone",
    title: "старая-модель.stl",
    actions: {
      reprint: { allowed: false, code: "file_deleted", reason: "файл удалён из хранилища — подготовьте модель заново", route: null },
      retry: { allowed: false, code: "not_failed", reason: null },
      reprepare: { artifactId: "art_stl", printerId: "creality-k2", profileSetId: "set_k2" }
    }
  })
];

const autoQueue = {
  status: {
    configured: false,
    armed: false,
    running: false,
    intervalMs: 60000,
    startupDelayMs: 120000,
    maxStartsPerTick: 1,
    retryCooldownMs: 900000,
    startedAt: null,
    lastTickAt: null,
    lastResult: null,
    recent: [],
    cooldowns: [],
    haltedReason: null
  },
  plan: [
    { at: ISO, taskId: "t1", title: LONG, outcome: "waiting", printerId: "creality-k2", printerName: "Creality K2", message: "загруженный материал неизвестен — Klipper сообщает его только во время печати, подтвердить некому", code: "MATERIAL_UNKNOWN", runId: null },
    { at: ISO, taskId: "t2", title: "крышка-корпуса-датчика.gcode", outcome: "waiting", printerId: "bambu-a1", printerName: "Bambu Lab A1 Combo", message: "на столе осталась готовая модель — снимите её и подтвердите очистку стола", code: "BED_NOT_CLEAR", runId: null },
    { at: ISO, taskId: "t3", title: "ручка.stl", outcome: "not_allowed", printerId: null, printerName: null, message: "нет разрешения печатать без оператора — автоочередь такое задание не трогает", code: "UNATTENDED_NOT_ALLOWED", runId: null }
  ]
};

const API = {
  "/api/dashboard": {
    ...MOCK_DASHBOARD,
    printers,
    queue,
    system: [
      { name: "Оркестратор", val: "работает · v0.1.0", ok: "ok" },
      { name: "OrcaSlicer", val: "2.3.0 · проверен нарезкой", ok: "ok" },
      { name: "Склад филамента", val: "нет связи с fulfillment — списания в очереди повторов", ok: "warn" }
    ],
    automations: [
      { id: "night-lights", name: "Подсветка по солнечному расписанию", desc: "Включает свет активным принтерам от заката до рассвета и на время открытой панели", on: true },
      { id: "night-queue", name: "Подсказки ночной печати", desc: "Подбирает из очереди безопасную деталь на ночь и оценивает риск", on: true },
      { id: "auto-queue", name: "Автоочередь", desc: "Сама запускает следующее задание на свободном принтере — только задания с разрешением печатать без оператора", on: false, locked: "автоочередь выключена при развёртывании (AUTO_QUEUE_ENABLED=false)" }
    ]
  },
  "/api/printers": printers,
  "/api/print/launch": { ok: true, rows: readinessRows },
  "/api/print/launch/t2": { ok: true, preview: launchPreview },
  "/api/print/artifacts": { artifacts },
  "/api/print/slicing/runtime": {
    runtime: { available: true },
    profileCounts: { active: 17, quarantined: 0, invalid: 0, total: 17 },
    missingParents: [],
    coverage: printers.map((p) => ({ printerId: p.id, printerName: p.name, model: p.model, printerClass: null, hasAnyProfile: true, hasActiveProfile: true, activeProfileName: p.name }))
  },
  "/api/print/slicing/profile-sets": { sets },
  "/api/print/history": { entries: history, nextCursor: null },
  "/api/automations/auto-queue": autoQueue
};

// ── The walk ─────────────────────────────────────────────────────────────────

/** Measured in the page: horizontal page scroll, and visible elements past the right edge. */
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const pageOverflow = document.documentElement.scrollWidth - vw;
  const scrollsX = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };
  const offenders = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || s.position === "fixed") continue;
    if (r.right > vw + 1 && !scrollsX(el)) {
      offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60), text: (el.textContent || "").trim().slice(0, 50), right: Math.round(r.right), width: Math.round(r.width) });
    }
  }
  return { vw, pageOverflow, offenders: offenders.slice(0, 8), count: offenders.length };
})()`;

const version = await probeCdp();

test("раскладка: Зал, «Новая печать», «История», «Автоматизации», окно запуска — на 4 ширинах", { skip: version ? false : `no CDP browser at ${CDP_URL}` }, async () => {
  const mock = await startMockServer({ api: API });
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const problems = [];

  try {
    for (const vp of VIEWPORTS) {
      const target = await (await fetch(`${CDP_URL}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
      const cdp = await connect(target.webSocketDebuggerUrl);
      const evalValue = async (expression) => {
        const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        return result.value;
      };
      const waitFor = async (expression, what) => {
        for (let i = 0; i < 160; i++) {
          if (await evalValue(expression)) return;
          await new Promise((r) => setTimeout(r, 250));
        }
        assert.fail(`${vp.name}: timed out waiting for ${what}`);
      };
      const click = (selector) => evalValue(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return Boolean(el); })()`);
      const settle = () => new Promise((r) => setTimeout(r, 400));

      const inspect = async (view, mustSee) => {
        await settle();
        const m = await evalValue(MEASURE);
        if (m.pageOverflow > 1) problems.push(`${vp.name}/${view}: страница шире экрана на ${m.pageOverflow}px`);
        if (m.count > 0) problems.push(`${vp.name}/${view}: ${m.count} элемент(ов) за правым краем: ${JSON.stringify(m.offenders)}`);
        for (const selector of mustSee) {
          const box = await evalValue(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, right: r.right }; })()`);
          if (!box) problems.push(`${vp.name}/${view}: нет «${selector}»`);
          else if (box.w < 1 || box.h < 1) problems.push(`${vp.name}/${view}: «${selector}» нулевого размера`);
          else if (box.right > m.vw + 1 || box.left < -1) problems.push(`${vp.name}/${view}: «${selector}» за краем экрана`);
        }
        if (SHOTS) {
          const metrics = await cdp.send("Page.getLayoutMetrics");
          const height = Math.min(Math.ceil(metrics.cssContentSize?.height ?? vp.height), 7000);
          const shot = await cdp.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: vp.width, height, scale: 1 }
          });
          fs.writeFileSync(path.join(SHOTS, `${vp.name}-${view}.png`), Buffer.from(shot.data, "base64"));
        }
      };

      try {
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        // A tab opened over CDP starts in the background, where timers are
        // throttled and the board took minutes to render.
        await cdp.send("Page.bringToFront");
        await cdp.send("Page.navigate", { url: mock.url });
        await waitFor("document.readyState === 'complete' && Boolean(document.querySelector('.mode-tab[data-mode=\"works\"]'))", "the page");
        // Navigate first, resize after: an emulated viewport set on a blank tab
        // leaves the page background-throttled (see dashboard-browser notes).
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
        await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

        // Зал: принтеры и очередь с реальными причинами.
        await click('.mode-tab[data-mode="hall"]');
        await waitFor("document.querySelectorAll('#printers .printer-card').length >= 3", "three printer cards");
        await waitFor("Boolean(document.querySelector('#queue [data-act=\"launch\"]'))", "the queue's launch buttons");
        await inspect("hall", ['#queue [data-act="launch"]']);

        // Окно запуска для задания, которому нужно подтверждение стола.
        await click('#queue [data-act="launch"][data-task="t2"]');
        await waitFor("Boolean(document.querySelector('#modal-content [data-launch-go]'))", "the launch window");
        await inspect("launch", ["#modal-content [data-launch-go]", "#modal-content [data-launch-confirm]"]);
        await click(".modal-x[data-modal-close]");
        await settle();

        // Работы → «Новая печать»: файл → принтер.
        await click('.mode-tab[data-mode="works"]');
        await click('[data-work-tab="newprint"]');
        await waitFor("Boolean(document.querySelector('[data-np-action=\"pick-file\"]'))", "the wizard's file list");
        await inspect("newprint-file", ['[data-np-action="pick-file"]']);
        await click('[data-np-action="pick-file"][data-id="art_stl"]');
        await waitFor("Boolean(document.querySelector('[data-np-action=\"pick-printer\"]'))", "the wizard's printer list");
        await inspect("newprint-printer", ['[data-np-action="pick-printer"]']);

        // «История».
        await click('[data-work-tab="history"]');
        await waitFor("document.querySelectorAll('#history-body [data-hist-entry]').length >= 3", "three history cards");
        await inspect("history", []);

        // «Автоматизации».
        await click('[data-work-tab="automations"]');
        await waitFor("Boolean(document.querySelector('#auto-queue-body')) && document.querySelector('#auto-queue-body').textContent.includes('Klipper')", "the automatic queue's dry run");
        await inspect("automations", []);

        assert.deepEqual(cdp.exceptions, [], `${vp.name}: no uncaught page errors`);
      } finally {
        cdp.close();
        await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
      }
    }
  } finally {
    await mock.close();
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});
