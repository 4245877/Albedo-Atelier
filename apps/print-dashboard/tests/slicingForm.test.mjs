import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCreateSetPayload,
  createSetBlockReason,
  distinctClasses,
  nextPollMs,
  targetOptions
} from "../features/slicing/formModel.js";

/*
 * The "Новый набор" target logic (P0-#3 + friends): the form must offer BOTH server
 * target models — a concrete printer OR a class of interchangeable printers — and
 * submit exactly one, refusing to submit with no target. These pure helpers back
 * that DOM behaviour, so they are unit-tested here (no browser needed).
 */

const COVERAGE = [
  { printerId: "creality-k2", printerName: "K2", printerClass: "k2-farm", hasActiveProfile: true },
  { printerId: "creality-k2-b", printerName: "K2 #2", printerClass: "k2-farm", hasActiveProfile: true },
  { printerId: "ender3", printerName: "Ender 3", printerClass: null, hasActiveProfile: false }
];

test("distinctClasses dedupes, trims and drops empty/null classes", () => {
  assert.deepEqual(distinctClasses(COVERAGE), ["k2-farm"]);
  assert.deepEqual(
    distinctClasses([{ printerClass: " a " }, { printerClass: "a" }, { printerClass: "" }, { printerClass: null }, {}]),
    ["a"]
  );
  assert.deepEqual(distinctClasses([]), []);
  assert.deepEqual(distinctClasses(undefined), []);
});

test("targetOptions exposes the concrete printers and the distinct classes", () => {
  const { printers, classes } = targetOptions(COVERAGE);
  assert.equal(printers.length, 3);
  assert.deepEqual(classes, ["k2-farm"]);
});

test("createSetBlockReason blocks when there are no printers at all", () => {
  const reason = createSetBlockReason([], []);
  assert.match(reason ?? "", /Нет доступных принтеров/);
  assert.match(createSetBlockReason(undefined, []) ?? "", /Нет доступных принтеров/);
});

test("createSetBlockReason blocks when active profiles are missing", () => {
  const reason = createSetBlockReason(COVERAGE, ["принтер", "филамент"]);
  assert.match(reason ?? "", /Нет активных профилей/);
  assert.match(reason ?? "", /принтер, филамент/);
});

test("createSetBlockReason returns null when a set can be created", () => {
  assert.equal(createSetBlockReason(COVERAGE, []), null);
});

test("buildCreateSetPayload (printer): sends exactly the printer target", () => {
  const data = { name: " K2 · PETG ", machine: "m1", process: "p1", filament: "f1", printer: "creality-k2", printerClass: "k2-farm" };
  const built = buildCreateSetPayload(data, "printer");
  assert.equal(built.ok, true);
  assert.equal(built.payload.name, "K2 · PETG"); // trimmed
  assert.equal(built.payload.printer, "creality-k2");
  assert.ok(!("printerClass" in built.payload), "the class field is NOT sent for a printer target");
  assert.deepEqual(
    { machine: built.payload.machine, process: built.payload.process, filament: built.payload.filament },
    { machine: "m1", process: "p1", filament: "f1" }
  );
});

test("buildCreateSetPayload (class): sends exactly the class target", () => {
  const data = { name: "K2 class", machine: "m1", process: "p1", filament: "f1", printer: "creality-k2", printerClass: "k2-farm" };
  const built = buildCreateSetPayload(data, "class");
  assert.equal(built.ok, true);
  assert.equal(built.payload.printerClass, "k2-farm");
  assert.ok(!("printer" in built.payload), "the concrete printer is NOT sent for a class target");
});

test("buildCreateSetPayload refuses to submit without a chosen target", () => {
  const base = { name: "x", machine: "m1", process: "p1", filament: "f1" };
  const noPrinter = buildCreateSetPayload({ ...base, printer: "" }, "printer");
  assert.equal(noPrinter.ok, false);
  assert.match(noPrinter.error, /принтер/i);

  const noClass = buildCreateSetPayload({ ...base, printerClass: "  " }, "class");
  assert.equal(noClass.ok, false);
  assert.match(noClass.error, /класс/i);
});

test("nextPollMs is fast while busy or on errors, and idle otherwise (but never off)", () => {
  const cadence = { fast: 4000, idle: 20000 };
  assert.equal(nextPollMs({ busyVariants: true, hasErrors: false }, cadence), 4000);
  assert.equal(nextPollMs({ busyVariants: false, hasErrors: true }, cadence), 4000);
  assert.equal(nextPollMs({ busyVariants: false, hasErrors: false }, cadence), 20000);
});
