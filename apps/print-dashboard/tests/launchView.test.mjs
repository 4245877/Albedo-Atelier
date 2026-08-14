import assert from "node:assert/strict";
import { test } from "node:test";

import { costLine, launchModalHtml, specLine, stateLabel } from "../features/launch/view.js";

/*
 * Разметка окна запуска печати.
 *
 * Раздел переделывался ради одного сценария: задание «3U-default.3mf» стояло со
 * статусом «ГОТОВО К ЗАПУСКУ», рядом была кнопка «Запустить», а печать не
 * начиналась — и понять, чего не хватает, из интерфейса было невозможно.
 * Проверяется именно это: что окно показывает ЧТО и КУДА поедет, называет
 * причину выбора, требует физические подтверждения там, где они нужны, и не
 * даёт нажать главную кнопку, когда запуск невозможен.
 */

const candidate = (over = {}) => ({
  printerId: "bambu-a1",
  printerName: "Bambu Lab A1 Combo",
  verdict: "compatible",
  blockers: [],
  reviews: [],
  warnings: [],
  online: true,
  status: "idle",
  loadedMaterial: "PETG",
  requiredMaterial: "PETG",
  printerNozzleMm: 0.4,
  requiredNozzleMm: 0.4,
  deviceFile: "verified",
  queueLength: 0,
  pendingManualOperations: 0,
  remoteStartSupported: true,
  eligible: true,
  score: 109,
  scoreBreakdown: [{ code: "material_loaded", label: "PETG уже заправлен", points: 40 }],
  reason: "Bambu Lab A1 Combo: PETG уже заправлен, принтер свободен",
  problems: [],
  ...over
});

const preview = (over = {}) => ({
  taskId: "task_1",
  title: "3U-default.3mf",
  displayTitle: "3U-default",
  state: "ready",
  material: "PETG",
  nozzleMm: 0.4,
  etaSeconds: 5329,
  etaText: "≈ 1 ч 29 мин",
  filamentG: 31.1,
  materialSource: "external",
  recommendedPrinterId: "bambu-a1",
  candidates: [candidate()],
  confirmations: [],
  activeRunId: null,
  primaryProblem: null,
  unresolvedRunId: null,
  ...over
});

const ui = (over = {}) => ({
  mode: "auto",
  selectedPrinterId: "bambu-a1",
  confirmed: new Set(),
  busy: false,
  error: null,
  done: null,
  ...over
});

const BED_CONFIRM = {
  code: "bed_clear",
  label: "Стол свободен",
  detail: "Система не знает, что сейчас на столе. Проверьте, что он пуст.",
  required: true
};

/** Готова ли главная кнопка к нажатию. */
function ctaEnabled(html) {
  const match = html.match(/<button[^>]*data-launch-go[^>]*>/);
  assert.ok(match, "главная кнопка должна присутствовать всегда");
  return !match[0].includes("disabled");
}

/* ── Строки сводки ─────────────────────────────────────────── */

test("сводка показывает измеренные факты, а не прочерки", () => {
  assert.equal(specLine(preview()), "PETG · 0.4 мм");
  assert.equal(costLine(preview()), "≈ 1 ч 29 мин · ≈ 31 г");
});

test("неизвестное не превращается в «—» и не выдумывается", () => {
  const bare = preview({ material: null, nozzleMm: null, etaText: null, filamentG: null });
  assert.equal(specLine(bare), "");
  assert.equal(costLine(bare), "");
});

test("статус задачи переводится в человеческую подпись", () => {
  assert.equal(stateLabel("ready").text, "Готово к печати");
  // Обобщённая подпись: конкретику («Стол свободен», «Установлен PETG») несёт
  // сам чекбокс, потому что подтверждений может быть больше одного.
  assert.equal(stateLabel("needs_confirmation").text, "Нужно подтверждение");
  assert.equal(stateLabel("blocked").text, "Не готово");
});

/* ── Основное окно ─────────────────────────────────────────── */

test("окно называет модель, принтер и ресурсы, и не показывает расширение файла", () => {
  const html = launchModalHtml(preview(), ui());
  assert.match(html, /3U-default/);
  assert.doesNotMatch(html, /3U-default\.3mf/, "оператор назвал модель, а не контейнер");
  assert.match(html, /Bambu Lab A1 Combo/);
  assert.match(html, /PETG/);
  assert.match(html, /1 ч 29 мин/);
});

