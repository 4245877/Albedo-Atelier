/* ── Регресс P0: иерархия и доступность действий принтера ───────
   Найденные дефекты:
     • карточка выкладывала ~8 равновесных кнопок, две из которых назывались
       одинаково («Снимок»), а две описывали одну лампу;
     • разрушающая «Отмена» стояла вплотную к безобидным командам;
     • принципиально неподдерживаемые действия рисовались погашенными — то
       есть обещали то, чего не будет никогда;
     • у погашенной кнопки не было причины.

   Здесь проверяется модель (render/printerView.js), а не разметка: именно она
   — единая точка правды для карточки и модального окна. */

import assert from "node:assert/strict";
import test from "node:test";

import { printerActionModel } from "../render/printerView.js";

const base = {
  id: "k2", name: "K2", status: "idle", light: null, lightSupported: false,
  snapshotAvailable: false, filesSupported: false, remoteStartSupported: false,
  latestSnapshotUrl: null, interfaceUrl: null
};
const model = (over, opts) => printerActionModel({ ...base, ...over }, opts);
const acts = (m) => [m.primary, m.secondary, ...m.menu].filter(Boolean).map((x) => x.act);

test("главное действие зависит от состояния машины", () => {
  assert.equal(model({ status: "printing" }).primary.act, "pause");
  assert.equal(model({ status: "paused" }).primary.act, "resume");
  assert.equal(model({ status: "idle" }).primary.act, "open");
  assert.equal(model({ status: "offline" }).primary.label, "Диагностика");
  assert.equal(model({ status: "error" }).primary.label, "Разобраться");
});

test("разрушающее действие никогда не главное и не вспомогательное", () => {
  for (const status of ["printing", "paused", "idle", "offline", "error"]) {
    const m = model({ status });
    assert.notEqual(m.primary?.act, "cancel", `${status}: отмена не главная кнопка`);
    assert.notEqual(m.secondary?.act, "cancel", `${status}: отмена не вспомогательная`);
    assert.ok(m.menu.some((x) => x.act === "cancel"), `${status}: отмена живёт в меню «⋯»`);
  }
});

test("отмена помечена разрушающей — её оформление не может совпасть с обычной", () => {
  const cancel = model({ status: "printing" }).menu.find((x) => x.act === "cancel");
  assert.equal(cancel.danger, true);
});

test("принципиально неподдерживаемое НЕ рисуется вовсе", () => {
  // Принтер без камеры, без файлов, без лампы и без веб-интерфейса.
  const list = acts(model({ status: "idle" }));
  assert.ok(!list.includes("light"), "нет управления подсветкой — нет кнопки");
  assert.ok(!list.includes("snapshot"), "камера не отдаёт кадр — нет кнопки снимка");
  assert.ok(!list.includes("files"), "протокол не отдаёт файлы — нет кнопки файлов");
  assert.ok(!list.includes("interface"), "нет адреса интерфейса — нет ссылки");
});

test("временно недоступное рисуется погашенным И называет причину", () => {
  const m = model({ status: "offline", lightSupported: true, snapshotAvailable: true, filesSupported: true });
  for (const act of ["light", "snapshot", "files"]) {
    const item = [m.primary, m.secondary, ...m.menu].filter(Boolean).find((x) => x.act === act);
    assert.ok(item, `${act} остаётся видимым — принтер это умеет`);
    assert.equal(item.disabled, true, `${act} недоступен, пока принтер не в сети`);
    assert.match(item.reason, /не в сети/, `${act} объясняет, почему сейчас нельзя`);
  }
});

test("пауза у простаивающего принтера объясняет причину, а не молчит", () => {
  const pause = model({ status: "idle" }).menu.find((x) => x.act === "pause");
  assert.equal(pause.disabled, true);
  assert.match(pause.reason, /не печатает/);
});

test("подсветка — ОДИН переключатель, а не пара одинаковых кнопок", () => {
  const on = model({ status: "idle", lightSupported: true, light: true });
  const off = model({ status: "idle", lightSupported: true, light: false });
  const pick = (m) => [m.primary, m.secondary, ...m.menu].filter(Boolean).filter((x) => x.act === "light");

  assert.equal(pick(on).length, 1, "лампой управляет ровно один орган");
  assert.equal(pick(off).length, 1);
  assert.match(pick(on)[0].label, /Погасить/, "включённая лампа предлагает погасить");
  assert.match(pick(off)[0].label, /Зажечь/, "погашенная предлагает зажечь");
  assert.equal(pick(on)[0].pressed, true, "состояние доступно скринридеру через aria-pressed");
});

test("снимок и последний кадр — разные действия с разными подписями", () => {
  const m = model({ status: "idle", snapshotAvailable: true, latestSnapshotUrl: "/api/x/last" });
  const all = [m.primary, m.secondary, ...m.menu].filter(Boolean);
  const snapshot = all.find((x) => x.act === "snapshot");
  const last = all.find((x) => x.act === "last-frame");

  assert.ok(snapshot && last, "оба действия доступны");
  assert.notEqual(snapshot.label, last.label, "две кнопки не могут называться одинаково");
  assert.match(snapshot.label, /Сделать снимок/);
  assert.match(last.label, /Последний кадр/);
  assert.ok(last.href, "последний кадр — ссылка, а не команда");
});

test("в окне принтера нет кнопки «Открыть» — оно уже открыто", () => {
  const m = model({ status: "idle" }, { context: "modal" });
  assert.ok(!acts(m).includes("open"));
});

test("ни одно действие не дублируется между главным, вспомогательным и меню", () => {
  const m = model({
    status: "printing", lightSupported: true, light: false, snapshotAvailable: true,
    filesSupported: true, interfaceUrl: "http://x", latestSnapshotUrl: "/last"
  });
  const list = acts(m);
  assert.equal(new Set(list).size, list.length, `дубли в наборе действий: ${list.join(", ")}`);
});
