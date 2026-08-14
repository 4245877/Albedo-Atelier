import assert from "node:assert/strict";
import test from "node:test";

import { explainLaunchFailure, explainReason, primaryProblem } from "./problems";

/**
 * Choosing the ONE reason an operator reads.
 *
 * The incident: a Bambu A1 that could not read its MicroSD card produced four
 * simultaneous refusals — «Принтер занят», «Принтер в ошибке», «Принтер
 * недоступен», «Неизвестно сопло». Three were consequences of the first, the
 * fourth was an artefact of the start command itself, and the actual cause
 * appeared in none of them. Listing consequences beside a cause does not make
 * the list more complete; it makes the cause unfindable.
 */

const reason = (code: string, message = code) => ({ code, message });

test("a device-reported fault outranks every state it caused", () => {
  const problems = explainLaunchFailure({
    blockers: [
      reason("printer_error", "Принтер «Bambu Lab A1 Combo» в ошибке"),
      reason("printer_fault", "Ошибка чтения/записи карты MicroSD (0500-C010)")
    ],
    reviews: [reason("printer_nozzle_unknown", "Диаметр сопла неизвестен")],
    warnings: [reason("printer_busy", "Принтер сейчас занят")]
  });

  assert.equal(primaryProblem(problems)?.code, "printer_fault");
  // Nothing is thrown away — the rest stays for the diagnostics panel.
  assert.equal(problems.length, 4);
});

test("an unresolved previous start outranks the busy it produced", () => {
  const problems = explainLaunchFailure({
    blockers: [reason("launch_unconfirmed", "Предыдущий запуск не подтверждён")],
    reviews: [],
    warnings: [reason("printer_busy", "Принтер сейчас занят")]
  });
  assert.equal(primaryProblem(problems)?.code, "launch_unconfirmed");
});

test("a blocker always outranks something the operator could merely confirm", () => {
  const problems = explainLaunchFailure({
    blockers: [reason("material_mismatch", "Не тот материал")],
    reviews: [reason("bed_unknown", "Состояние стола неизвестно")],
    warnings: []
  });
  assert.equal(primaryProblem(problems)?.code, "material_mismatch");
});

test("an informational note is never the headline", () => {
  const problems = explainLaunchFailure({
    blockers: [],
    reviews: [],
    warnings: [reason("manual_start_only", "Удалённый запуск не поддержан")]
  });
  assert.equal(primaryProblem(problems), null);
});

test("with nothing wrong there is no headline to show", () => {
  assert.equal(primaryProblem([]), null);
});

test("ordering in the source array does not decide the headline", () => {
  // The old behaviour was "the first blocker", which is the order the rules
  // happen to run in — not a priority.
  const consequenceFirst = explainLaunchFailure({
    blockers: [reason("printer_busy", "занят"), reason("printer_fault", "MicroSD (0500-C010)")],
    reviews: [],
    warnings: []
  });
  const causeFirst = explainLaunchFailure({
    blockers: [reason("printer_fault", "MicroSD (0500-C010)"), reason("printer_busy", "занят")],
    reviews: [],
    warnings: []
  });

  assert.equal(primaryProblem(consequenceFirst)?.code, "printer_fault");
  assert.equal(primaryProblem(causeFirst)?.code, "printer_fault");
});

test("a per-device fault keeps its own message as the instruction", () => {
  // `printer_fault` has no fixed action: the message carries the printer's own
  // code and remedy, which is more specific than any fixed text could be.
  const problem = explainReason(
    reason("printer_fault", "Ошибка чтения/записи карты MicroSD (0500-C010)"),
    "blocker"
  );
  assert.match(problem.action, /0500-C010/);
  assert.match(problem.technical, /^printer_fault: /);
});

test("an unmapped code falls through honestly rather than apologising", () => {
  const problem = explainReason(reason("brand_new_code", "нечто новое"), "blocker");
  assert.equal(problem.title, "нечто новое");
  assert.equal(problem.action, "нечто новое");
});
