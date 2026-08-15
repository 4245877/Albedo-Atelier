import assert from "node:assert/strict";
import { test } from "node:test";

import { queueRow } from "../render/sections.js";
import { executionHtml } from "../features/slicing/view.js";
import { launchModalHtml } from "../features/launch/view.js";

/*
 * Выход из неподтверждённого запуска — со стороны интерфейса.
 *
 * Разбираемый случай. Запуск «3U-default.3mf» ушёл на Bambu A1, принтер старт не
 * подтвердил: run остался UNKNOWN со startedAt=null, задание — DISPATCHING,
 * назначение и стол — RESERVED, guard на месте. Разрешение («Печать не
 * началась») на backend уже работало и было атомарным. Нажать его было НЕЛЬЗЯ:
 *
 *   - задание в DISPATCHING проецировалось в статус `review`, а review-строка
 *     очереди — пассивная, без единой кнопки;
 *   - окно запуска (единственный дом кнопок разрешения) открывалось только с
 *     карточки «ближайшее задание», которая рисуется лишь при статусе `ready`;
 *   - зато панель «Исполнение» показывала обычное зелёное «▶ Запустить», потому
 *     что судила только по файлу на принтере (VERIFIED), и вела прямо в
 *     POST /assignments/:id/start → 409 со списком инвариантов.
 *
 * Здесь проверяется, что оператор больше не может попасть в этот тупик: решение
 * предлагается там, где он стоит, а запуск в этом состоянии не предлагается
 * вовсе — ни одной кнопкой, ни в одном разделе.
 */

/* ── Строка очереди: неподтверждённый запуск виден и имеет выход ── */

const job = (over = {}) => ({
  id: "task_1",
  title: "3U-default.3mf",
  printer: "bambu-a1-combo",
  material: "PETG",
  eta: "≈ 1 ч 29 мин",
  status: "ready",
  ...over
});

const printers = [{ id: "bambu-a1-combo", name: "Bambu Lab A1 Combo" }];

test("строка с неподтверждённым запуском говорит об этом и даёт действие", () => {
  const html = queueRow(
    job({
      status: "unconfirmed",
      unresolvedRunId: "run_1",
      reason: "принтер не подтвердил запуск «3U-default-28ab3676.gcode.3mf» — посмотрите на принтер"
    }),
    printers
  );

  assert.match(html, /запуск не подтверждён/i, "статус назван, а не спрятан в «требует проверки»");
  assert.match(html, /data-act="launch"/, "есть вход в окно разрешения");
  assert.match(html, /data-task="task_1"/);
  assert.match(html, /посмотрите на принтер/, "причина сказана словами оператора");
});

test("в строке с неподтверждённым запуском действие не называется «запустить»", () => {
  const html = queueRow(job({ status: "unconfirmed", unresolvedRunId: "run_1" }), printers);
  // Обещать здесь старт значило бы обещать то, в чём сервер обязан отказать.
  assert.doesNotMatch(html, />\s*Запустить печать\s*</);
  assert.match(html, /Разобраться с запуском/);
});

test("обычные строки очереди кнопок разрешения не отращивают", () => {
  for (const status of ["ready", "review"]) {
    const html = queueRow(job({ status }), printers);
    assert.doesNotMatch(html, /Разобраться с запуском/, status);
    assert.doesNotMatch(html, /запуск не подтверждён/i, status);
  }
});

/* ── Панель «Исполнение»: второй кнопки «Печать» больше нет ── */

const assignmentRow = (over = {}) => ({
  assignment: {
    id: "asg_1",
    taskId: "task_1",
    printerId: "bambu-a1-combo",
    state: "RESERVED",
    source: "manual",
    invalidatedAt: null,
    invalidatedReason: null,
    binding: {
      expectedRemotePath: "3U-default-28ab3676.gcode.3mf",
      material: "PETG",
      nozzleMm: 0.4,
      etaS: 5329
    }
  },
  deviceArtifact: { state: "VERIFIED", transferMode: "adapter_upload", verification: "name_and_size" },
  fileReady: true,
  unresolvedRunId: null,
  nextAction: "start",
  ...over
});

const execState = (row) => ({ assignments: [row], printers, tasks: [] });

test("«Исполнение» больше не дёргает /assignments/:id/start напрямую", () => {
  const html = executionHtml(execState(assignmentRow()));

  // Подпись без глифа: знак — inline-SVG из общего набора (shared/icons.js),
  // а не символ юникода, которого может не оказаться в шрифте оператора.
  assert.match(html, /<span>Запустить<\/span>/, "кнопка запуска на месте");
  assert.doesNotMatch(html, /[▶⏸✕☀☾⛔⚠]/, "в разметке не осталось глифов-эмодзи");
  assert.match(html, /data-slice-action="open-launch"/, "…но ведёт в общее окно запуска");
  assert.match(html, /data-task="task_1"/, "и адресует ЗАДАНИЕ, а не назначение");
  assert.doesNotMatch(
    html,
    /data-slice-action="start-assignment"/,
    "прежний прямой путь в dispatch убран: пользовательский запуск ровно один"
  );
});

