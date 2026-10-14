/* ── Регресс HIGH-04: единицы STL на дашборде и сервере совпадают ─────
   Дашборд отправлял «mm»/«cm»/«m», сервер принимал только канонические
   «millimeter»/«centimeter»/«meter» — подтвердить STL удавалось лишь в дюймах.
   Каждая единица из списка выбора обязана быть той, которую сервер понимает. */

import assert from "node:assert/strict";
import test from "node:test";

import { UNIT_CHOICES } from "../features/uploads/units.js";

const SERVER_UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 };

test("каждая единица выбора — каноническое имя сервера с тем же множителем", () => {
  assert.ok(UNIT_CHOICES.length >= 4);
  for (const choice of UNIT_CHOICES) {
    assert.ok(choice.value in SERVER_UNITS, `«${choice.value}» сервер не примет`);
    assert.equal(choice.factor, SERVER_UNITS[choice.value], `множитель «${choice.value}»`);
  }
});

test("миллиметры, сантиметры, метры и дюймы — все доступны", () => {
  const values = UNIT_CHOICES.map((c) => c.value).sort();
  assert.deepEqual(values, ["centimeter", "inch", "meter", "millimeter"]);
});
