import assert from "node:assert/strict";
import { test } from "node:test";

import { itemHtml } from "../features/uploads/view.js";

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