test("готовое задание даёт нажать главную кнопку с именем принтера", () => {
  const html = launchModalHtml(preview(), ui());
  assert.ok(ctaEnabled(html));
  assert.match(html, /Запустить на «Bambu Lab A1 Combo»/);
});

test("автоматический режим объясняет, почему выбран этот принтер", () => {
  const html = launchModalHtml(preview(), ui());
  assert.match(html, /PETG уже заправлен/);
});

test("внешняя катушка названа прямо, а не показана пустым списком слотов", () => {
  const html = launchModalHtml(preview({ materialSource: "external" }), ui());
  assert.match(html, /внешняя катушка/);
});

/* ── Подтверждения ─────────────────────────────────────────── */

test("неподтверждённый стол блокирует кнопку и показывает чекбокс", () => {
  const html = launchModalHtml(
    preview({ state: "needs_confirmation", confirmations: [BED_CONFIRM] }),
    ui()
  );
  assert.match(html, /Стол свободен/);
  assert.match(html, /data-launch-confirm/);
  assert.equal(ctaEnabled(html), false, "нельзя запустить, пока стол не подтверждён");
});

test("поставленная галочка разблокирует запуск", () => {
  const html = launchModalHtml(
    preview({ state: "needs_confirmation", confirmations: [BED_CONFIRM] }),
    ui({ confirmed: new Set(["bed_clear"]) })
  );
  assert.ok(ctaEnabled(html));
});

test("необязательные подтверждения не держат кнопку", () => {
  const html = launchModalHtml(
    preview({ confirmations: [{ ...BED_CONFIRM, required: false }] }),
    ui()
  );
  assert.ok(ctaEnabled(html));
});

/* ── Отказы ────────────────────────────────────────────────── */

test("блокер выключает кнопку и показывает действие, а не код", () => {
  const blocked = candidate({
    eligible: false,
    blockers: [{ code: "printer_offline", message: "Принтер «Bambu Lab A1 Combo» не в сети" }],
    reason: "Принтер «Bambu Lab A1 Combo» не в сети",
    problems: [
      {
        code: "printer_offline",
        kind: "blocker",
        title: "Принтер недоступен",
        action: "Принтер не отвечает по сети. Проверьте питание и подключение.",
        technical: "printer_offline: не в сети"
      }
    ]
  });
  const html = launchModalHtml(
    preview({ state: "blocked", candidates: [blocked] }),
    ui()
  );

  assert.equal(ctaEnabled(html), false);
  assert.match(html, /Проверьте питание и подключение/, "показываем действие");
});

test("технические коды прячутся в свёрнутую диагностику, а не в основной текст", () => {
  const html = launchModalHtml(preview(), ui());
  assert.match(html, /<details/, "диагностика существует");
  assert.match(html, /Технические подробности/);
  // Идентификаторы задачи не должны попадаться оператору до раскрытия <details>.
  const beforeDetails = html.slice(0, html.indexOf("<details"));
  assert.doesNotMatch(beforeDetails, /task_1/);
});

test("отсутствие подходящего принтера сказано словами", () => {
  const html = launchModalHtml(
    preview({ state: "blocked", recommendedPrinterId: null, candidates: [] }),
    ui({ selectedPrinterId: null })
  );
  assert.match(html, /Нет принтера, готового принять это задание/);
  assert.equal(ctaEnabled(html), false);
});

/* ── Ручной выбор ──────────────────────────────────────────── */

test("ручной режим показывает карточки принтеров с фактами и причинами", () => {
  const k2 = candidate({
    printerId: "k2",
    printerName: "Creality K2",
    eligible: false,
    loadedMaterial: "PLA",
    blockers: [{ code: "material_mismatch", message: "Материал не совпадает" }],
    problems: [
      {
        code: "material_mismatch",
        kind: "blocker",
        title: "Не тот материал",
        action: "Заправленный пруток не совпадает.",
        technical: "material_mismatch: …"
      }
    ]
  });
  const html = launchModalHtml(
    preview({ candidates: [candidate(), k2] }),
    ui({ mode: "manual" })
  );

  assert.match(html, /Выберите принтер/);
  assert.match(html, /data-launch-pick/);
  assert.match(html, /Bambu Lab A1 Combo/);
  assert.match(html, /Creality K2/);
  assert.match(html, /сопло 0.4 мм/);
  assert.match(html, /Не тот материал/, "непригодный принтер объясняет причину");
  assert.match(html, /несовместим/);
});

