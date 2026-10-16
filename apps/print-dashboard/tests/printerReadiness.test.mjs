/* ── Регресс CRITICAL-02 на дашборде: `idle` ≠ «свободен» ───────
   Карточка показывала бейдж «готов служить» и строку «Свободен» для любого
   принтера в `idle` — в том числе с готовой деталью на столе, с неподтверждённым
   запуском и со столом, который никто ни разу не проверял. Сервер теперь
   присылает `readiness`, и бейдж/строка обязаны говорить то же самое.
   Плюс два соседних дефекта отображения: кнопки паузы/отмены у Creality WS,
   которые не могут сработать, и сопло из конфигурации, выдававшее себя за
   телеметрию. */

import assert from "node:assert/strict";
import test from "node:test";

import { jobLine, printerActionModel, actionAvailability } from "../render/printerView.js";
import { printerBadge, badge } from "../shared/chips.js";
import { materialBlock } from "../render/printerParts.js";

const base = {
  id: "k2", name: "K2", status: "idle", job: null, light: null, lightSupported: false,
  snapshotAvailable: false, filesSupported: false, remoteStartSupported: true,
  latestSnapshotUrl: null, interfaceUrl: null
};
const readiness = (state, label, detail = null, canAcceptJob = false) => ({ state, label, detail, canAcceptJob });

test("простаивающий принтер с деталью на столе — «ждёт снятия детали», а не «готов служить»", () => {
  const p = { ...base, readiness: readiness("needs_clearance", "Ждёт снятия детали", "снимите готовую модель") };
  assert.match(printerBadge(p), /ждёт снятия детали/);
  assert.doesNotMatch(printerBadge(p), /готов служить/);
  assert.match(jobLine(p), /Ждёт снятия детали/);
  assert.doesNotMatch(jobLine(p), /Свободен/);
});

test("неподтверждённый стол и неподтверждённый запуск названы прямо", () => {
  assert.match(printerBadge({ ...base, readiness: readiness("bed_unknown", "Стол не подтверждён") }), /стол не подтверждён/);
  assert.match(printerBadge({ ...base, readiness: readiness("held", "Запуск не подтверждён") }), /запуск не подтверждён/);
});

test("готовый принтер остаётся «готов служить»; печать и ошибка — по статусу устройства", () => {
  const ready = { ...base, readiness: readiness("ready", "Готов к печати", null, true) };
  assert.equal(printerBadge(ready), badge("idle"));
  assert.match(jobLine(ready), /Свободен/);
  const printing = { ...base, status: "printing", readiness: readiness("printing", "Печатает") };
  assert.equal(printerBadge(printing), badge("printing"));
});

test("старый backend без readiness — прежнее поведение", () => {
  assert.equal(printerBadge(base), badge("idle"));
  assert.match(jobLine(base), /Свободен/);
});

test("Creality WS: пауза/продолжение/отмена не рисуются вовсе (команды не существуют)", () => {
  const p = { ...base, status: "printing", printControlSupported: false };
  const m = printerActionModel(p);
  const acts = [m.primary, m.secondary, ...m.menu].filter(Boolean).map((x) => x.act);
  assert.ok(!acts.includes("pause"));
  assert.ok(!acts.includes("resume"));
  assert.ok(!acts.includes("cancel"));
  assert.equal(m.primary.act, "open", "вместо пустоты — «Открыть»");
  const can = actionAvailability(p);
  assert.equal(can.canPause, false);
  assert.equal(can.canCancel, false);
});

test("Moonraker/Bambu по-прежнему получают паузу как главное действие при печати", () => {
  assert.equal(printerActionModel({ ...base, status: "printing", printControlSupported: true }).primary.act, "pause");
});

test("сопло, введённое вручную (source=manual), помечено «из конфигурации», а не выдано за телеметрию", () => {
  const html = materialBlock({ ...base, nozzleDiameter: 0.4, nozzleDiameterSource: "manual", material: "PLA" });
  assert.match(html, /nozzle-chip-config/);
  const live = materialBlock({ ...base, nozzleDiameter: 0.4, nozzleDiameterSource: "printer", material: "PLA" });
  assert.doesNotMatch(live, /nozzle-chip-config/);
});

test("строка стола: подтвердить можно и деталь на столе, и стол, который никто не проверял", async () => {
  // Сразу после развёртывания у принтеров нет истории стола («Стол не
  // подтверждён»). Кнопка рисовалась только для детали на столе, и записать
  // свободный стол можно было лишь запуском задания — а автоочередь без
  // записанной очистки не запускает ничего.
  const { bedBlock } = await import("../render/printers.js");
  const awaiting = bedBlock({ id: "k2", bedCycle: { state: "AWAITING_CLEARANCE", awaitingClearance: true, confirmable: true, operationId: "op1" } });
  assert.match(awaiting, /data-act="clear-bed"/);
  assert.match(awaiting, /Снять модель и освободить стол/);
  assert.match(awaiting, /data-operation="op1"/);

  const unknown = bedBlock({ id: "k2", bedCycle: { state: "UNKNOWN", awaitingClearance: false, confirmable: true, operationId: null } });
  assert.match(unknown, /data-act="clear-bed"/);
  assert.match(unknown, /data-bed-state="UNKNOWN"/);
  assert.match(unknown, /Стол пуст — подтвердить/);

  for (const state of ["RUNNING", "RESERVED", "CLEAR"]) {
    assert.doesNotMatch(bedBlock({ id: "k2", bedCycle: { state, awaitingClearance: false, confirmable: false } }), /clear-bed/, state);
  }
  // Старый backend без `confirmable` — прежнее правило.
  assert.match(bedBlock({ id: "k2", bedCycle: { state: "AWAITING_CLEARANCE", awaitingClearance: true } }), /clear-bed/);
  assert.doesNotMatch(bedBlock({ id: "k2", bedCycle: { state: "UNKNOWN", awaitingClearance: false } }), /clear-bed/);
});

test("принтер только для наблюдения: нейтральный бейдж, а не «готов служить»", () => {
  const p = {
    ...base,
    remoteStartSupported: false,
    printControlSupported: false,
    readiness: readiness("monitoring", "Только наблюдение", "задания на него не назначаются")
  };
  assert.match(printerBadge(p), /только наблюдение/);
  assert.match(printerBadge(p), /badge-plain/);
  assert.doesNotMatch(printerBadge(p), /готов служить/);
  // Пока он печатает (не через Albedo), бейдж — по статусу устройства.
  assert.equal(printerBadge({ ...p, status: "printing" }), badge("printing"));
});
