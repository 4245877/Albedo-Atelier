import assert from "node:assert/strict";
import { test } from "node:test";

import { itemHtml, listSummary } from "../features/uploads/view.js";

/*
 * Разметка карточки загрузки.
 *
 * Раздел переделывался ради одного: пользователь загрузил обычный 3MF, а увидел
 * «формат 3MF · неизвестный 3MF · G-code внутри: нет · заблокировано» плюс
 * черновик в NEEDS_REVIEW — четыре сигнала, ни один из которых не говорит, что
 * произошло и что делать. Здесь проверяется, что до глаз оператора доходит
 * причина и следующий шаг, а не набор внутренних кодов.
 */

const item = (analysis, task = null) => ({
  key: "art_1",
  name: "part.3mf",
  sizeBytes: 151_525,
  stage: analysis?.state === "ready" ? "done" : "analyzing",
  progress: 1,
  error: null,
  artifact: { id: "art_1" },
  analysis,
  task,
  blobExisted: false
});

const ready = (over = {}) => ({
  state: "ready",
  detectedFormat: "3mf",
  verdict: "needs_preparation",
  warnings: [],
  blockers: [],
  material: null,
  data: {},
  ...over
});

test("подсказка находки показывается отдельной строкой под причиной", () => {
  const html = itemHtml(
    item(
      ready({
        verdict: "blocked",
        blockers: [{ code: "zip_corrupt", message: "Повреждённый каталог ZIP", hint: "Пересохраните файл в слайсере." }]
      })
    )
  );
  assert.match(html, /Повреждённый каталог ZIP/);
  assert.match(html, /class="upload-hint">Пересохраните файл в слайсере\./);
});

test("«заблокировано» сопровождается человеческим объяснением, а не только чипом", () => {
  const html = itemHtml(
    item(
      ready({ verdict: "blocked", blockers: [{ code: "zip_corrupt", message: "Повреждённый каталог ZIP" }] }),
      { id: "task_1", title: "part.3mf", state: "NEEDS_REVIEW", reason: "Повреждённый каталог ZIP" }
    )
  );
  assert.match(html, /Файл не удалось подготовить к печати/);
  // Внутреннее имя состояния не показывается сырым.
  assert.match(html, /нужна проверка/);
  assert.doesNotMatch(html, /NEEDS_REVIEW/);
});

test("класс «unknown» читается как «архив без 3D-модели», а не как «неизвестный 3MF»", () => {
  const html = itemHtml(item(ready({ verdict: "review", data: { threeMfClass: "unknown" } })));
  assert.match(html, /архив без 3D-модели/);
  assert.doesNotMatch(html, /неизвестный 3MF/);
});

test("«G-code внутри: нет» объясняет, что это значит для пользователя", () => {
  const html = itemHtml(item(ready({ data: { threeMfClass: "generic", hasGcodePayload: false } })));
  assert.match(html, /нет — это модель, её ещё нужно нарезать/);
});

test("слайсер-производитель показывается вместе с его собственной подписью", () => {
  const html = itemHtml(
    item(
      ready({
        data: { threeMfClass: "slicer_project", producer: "orcaslicer", slicer: "OrcaSlicer-2.1.1" }
      })
    )
  );
  assert.match(html, /Создан в/);
  assert.match(html, /OrcaSlicer \(OrcaSlicer-2\.1\.1\)/);
});

test("файл, разложенный по нескольким частям модели, показывает их число", () => {
  const html = itemHtml(
    item(ready({ data: { threeMfClass: "slicer_project", modelPartCount: 3, objectCount: 3 } }))
  );
  assert.match(html, /Частей модели/);
});

test("файл без нескольких частей не показывает лишнюю строку", () => {
  const html = itemHtml(item(ready({ data: { threeMfClass: "generic", modelPartCount: 1 } })));
  assert.doesNotMatch(html, /Частей модели/);
});

/*
 * Высота списка. Развёрнутая таблица свойств у каждого файла растягивала раздел
 * на тысячи пикселей: с десятком загрузок до «Слайсинга» приходилось листать
 * несколько экранов. Свойства сворачиваются, но всё, по чему принимают решение —
 * имя, статус, вердикт и находки, — остаётся на виду.
 */

test("таблица свойств лежит в свёрнутом <details>, а не разворачивает карточку", () => {
  const html = itemHtml(item(ready({ data: { threeMfClass: "generic", objectCount: 2 } })));
  assert.match(html, /<details class="upload-details" data-upload-details>/);
  assert.doesNotMatch(html, /data-upload-details open/);
  assert.match(html, /Свойства файла/);
});

test("свойства раскрыты, когда об этом просит контроллер (один-два файла)", () => {
  const html = itemHtml(item(ready({ data: { threeMfClass: "generic", objectCount: 2 } })), { detailsOpen: true });
  assert.match(html, /data-upload-details open/);
});

test("находки видны всегда и стоят выше свёрнутых свойств", () => {
  const html = itemHtml(
    item(
      ready({
        verdict: "blocked",
        blockers: [{ code: "zip_corrupt", message: "Повреждённый каталог ZIP" }],
        data: { threeMfClass: "generic", objectCount: 2 }
      })
    )
  );
  assert.ok(
    html.indexOf("Повреждённый каталог ZIP") < html.indexOf("upload-details"),
    "причина должна читаться раньше, чем таблица свойств"
  );
});

