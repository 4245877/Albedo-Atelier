import assert from "node:assert/strict";
import { test } from "node:test";

import { printersHtml } from "../features/printers/view.js";

/*
 * Разметка характеристик в разделе «Оборудование фермы».
 *
 * Проверяем ровно то, ради чего раздел переделывался: полученное от принтера
 * должно быть видно как полученное от принтера, а не как введённое руками, и
 * расхождение между ними не должно теряться. Логика приоритета живёт на
 * backend — здесь её нет и проверять её нечего; здесь проверяется, что честный
 * ответ backend доходит до глаз оператора.
 */

const spec = (value, source, extra = {}) => ({
  value,
  source,
  via: null,
  observedAt: "2026-08-07T10:00:00.000Z",
  overriddenManual: null,
  catalogHint: null,
  ...extra
});

const UNKNOWN_KEYS = [
  "model", "firmware", "deviceName", "technology", "buildVolume", "nozzleDiameterMm",
  "nozzleType", "material", "extruderCount", "ams", "materials", "chamberSensor",
  "heatedChamber", "filamentSensor", "kinematics"
];

const specs = (overrides = {}) => ({
  ...Object.fromEntries(UNKNOWN_KEYS.map((key) => [key, spec(null, "unknown")])),
  ...overrides
});

function render(printer) {
  return printersHtml({
    printers: [
      {
        id: "bambu-a1",
        name: "Bambu A1",
        protocol: "bambu",
        host: "192.168.0.187",
        port: 8883,
        enabled: true,
        model: "",
        material: "",
        nozzleType: "",
        nozzleDiameterMm: null,
        buildVolume: null,
        secrets: {},
        discovery: { probedAt: "2026-08-07T10:00:00.000Z", succeeded: true, error: null },
        specs: specs(),
        ...printer
      }
    ],
    options: null,
    tests: {},
    busy: {}
  });
}

test("значение с принтера помечено «с принтера»", () => {
  const html = render({
    specs: specs({ nozzleType: spec("hardened_steel", "printer") })
  });

  assert.match(html, /hardened_steel/);
  assert.match(html, /prn-source--printer/);
  assert.match(html, /с принтера/);
});

test("значение из справочника моделей помечено иначе, чем полученное с принтера", () => {
  // Габариты Bambu MQTT не передаёт: они выведены из модели, и выдавать их за
  // показание устройства нельзя — оператор должен видеть разницу.
  const html = render({
    specs: specs({ buildVolume: spec({ x: 256, y: 256, z: 256 }, "catalog") })
  });

  assert.match(html, /256 × 256 × 256 мм/);
  assert.match(html, /prn-source--catalog/);
  assert.match(html, /по модели/);
});

test("введённое вручную помечено «вручную»", () => {
  const html = render({ specs: specs({ model: spec("Bambu Lab A1", "manual") }) });

  assert.match(html, /prn-source--manual/);
  assert.match(html, /вручную/);
});

test("характеристика, которую принтер не передаёт, названа прямо", () => {
  const html = render({ specs: specs() });
  assert.match(html, /принтер не сообщает/);
});

test("расхождение с ручным значением показано предупреждением, а не скрыто", () => {
  const html = render({
    nozzleDiameterMm: 0.6,
    specs: specs({ nozzleDiameterMm: spec(0.4, "printer", { overriddenManual: 0.6 }) })
  });

  assert.match(html, /вручную задано «0\.6 мм»/);
  assert.match(html, /принтер сообщает «0\.4 мм»/);
  assert.match(html, /действует значение принтера/);
});

test("значение справочника показано подсказкой, когда победило ручное", () => {
  const html = render({
    buildVolume: { x: 250, y: 250, z: 250 },
    specs: specs({
      buildVolume: spec({ x: 250, y: 250, z: 250 }, "manual", {
        catalogHint: { x: 256, y: 256, z: 256 }
      })
    })
  });

  assert.match(html, /по модели принтера — «256 × 256 × 256 мм»/);
});

test("загруженные катушки перечислены, активная отмечена", () => {
  const html = render({
    specs: specs({
      materials: spec(
        [
          { slot: 0, material: "PLA", color: "#EFE8D8", remainPct: 92, active: true },
          { slot: 1, material: "PETG", color: null, remainPct: 40, active: false }
        ],
        "printer"
      )
    })
  });

  assert.match(html, /слот 1: PLA · 92%/);
  assert.match(html, /слот 2: PETG · 40%/);
  assert.match(html, /prn-material--active/);
  assert.match(html, /печатает/);
});

test("внешняя катушка названа своим именем, а не нулевым слотом", () => {
  const html = render({
    specs: specs({
      materials: spec(
        [{ slot: null, material: "TPU", color: null, remainPct: null, active: true }],
        "printer"
      )
    })
  });

  assert.match(html, /внешняя катушка: TPU/);
});

test("AMS Lite описан вместе с числом слотов", () => {
  const html = render({
    specs: specs({
      ams: spec({ present: true, kind: "AMS Lite", units: 1, slots: 4 }, "printer")
    })
  });

  assert.match(html, /AMS Lite, 4 слот/);
});

test("неудачный опрос не выдаёт прежние данные за свежие", () => {
  const html = render({
    discovery: {
      probedAt: "2026-08-07T10:00:00.000Z",
      succeeded: false,
      error: "принтер не ответил"
    },
    specs: specs({ nozzleType: spec("hardened_steel", "printer") })
  });

  assert.match(html, /последний опрос не удался/);
  assert.match(html, /показаны прежние данные/);
  // Выученное при этом остаётся на экране — оно не перестало быть правдой.
  assert.match(html, /hardened_steel/);
});

test("непрошенный принтер приглашается к опросу, а не показывается пустым", () => {
  const html = render({ discovery: null });
  assert.match(html, /опрос ещё не выполнялся/);
  // Приглашение — это доступное действие «опросить», а не просто слово в тексте:
  // проверяем саму кнопку, поэтому переименование подписи её не ломает.
  assert.match(html, /data-prn-action="discover"/, "кнопка опроса на месте");
  assert.match(html, /<span>Опросить<\/span>/, "и названа человеческим глаголом");
});

test("значение с принтера экранируется, как и любые внешние данные", () => {
  const html = render({
    specs: specs({ model: spec('<img src=x onerror="alert(1)">', "printer") })
  });

  assert.ok(!html.includes("<img src=x"), "разметка из ответа принтера не должна исполняться");
  assert.match(html, /&lt;img/);
});
