import assert from "node:assert/strict";
import { test } from "node:test";

import { itemHtml } from "../features/uploads/view.js";
import { layoutSvg, plateTitle, platesHtml } from "../features/uploads/plates.js";

/*
 * Пластины на карточке загрузки.
 *
 * Что здесь проверяется — не «нарисовалось ли», а разделение двух операций:
 * посмотреть пластину и взять её в работу. Первое живёт в браузере, второе
 * уходит на сервер и решает, что будет нарезано. Раньше файл с тремя столами
 * выглядел как обычная модель без габаритов, и сделать с ним было нечего.
 */

const plate = (index, over = {}) => ({
  index,
  sliceIndex: index,
  name: null,
  locked: false,
  source: "model_settings",
  objects: [{ objectId: String(index), instanceId: "0", name: null, footprintMm: null }],
  objectsTruncated: false,
  geometry: { index, objectCount: 1, sizeRaw: [10, 10, 10], minMm: null, maxMm: null, sizeMm: [10, 10, 10] },
  sliced: false,
  gcodeEntry: null,
  preview: null,
  estimate: null,
  settings: {},
  ...over
});

const item = (plates, plateState = {}, over = {}) => ({
  key: "art_1",
  name: "project.3mf",
  sizeBytes: 1024,
  stage: "done",
  progress: 1,
  error: null,
  artifact: { id: "art_1" },
  analysis: {
    state: "ready",
    detectedFormat: "3mf",
    verdict: "needs_preparation",
    warnings: [],
    blockers: [],
    material: null,
    data: { threeMfClass: "slicer_project", plateCount: plates.length, plates }
  },
  task: null,
  blobExisted: false,
  status: {
    next: { kind: "select_plate", label: "Выбрать пластину", explanation: "В файле 2 пластин", actionable: true, taskId: null },
    executable: false,
    scale: null,
    review: null,
    plates: {
      count: plates.length,
      required: true,
      selectedIndex: null,
      confirmedBy: null,
      confirmedAt: null,
      stale: false,
      staleReason: null,
      ...plateState
    }
  },
  ...over
});

test("несколько пластин показываются плитками, по одной на пластину", () => {
  const html = platesHtml(item([plate(1), plate(2), plate(3)]));
  assert.equal((html.match(/data-plate-view=/g) || []).length, 3);
  assert.match(html, /Пластины в файле: 3/);
});

test("одна пластина не добавляет на карточку ничего лишнего", () => {
  const one = item([plate(1)]);
  one.status.plates.count = 1;
  one.status.plates.required = false;
  assert.equal(platesHtml(one), "");
});

test("имя пластины показывается, а безымянная получает номер, а не пустоту", () => {
  assert.equal(plateTitle(plate(2, { name: "Корпус" })), "№2 · Корпус");
  assert.equal(plateTitle(plate(4)), "Пластина 4");
});

test("превью берётся с сервера по номеру пластины — путь внутри архива не передаётся", () => {
  const html = platesHtml(item([plate(1, { preview: { entry: "Metadata/plate_1.png" } }), plate(2)]));
  assert.match(html, /\/api\/print\/artifacts\/art_1\/plates\/1\/preview/);
  assert.ok(!html.includes("Metadata/plate_1.png"), "имя записи в архиве в разметку не попадает");
});

test("без картинки рисуется схема расположения, а не пустое место", () => {
  const withFootprints = plate(1, {
    objects: [
      { objectId: "1", instanceId: "0", name: null, footprintMm: { min: [0, 0], max: [40, 30] } },
      { objectId: "2", instanceId: "0", name: null, footprintMm: { min: [60, 10], max: [90, 50] } }
    ]
  });
  const svg = layoutSvg(withFootprints);
  assert.match(svg, /<svg/);
  assert.equal((svg.match(/plate-layout-parts/g) || []).length, 1);
  assert.equal((svg.match(/<rect/g) || []).length, 3, "рамка стола + два объекта");
});

test("схемы нет, когда координат нет — ничего не додумываем", () => {
  // Остаётся нейтральный значок: рисовать «примерное» расположение по
  // неизвестным координатам — это выдумывать раскладку стола.
  const html = layoutSvg(plate(1));
  assert.ok(!html.includes("plate-layout"), "ни рамки стола, ни объектов");
  assert.match(html, /plate-thumb-none/);
});

test("переключение плиток — просмотр: у него нет ни одного data-select-plate", () => {
  const html = platesHtml(item([plate(1), plate(2)]), { viewIndex: 2 });
  const tiles = html.slice(0, html.indexOf("plate-detail"));
  assert.ok(!tiles.includes("data-select-plate"), "плитка ничего не выбирает на сервере");
  assert.match(html, /aria-pressed="true"[^>]*data-plate-index="2"|data-plate-index="2"[^>]*aria-pressed="true"/);
});