test("несовместимый принтер нельзя выбрать", () => {
  const blocked = candidate({ printerId: "k2", printerName: "Creality K2", eligible: false });
  const html = launchModalHtml(preview({ candidates: [blocked] }), ui({ mode: "manual" }));
  const radio = html.match(/<input[^>]*value="k2"[^>]*>/);
  assert.ok(radio);
  assert.match(radio[0], /disabled/);
});

test("режимы переключаются одной вторичной кнопкой", () => {
  const auto = launchModalHtml(preview(), ui());
  assert.match(auto, /data-launch-mode="manual"[\s\S]*?Выбрать принтер вручную/);

  const manual = launchModalHtml(preview(), ui({ mode: "manual" }));
  assert.match(manual, /data-launch-mode="auto"/);
});

/* ── Защита от двойного запуска ────────────────────────────── */

test("во время запуска кнопка заблокирована и говорит «Запускаю…»", () => {
  const html = launchModalHtml(preview(), ui({ busy: true }));
  assert.match(html, /Запускаю…/);
  assert.equal(ctaEnabled(html), false, "второй клик не должен пройти");
});

test("после успеха окно показывает результат вместо кнопки запуска", () => {
  const html = launchModalHtml(
    preview(),
    ui({ done: { printerName: "Bambu Lab A1 Combo" } })
  );
  assert.match(html, /Печать запущена/);
  assert.doesNotMatch(html, /data-launch-go/, "нечего нажимать второй раз");
});

test("ошибка запуска показывается, и кнопка снова доступна для повтора", () => {
  const html = launchModalHtml(preview(), ui({ error: "Соединение с принтером прервалось" }));
  assert.match(html, /Соединение с принтером прервалось/);
  assert.ok(ctaEnabled(html), "повтор безопасен — ключ идемпотентности тот же");
});

/* ── Карточка очереди ──────────────────────────────────────── */

import { queueJobSubtitle, queueJobTitle } from "../render/sections.js";

const job = (over = {}) => ({
  id: "task_1",
  title: "3U-default.3mf",
  printer: "bambu-a1-combo",
  material: "PETG",
  eta: "≈ 1 ч 29 мин",
  status: "ready",
  nozzleMm: 0.4,
  etaSeconds: 5329,
  filamentG: 31.1,
  ...over
});

const PRINTERS = [{ id: "bambu-a1-combo", name: "Bambu Lab A1 Combo" }];

test("заголовок карточки очереди — имя модели без расширения", () => {
  assert.equal(queueJobTitle(job()), "3U-default");
  assert.equal(queueJobTitle({ title: "part.gcode.3mf" }), "part");
  assert.equal(queueJobTitle({ title: "no-extension" }), "no-extension");
  assert.equal(queueJobTitle({}), "");
});

test("подпись показывает ИМЯ принтера, материал, сопло, время и вес", () => {
  assert.equal(
    queueJobSubtitle(job(), PRINTERS),
    "Bambu Lab A1 Combo · PETG · 0.4 мм · ≈ 1 ч 29 мин · ≈ 31 г"
  );
});

test("подпись не падает и не выдумывает, когда списка принтеров нет", () => {
  // Регрессия: `printers` не был параметром `queueRow`, поэтому в браузере
  // разрешался в элемент DOM с id="printers", и весь раздел очереди падал
  // молча — секция просто оставалась пустой.
  assert.doesNotThrow(() => queueJobSubtitle(job(), undefined));
  assert.match(queueJobSubtitle(job(), undefined), /^bambu-a1-combo · PETG/);
  assert.doesNotThrow(() => queueJobSubtitle(job(), null));
});

test("прочерки не попадают в подпись — пропускаем неизвестное", () => {
  const bare = job({ material: "—", eta: "—", nozzleMm: undefined, filamentG: undefined });
  assert.equal(queueJobSubtitle(bare, PRINTERS), "Bambu Lab A1 Combo");
});

