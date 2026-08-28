import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analysisBudgetMs,
  AnalysisTimeoutError,
  ANALYSIS_MAX_TIMEOUT_MS,
  ANALYSIS_MS_PER_MB
} from "./analysisBudget";

const MB = 1024 * 1024;

/*
 * A flat 30 s budget failed every large healthy file — and because the slice
 * output gate reads the same analysis, the slice then went `blocked` for a reason
 * that said nothing about the file. The budget scales with the input; the floor
 * keeps a small pathological file failing fast.
 */

test("the budget grows with the file and never drops below the configured base", () => {
  const base = 30_000;
  assert.equal(analysisBudgetMs(0, base), base, "an empty file gets exactly the base");
  assert.equal(analysisBudgetMs(1 * MB, base), base + ANALYSIS_MS_PER_MB);
  assert.equal(analysisBudgetMs(50 * MB, base), base + 50 * ANALYSIS_MS_PER_MB);
  // The 50 MB file this was all about: 60 s of budget against ~5 s of real work.
  assert.ok(analysisBudgetMs(50 * MB, base) >= 60_000);
  // And the 200 MB the upload limit allows is still comfortably covered.
  assert.ok(analysisBudgetMs(200 * MB, base) >= 150_000);
  // Monotone: a bigger file never gets less time.
  let previous = 0;
  for (const mb of [0, 1, 10, 25, 50, 100, 200, 500, 2000]) {
    const budget = analysisBudgetMs(mb * MB, base);
    assert.ok(budget >= previous, `${mb} MB got less budget than the size below it`);
    previous = budget;
  }
});

test("an unknown size buys no extra time — fail-closed, not fail-generous", () => {
  const base = 30_000;
  for (const size of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(analysisBudgetMs(size, base), base, `size ${String(size)}`);
  }
});

test("the budget is capped, so one pathological file cannot hold a worker forever", () => {
  assert.equal(analysisBudgetMs(100_000 * MB, 30_000), ANALYSIS_MAX_TIMEOUT_MS);
  // A base larger than the cap is still honoured — an explicit operator setting
  // is a decision, not an error to clamp away.
  const huge = ANALYSIS_MAX_TIMEOUT_MS * 2;
  assert.equal(analysisBudgetMs(1 * MB, huge), huge);
});

test("an invalid base falls back to the documented default rather than to zero", () => {
  // A zero/NaN budget would fail every analysis instantly, which reads to the
  // operator exactly like a rejected file.
  for (const bad of [0, -5, Number.NaN]) {
    assert.equal(analysisBudgetMs(0, bad), 30_000, `base ${String(bad)}`);
  }
});

test("a timeout says it is a timeout, with the size and the budget it exceeded", () => {
  const error = new AnalysisTimeoutError(60_000, 50 * MB);
  assert.equal(error.code, "ANALYSIS_TIMEOUT");
  assert.match(error.message, /50\.0 МБ/);
  assert.match(error.message, /60 с/);
  // The distinction that matters: this is NOT a statement that the file is bad.
  assert.match(error.message, /не отклонён/);
  assert.match(new AnalysisTimeoutError(30_000, 0).message, /неизвестного размера/);
});
