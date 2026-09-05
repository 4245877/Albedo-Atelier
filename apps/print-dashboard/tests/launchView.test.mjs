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

  // Правило «одна причина» действует между ОТКАЗАМИ: три блокера из четырёх
  // были следствиями первого, и место им в диагностике.
  const main = html.split("<details")[0];
  assert.doesNotMatch(main, /Посмотрите экран принтера/, "следствие не спорит с причиной");

  // А вот открытый вопрос — не следствие отказа, а отдельное требование, и
  // прятать его вместе со следствиями значило отвечать на «почему не печатает»
  // по частям: оператор чинил карту памяти и только тогда узнавал, что сопло
  // всё ещё не указано. Он остаётся на виду, но подписан как «понадобится
  // дальше» и приглушён, чтобы не соперничать с причиной отказа.
  assert.match(main, /Диаметр сопла неизвестен/, "требование не прячется за отказом");
  assert.match(main, /launch-open is-later/, "но и не выдаётся за вторую причину");
  assert.doesNotMatch(main, /Требует внимания/, "заголовок уступает: не «сейчас», а «дальше»");
  assert.match(html, /printer_nozzle_unknown/, "и остаётся доступной для разбора");
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

/* ── Принятие ответственности за «review» ─────────────────────

   Дефект был не в отказе, а в его безвыходности. Кандидат со статусом `review`
   — «система не может проверить, а человек может» — выглядел так же, как
   жёстко несовместимый: кнопка выключена, радиокнопка в ручном списке
   заблокирована, и никакого способа сказать «я посмотрел, всё в порядке» из
   единственного окна, откуда вообще запускают печать. Сервер такое решение
   принимает с самого начала (override с причиной и оператором, с записью в
   журнал) — до него просто нечему было дойти. */

/** Кандидат, которому не хватает только человеческого подтверждения. */
const reviewCandidate = (over = {}) =>
  candidate({
    eligible: false,
    reason: "Bambu Lab A1 Combo: нужно подтверждение оператора",
    problems: [
      {
        code: "material_mismatch",
        kind: "confirmable",
        title: "Материал не совпадает",
        action: "Проверьте, что заряжен PETG.",
        technical: "material_mismatch: заряжен PLA, требуется PETG",
        overridable: true
      }
    ],
    ...over
  });

const reviewPreview = (over = {}) =>
  preview({
    state: "needs_confirmation",
    recommendedPrinterId: "bambu-a1",
    candidates: [reviewCandidate()],
    primaryProblem: reviewCandidate().problems[0],
    ...over
  });

test("review предлагает путь дальше, а не только отказ", () => {
  const html = launchModalHtml(reviewPreview(), ui());
  assert.match(html, /launch-override/, "блок принятия ответственности должен быть показан");
  assert.match(html, /Материал не совпадает/, "оператор должен видеть, ЧТО именно принимает");
  assert.match(html, /data-launch-override-accept/);
  assert.match(html, /data-launch-override-reason/);
  // Но пока ничего не принято — кнопка по-прежнему выключена.
  assert.equal(ctaEnabled(html), false, "сам по себе показ блока ничего не разрешает");
});

test("нужны и галочка, и причина — по отдельности они не запускают", () => {
  const onlyTicked = launchModalHtml(reviewPreview(), ui({ overrideAccepted: true, overrideReason: "" }));
  assert.equal(ctaEnabled(onlyTicked), false, "подтверждение без причины — не подтверждение");

  const onlyText = launchModalHtml(
    reviewPreview(),
    ui({ overrideAccepted: false, overrideReason: "проверил катушку" })
  );
  assert.equal(ctaEnabled(onlyText), false, "причина без явного принятия ответственности ничего не решает");

  const both = launchModalHtml(
    reviewPreview(),
    ui({ overrideAccepted: true, overrideReason: "проверил катушку — PETG" })
  );
  assert.equal(ctaEnabled(both), true);
  assert.match(both, /под ответственность/, "кнопка должна называть, что именно делает");
});

test("пробелы вместо причины не считаются причиной", () => {
  const html = launchModalHtml(reviewPreview(), ui({ overrideAccepted: true, overrideReason: "   \n  " }));
  assert.equal(ctaEnabled(html), false);
});

test("жёсткий блокер не превращается в предложение его принять", () => {
  // Занятый стол не подтверждается словами: сервер такой код не снимет, и
  // предлагать это оператору значит обещать то, чего не будет.
  const hard = reviewPreview({
    candidates: [
      reviewCandidate({
        problems: [
          {
            code: "bed_not_clear",
            kind: "blocker",
            title: "Стол занят",
            action: "Снимите предыдущую модель.",
            technical: "bed_not_clear: на столе прошлая печать",
            overridable: false
          }
        ]
      })
    ],
    primaryProblem: null
  });
  const html = launchModalHtml(hard, ui({ overrideAccepted: true, overrideReason: "всё нормально" }));
  assert.doesNotMatch(html, /launch-override\b/);
  assert.equal(ctaEnabled(html), false);
});