test("сводка списка разделяет «в работе», «принято» и «требуют внимания»", () => {
  const s = listSummary([
    { stage: "uploading", analysis: null },
    { stage: "analyzing", analysis: { state: "running" } },
    { stage: "done", analysis: { state: "ready", verdict: "schedulable" } },
    { stage: "done", analysis: { state: "ready", verdict: "blocked" } },
    { stage: "error", analysis: null }
  ]);
  assert.deepEqual(s, { total: 5, working: 2, ready: 1, attention: 2 });
});

/*
 * Удаление файла. Кнопка живёт в шапке карточки и обязана быть честной: пока
 * файл держит что-то, чего сервер снять не может, backend откажет — значит и
 * предлагать действие нельзя, а причину отказа оператор должен прочитать, не
 * нажимая.
 *
 * Отдельный случай — файл, который держат только задания планировщика. Сервер
 * готов отменить их вместе с ним и присылает списком (`deletionCascade`);
 * гасить кнопку здесь означало бы тупик: причина показана, а убрать её из этого
 * раздела нечем.
 */

test("свободный файл получает живую кнопку удаления с именем в подписи", () => {
  const html = itemHtml(item(ready()));
  assert.match(html, /data-delete-artifact="art_1"/);
  assert.match(html, /aria-label="Удалить файл «part\.3mf»"/);
  assert.doesNotMatch(html, /data-delete-artifact="art_1"[^>]*disabled/);
});

test("занятый файл: кнопка погашена, причина отказа стоит в подсказке", () => {
  const it = item(ready());
  it.deletionBlocker = "активная печать run_1 (RUNNING) использует файл";
  const html = itemHtml(it);
  assert.match(html, /disabled/);
  assert.match(html, /Удалить нельзя: активная печать run_1 \(RUNNING\) использует файл/);
  assert.doesNotMatch(html, /data-delete-artifact/);
});

test("файл держит только задание очереди: кнопка жива и называет, что отменится", () => {
  const it = item(ready());
  it.deletionBlocker = "задание «Куб» в состоянии QUEUED использует файл";
  it.deletionCascade = [{ id: "task_1", title: "Куб", state: "QUEUED" }];
  const html = itemHtml(it);
  assert.match(html, /data-delete-artifact="art_1"/);
  assert.doesNotMatch(html, /data-delete-artifact="art_1"[^>]*disabled/);
  // В подсказке — что произойдёт, а не запрет, которого больше нет.
  assert.match(html, /Удалить файл и отменить задание «Куб»/);
  assert.doesNotMatch(html, /Удалить нельзя/);
});

test("несколько заданий перечисляются во множественном числе", () => {
  const it = item(ready());
  it.deletionBlocker = "задание «Куб» в состоянии QUEUED использует файл";
  it.deletionCascade = [
    { id: "task_1", title: "Куб", state: "QUEUED" },
    { id: "task_2", title: "Пирамида", state: "NEEDS_REVIEW" }
  ];
  const html = itemHtml(it);
  assert.match(html, /отменить задания «Куб», «Пирамида»/);
});

test("название задания экранируется — оно приходит с сервера", () => {
  const it = item(ready());
  it.deletionBlocker = "задание использует файл";
  it.deletionCascade = [{ id: "task_1", title: '<img src=x onerror="alert(1)">', state: "QUEUED" }];
  const html = itemHtml(it);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("пока идёт анализ, каскад не предлагается — файл читает worker", () => {
  const it = item({ state: "running", warnings: [], blockers: [], data: {} });
  it.deletionCascade = [{ id: "task_1", title: "Куб", state: "QUEUED" }];
  const html = itemHtml(it);
  assert.doesNotMatch(html, /data-delete-artifact/);
  assert.match(html, /файл ещё анализируется/);
});

test("пока идёт анализ, удаление не предлагается — сервер всё равно откажет", () => {
  const html = itemHtml(item({ state: "running", warnings: [], blockers: [], data: {} }));
  assert.doesNotMatch(html, /data-delete-artifact/);
  assert.match(html, /файл ещё анализируется/);
});

test("карточка неудавшейся загрузки убирается из списка, а не удаляется на сервере", () => {
  const it = item(null);
  it.artifact = null;
  it.stage = "error";
  it.error = "Сеть недоступна";
  const html = itemHtml(it);
  assert.match(html, /data-upload-dismiss="art_1"/);
  assert.doesNotMatch(html, /data-delete-artifact/);
});

test("карточка ещё не сохранённого файла не предлагает ни удаления, ни снятия", () => {
  const it = item(null);
  it.artifact = null;
  it.stage = "uploading";
  const html = itemHtml(it);
  assert.doesNotMatch(html, /data-upload-dismiss/);
  assert.doesNotMatch(html, /data-delete-artifact/);
});

test("причина отказа экранируется — она приходит с сервера", () => {
  const it = item(ready());
  it.deletionBlocker = 'задание "<b>x</b>" использует файл';
  const html = itemHtml(it);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});