test("при неподтверждённом запуске «Исполнение» не предлагает запуск вовсе", () => {
  // Ровно та ситуация, что дала 409: файл на принтере по-прежнему VERIFIED, и
  // раньше этого одного факта хватало, чтобы нарисовать зелёное «Запустить».
  const html = executionHtml(
    execState(assignmentRow({ nextAction: "resolve", unresolvedRunId: "run_1" }))
  );

  assert.doesNotMatch(html, /▶ Запустить/, "запуск не предлагается как следующий шаг");
  assert.match(html, /Запуск не подтверждён — разобраться/);
  assert.match(html, /data-slice-action="resolve-launch"/);
  assert.match(html, /data-task="task_1"/);
});

test("шаги подготовки файла не затронуты", () => {
  const prepare = executionHtml(
    execState(
      assignmentRow({
        nextAction: "prepare-file",
        fileReady: false,
        deviceArtifact: { state: "NOT_PRESENT", transferMode: "adapter_upload" }
      })
    )
  );
  assert.match(prepare, /data-slice-action="prepare-file"/);
  assert.doesNotMatch(prepare, /open-launch/);
});

/* ── Окно запуска: сначала ответ, потом запуск ── */

const candidate = (over = {}) => ({
  printerId: "bambu-a1-combo",
  printerName: "Bambu Lab A1 Combo",
  eligible: false,
  blockers: [],
  reviews: [],
  warnings: [],
  online: true,
  status: "idle",
  deviceFile: "verified",
  score: 0,
  scoreBreakdown: [],
  reason: "предыдущий запуск не подтверждён",
  problems: [],
  ...over
});

const unconfirmedPreview = (over = {}) => ({
  taskId: "task_1",
  title: "3U-default.3mf",
  displayTitle: "3U-default",
  state: "unconfirmed",
  material: "PETG",
  nozzleMm: 0.4,
  etaSeconds: 5329,
  etaText: "≈ 1 ч 29 мин",
  filamentG: 31.1,
  materialSource: "external",
  recommendedPrinterId: "bambu-a1-combo",
  candidates: [candidate()],
  confirmations: [],
  activeRunId: "run_1",
  unresolvedRunId: "run_1",
  primaryProblem: {
    code: "launch_unconfirmed",
    kind: "blocker",
    title: "Прошлый запуск не подтверждён",
    action: "Посмотрите на принтер и отметьте, что произошло.",
    technical: "launch_unconfirmed"
  },
  ...over
});

const ui = (over = {}) => ({
  mode: "auto",
  selectedPrinterId: "bambu-a1-combo",
  confirmed: new Set(),
  busy: false,
  error: null,
  done: null,
  ...over
});

test("пока попытка не разрешена, кнопки запуска в окне нет совсем", () => {
  const html = launchModalHtml(unconfirmedPreview(), ui());

  // Не «disabled»: отключённая кнопка всё равно читается как следующий шаг и
  // приглашает жать. Здесь следующий шаг ровно один — сказать, что показал
  // принтер.
  assert.doesNotMatch(html, /data-launch-go/);
  assert.match(html, /data-launch-resolve="FAILED"/);
  assert.match(html, /data-launch-resolve="SUCCEEDED"/);
  assert.match(html, /Запуск не подтверждён/);
});

test("«печать не началась» — главное действие, а не равноправная альтернатива", () => {
  const html = launchModalHtml(unconfirmedPreview(), ui());
  const failed = html.match(/<button[^>]*data-launch-resolve="FAILED"[^>]*>/)[0];
  const succeeded = html.match(/<button[^>]*data-launch-resolve="SUCCEEDED"[^>]*>/)[0];

  assert.match(failed, /btn-primary/, "ожидаемый ответ выделен");
  assert.doesNotMatch(succeeded, /btn-primary/, "«печать всё-таки идёт» — другое утверждение");
});

test("выбор принтера в этом состоянии не предлагается", () => {
  // Выбирать, ГДЕ печатать, пока не решено, печатается ли уже — бессмысленно.
  const html = launchModalHtml(unconfirmedPreview(), ui({ mode: "manual" }));
  assert.doesNotMatch(html, /data-launch-mode/);
  assert.doesNotMatch(html, /data-launch-pick/);
});

test("после разрешения окно снова становится обычным окном запуска", () => {
  const html = launchModalHtml(
    unconfirmedPreview({
      state: "ready",
      activeRunId: null,
      unresolvedRunId: null,
      primaryProblem: null,
      candidates: [candidate({ eligible: true, reason: "PETG заправлен, принтер свободен" })]
    }),
    ui()
  );

  assert.doesNotMatch(html, /data-launch-resolve/, "решать больше нечего");
  assert.match(html, /data-launch-go/, "запуск снова предлагается");
  assert.doesNotMatch(
    html,
    /<button[^>]*data-launch-go[^>]*disabled/,
    "и он доступен: задание вернулось в очередь"
  );
});