test("одна неснимаемая проверка отменяет предложение целиком", () => {
  // «Либо всё, либо ничего»: смешанный список привёл бы к отказу сервера уже
  // после того, как оператор взял ответственность на себя.
  const mixed = reviewPreview({
    candidates: [
      reviewCandidate({
        problems: [
          {
            code: "material_mismatch",
            kind: "confirmable",
            title: "Материал не совпадает",
            action: "Проверьте катушку.",
            technical: "material_mismatch: …",
            overridable: true
          },
          {
            code: "launch_unconfirmed",
            kind: "confirmable",
            title: "Прошлый запуск не подтверждён",
            action: "Разберитесь с предыдущей попыткой.",
            technical: "launch_unconfirmed: …",
            overridable: false
          }
        ]
      })
    ],
    primaryProblem: null
  });
  const html = launchModalHtml(mixed, ui({ overrideAccepted: true, overrideReason: "проверил" }));
  assert.doesNotMatch(html, /launch-override\b/);
  assert.equal(ctaEnabled(html), false);
});

test("в ручном списке review-принтер можно ВЫБРАТЬ, а несовместимый — нет", () => {
  const both = reviewPreview({
    candidates: [
      reviewCandidate(),
      candidate({
        printerId: "k2",
        printerName: "Creality K2",
        eligible: false,
        problems: [
          {
            code: "nozzle_mismatch",
            kind: "blocker",
            title: "Сопло не то",
            action: "Смените сопло.",
            technical: "nozzle_mismatch: 0.6 вместо 0.4",
            overridable: false
          }
        ]
      })
    ]
  });
  const html = launchModalHtml(both, ui({ mode: "manual" }));
  const cards = html.split("launch-cand ").slice(1);
  assert.equal(cards.length, 2);
  assert.doesNotMatch(cards[0], /disabled/, "review-кандидат обязан быть выбираемым");
  assert.match(cards[0], /нужно подтверждение/);
  assert.match(cards[1], /disabled/, "жёстко несовместимый — нет");
  assert.match(cards[1], /несовместим/);
});

test("совместимый принтер не спрашивают об ответственности", () => {
  const html = launchModalHtml(preview(), ui());
  assert.doesNotMatch(html, /launch-override\b/);
  assert.equal(ctaEnabled(html), true);
});

test("физические подтверждения не подменяются принятием ответственности", () => {
  // Стол и катушка — вопросы к человеку у машины, а не к его готовности
  // отвечать за последствия. Одно не заменяет другое.
  const html = launchModalHtml(
    reviewPreview({ confirmations: [BED_CONFIRM] }),
    ui({ overrideAccepted: true, overrideReason: "проверил катушку" })
  );
  assert.equal(ctaEnabled(html), false, "необходимая галочка всё ещё необходима");

  const done = launchModalHtml(
    reviewPreview({ confirmations: [BED_CONFIRM] }),
    ui({ overrideAccepted: true, overrideReason: "проверил катушку", confirmed: new Set(["bed_clear"]) })
  );
  assert.equal(ctaEnabled(done), true);
});

/* ── Открытые вопросы рядом с жёстким отказом ───────────────────

   Дефект: блок «Требует внимания» исчезал целиком, если у кандидата был хоть
   один блокер. Профиль не утверждён, габариты не подтверждены, раскладка
   филаментов не задана — всё это оставалось только в свёрнутых «Технических
   подробностях». Оператор снимал блокер и узнавал о следующем требовании со
   следующего запроса, по одному пункту за круг.

   Правило: полнота ответа и приоритет причины — разные вещи. Список остаётся
   на месте всегда; при блокере он подписан как «понадобится дальше» и
   приглушён, а заметной остаётся ровно одна причина отказа. */

const OPEN_QUESTION = {
  code: "PROFILE_SET_NOT_APPROVED",
  kind: "confirmable",
  title: "Профиль не утверждён",
  action: "Утвердите набор профилей в разделе слайсинга.",
  technical: "PROFILE_SET_NOT_APPROVED: набор профилей не утверждён",
  overridable: false
};

const HARD_BLOCKER = {
  code: "PRINTER_OFFLINE",
  kind: "blocker",
  title: "Принтер недоступен",
  action: "Принтер не отвечает по сети. Проверьте питание и подключение.",
  technical: "PRINTER_OFFLINE: принтер не в сети",
  overridable: false
};

test("открытые вопросы видны и без блокера, и вместе с ним", () => {
  const clean = launchModalHtml(
    preview({ candidates: [candidate({ problems: [OPEN_QUESTION] })] }),
    ui()
  );
  assert.match(clean, /Требует внимания/);
  assert.match(clean, /Профиль не утверждён/);
});

test("при жёстком отказе список остаётся, но уступает первенство причине", () => {
  const html = launchModalHtml(
    preview({
      state: "blocked",
      recommendedPrinterId: null,
      primaryProblem: HARD_BLOCKER,
      candidates: [
        candidate({ eligible: false, blockers: [HARD_BLOCKER], problems: [HARD_BLOCKER, OPEN_QUESTION] })
      ]
    }),
    ui()
  );

  // Причина отказа — по-прежнему одна и заметная.
  assert.match(html, /launch-reason is-blocked/);
  assert.match(html, /Принтер недоступен/);
  // …но и то, что понадобится дальше, больше не прячется в «Технических
  // подробностях»: оператор видит полный список требований сразу.
  assert.match(html, /Понадобится после этого/);
  assert.match(html, /Профиль не утверждён/);
  assert.match(html, /launch-open is-later/, "и оформлен приглушённо, а не как второй отказ");
});

test("нечего показывать — блок не появляется вовсе", () => {
  const html = launchModalHtml(
    preview({
      state: "blocked",
      recommendedPrinterId: null,
      primaryProblem: HARD_BLOCKER,
      candidates: [candidate({ eligible: false, blockers: [HARD_BLOCKER], problems: [HARD_BLOCKER] })]
    }),
    ui()
  );
  assert.doesNotMatch(html, /launch-open/);
});
