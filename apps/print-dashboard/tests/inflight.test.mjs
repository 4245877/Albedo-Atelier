import assert from "node:assert/strict";
import { test } from "node:test";

import { createInflightGuard } from "../shared/inflight.js";

/*
 * In-flight guard мутаций (shared/inflight.js): пока операция с ключом ещё в
 * полёте, повторный вызов с тем же ключом игнорируется (двойное нажатие не шлёт
 * вторую одинаковую мутацию); ключ освобождается в finally — в т.ч. после сбоя.
 */

test("a duplicate call while in-flight is skipped and the op runs only once", async () => {
  const guard = createInflightGuard();
  let calls = 0;
  let release;
  const fn = () =>
    new Promise((resolve) => {
      calls++;
      release = resolve;
    });

  const p1 = guard.run("k", fn); // стартует, висит
  const r2 = await guard.run("k", fn); // дубль, пока первый в полёте

  assert.equal(r2.skipped, true, "повторное нажатие проигнорировано");
  assert.equal(calls, 1, "операция запущена лишь однажды");
  assert.equal(guard.isBusy("k"), true);

  release("done");
  const r1 = await p1;
  assert.equal(r1.skipped, false);
  assert.equal(r1.value, "done");
  assert.equal(guard.isBusy("k"), false, "ключ освобождён после завершения");
});

test("different keys run concurrently — unrelated actions are not blocked", async () => {
  const guard = createInflightGuard();
  let a = 0;
  let b = 0;
  const pa = guard.run("a", () => new Promise(() => { a++; })); // висит
  const rb = await guard.run("b", async () => { b++; return 1; }); // другой ключ — исполняется

  assert.equal(a, 1);
  assert.equal(b, 1, "несвязанное действие не заблокировано");
  assert.equal(rb.skipped, false);
  assert.equal(guard.isBusy("a"), true);
  void pa;
});

test("the key is freed after a failure, so a retry is allowed", async () => {
  const guard = createInflightGuard();

  await assert.rejects(
    guard.run("k", () => Promise.reject(new Error("boom"))),
    /boom/
  );
  assert.equal(guard.isBusy("k"), false, "ключ освобождён даже после ошибки");

  let ran = false;
  const r = await guard.run("k", async () => {
    ran = true;
    return 42;
  });
  assert.equal(ran, true, "повторная попытка после сбоя выполняется");
  assert.equal(r.value, 42);
});