test("выбор для работы — отдельная явная кнопка с номером пластины", () => {
  const html = platesHtml(item([plate(1), plate(2)]), { viewIndex: 2 });
  assert.match(html, /data-select-plate="art_1"\s+data-plate-index="2"/);
  assert.match(html, /Работать с этой пластиной/);
});

test("выбранная пластина названа, вместе с тем, кто и когда её выбрал", () => {
  const html = platesHtml(
    item([plate(1), plate(2)], {
      selectedIndex: 2,
      required: false,
      confirmedBy: "albedo",
      confirmedAt: "2026-09-08T10:20:30.000Z"
    }),
    { viewIndex: 2 }
  );
  assert.match(html, /в работе: №2/);
  assert.match(html, /выбрал albedo, 2026-09-08 10:20/);
  assert.match(html, /data-clear-plate="art_1"/);
});

test("пустая пластина видна, но кнопка выбора погашена и объясняет почему", () => {
  const html = platesHtml(item([plate(1), plate(2, { objects: [] })]), { viewIndex: 2 });
  assert.match(html, /<button[^>]*disabled/);
  assert.match(html, /нет ни одной модели/);
  assert.ok(!html.includes('data-select-plate="art_1"\n        data-plate-index="2"'));
});

test("состав пластины, у которой он неизвестен, не выдаётся за пустоту", () => {
  const html = platesHtml(item([plate(1), plate(2, { source: "entries", objects: [] })]), { viewIndex: 2 });
  // Не «пусто»: мы не знаем, что на ней, а не знаем, что там ничего нет.
  assert.match(html, /состав неизвестен/);
  assert.ok(!html.includes("пусто"));
});

test("пластину, состав которой не разобран, выбрать нельзя — и сказано почему", () => {
  // Про такую пластину не известно ничего: ни что на ней стоит, ни какого она
  // размера, ни надёжно — её позиция для слайсера. Выбирать не из чего, поэтому
  // кнопка гасится с той же формулировкой, которой откажет сервер.
  const html = platesHtml(item([plate(1), plate(2, { source: "entries", objects: [] })]), { viewIndex: 2 });
  assert.match(html, /<button[^>]*disabled/);
  assert.match(html, /Состав пластины не разобран/);
  // Плитка-переключатель остаётся: посмотреть пластину можно всегда. Нет именно
  // кнопки, которая отправила бы выбор на сервер.
  assert.ok(!html.slice(html.indexOf("plate-detail")).includes("data-select-plate"));
});

test("устаревший выбор виден прямо на карточке и требует подтвердить заново", () => {
  const html = platesHtml(
    item([plate(1), plate(2)], {
      selectedIndex: null,
      stale: true,
      staleReason: "файл был заменён",
      required: true
    })
  );
  assert.match(html, /Выбор пластины устарел: файл был заменён/);
  assert.match(html, /нужно выбрать пластину/);
});

test("оценки нарезанной пластины показываются, когда файл их содержит", () => {
  const html = platesHtml(
    item([
      plate(1, {
        sliced: true,
        estimate: {
          durationS: 5400,
          weightG: 31.2,
          supportUsed: true,
          filaments: [{ id: 1, type: "PETG", colorHex: "#1A2B3C", usedG: 31.2 }]
        }
      }),
      plate(2)
    ]),
    { viewIndex: 1 }
  );
  assert.match(html, /Время печати/);
  assert.match(html, /31\.2 г/);
  assert.match(html, /PETG/);
  assert.match(html, /Поддержки/);
});

test("усечённый список пластин честно говорит, что показаны не все", () => {
  const html = platesHtml(item([plate(1), plate(2)], { count: 200 }));
  assert.match(html, /Показаны 2 из 200 пластин/);
});

test("карточка файла показывает пластины вместе с остальным разбором", () => {
  const html = itemHtml(item([plate(1), plate(2)]), { detailsOpen: true });
  assert.match(html, /data-plates="art_1"/);
  assert.match(html, /В файле 2 пластин/, "следующий шаг приходит с сервера и стоит на виду");
});

test("«выбрана пластина» в свойствах читается из ответа сервера, а не выводится в браузере", () => {
  const chosen = itemHtml(item([plate(1), plate(2)], { selectedIndex: 1, required: false, confirmedBy: "albedo" }), {
    detailsOpen: true
  });
  assert.match(chosen, /Выбрана пластина<\/dt><dd>№1 \(albedo\)/);
  const unchosen = itemHtml(item([plate(1), plate(2)]), { detailsOpen: true });
  assert.ok(!unchosen.includes("Выбрана пластина"));
});