test("совсем пустое задание говорит об этом словами", () => {
  const nothing = { id: "t", title: "x", printer: "—", material: "—", eta: "—", status: "ready" };
  assert.equal(queueJobSubtitle(nothing, PRINTERS), "данные готовятся");
});

/* ── Одна причина вместо четырёх ──────────────────────────────────

   Реальный сбой: принтер не смог прочитать карту MicroSD, а окно показывало
   «Принтер занят», «Принтер в ошибке», «Принтер недоступен» и «Неизвестно
   сопло» одновременно. Три из четырёх — следствия первой, а настоящая причина
   (код 0500-C010 на экране самого принтера) не показывалась вовсе. */

const microSdProblem = {
  code: "printer_fault",
  kind: "blocker",
  title: "Принтер сообщает об ошибке",
  action:
    "«Bambu Lab A1 Combo» не может начать печать: Ошибка чтения/записи карты MicroSD " +
    "(0500-C010). Переустановите карту или замените её, затем повторите запуск.",
  technical: "printer_fault: Ошибка чтения/записи карты MicroSD (0500-C010)"
};

const noisyProblems = [
  microSdProblem,
  {
    code: "printer_error",
    kind: "blocker",
    title: "Принтер сообщает об ошибке",
    action: "Посмотрите экран принтера и устраните ошибку.",
    technical: "printer_error: Принтер «Bambu Lab A1 Combo» в ошибке"
  },
  {
    code: "printer_nozzle_unknown",
    kind: "confirmable",
    title: "Диаметр сопла неизвестен",
    action: "Укажите диаметр сопла в настройках принтера.",
    technical: "printer_nozzle_unknown: Диаметр сопла неизвестен"
  },
  {
    code: "printer_busy",
    kind: "info",
    title: "Принтер занят",
    action: "Сейчас идёт другая печать.",
    technical: "printer_busy: Принтер сейчас занят"
  }
];

test("показывается ОДНА главная причина, выбранная сервером", () => {
  const html = launchModalHtml(
    preview({
      state: "blocked",
      primaryProblem: microSdProblem,
      candidates: [candidate({ eligible: false, problems: noisyProblems })]
    }),
    ui()
  );

  assert.match(html, /0500-C010/, "код с экрана принтера — в основном тексте");
  assert.match(html, /Переустановите карту/, "и что с этим делать");
  assert.equal(ctaEnabled(html), false);

  // Остальные причины не исчезли — они ушли в диагностику, ниже <details>.
  const main = html.split("<details")[0];
  assert.doesNotMatch(main, /Посмотрите экран принтера/, "следствие не спорит с причиной");
  assert.doesNotMatch(main, /Диаметр сопла неизвестен/);
  assert.match(html, /printer_nozzle_unknown/, "но остаётся доступной для разбора");
});

/* ── Неподтверждённый запуск ──────────────────────────────────── */

test("неподтверждённый запуск не выдаётся за «печатается»", () => {
  assert.equal(stateLabel("unconfirmed").text, "Запуск не подтверждён");
  assert.notEqual(stateLabel("unconfirmed").text, stateLabel("running").text);
});

test("у неподтверждённого запуска есть выход прямо в окне", () => {
  const html = launchModalHtml(
    preview({
      state: "unconfirmed",
      activeRunId: "run_1",
      unresolvedRunId: "run_1",
      primaryProblem: {
        code: "launch_unconfirmed",
        kind: "blocker",
        title: "Прошлый запуск не подтверждён",
        action: "Посмотрите на принтер и отметьте, что произошло.",
        technical: "launch_unconfirmed: предыдущий запуск не подтверждён"
      },
      candidates: [candidate({ eligible: false, problems: [] })]
    }),
    ui()
  );

  assert.match(html, /data-launch-resolve="FAILED"/, "«печать не началась»");
  assert.match(html, /data-launch-resolve="SUCCEEDED"/, "«печать идёт / прошла»");
  assert.match(html, /Запуск не подтверждён/);
});

test("без неподтверждённого запуска кнопок разрешения нет", () => {
  const html = launchModalHtml(preview(), ui());
  assert.doesNotMatch(html, /data-launch-resolve/);
});
