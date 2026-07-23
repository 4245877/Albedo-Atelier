import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { createPoller } from "../shared/polling.js";

/*
 * Общий поллер разделов дашборда (shared/polling.js): single-flight, latest-only,
 * отмена активного запроса при остановке, чистое снятие таймера и продолжение
 * после временной ошибки. Логика без DOM — тестируется обычным `node --test`.
 * Таймеры мокаем (mock.timers) там, где нужно управлять расписанием; поздние
 * ответы отдаём вручную через управляемый runner — без реальных задержек.
 */

/** Управляемый запрос: резолвится/реджектится по команде, наблюдает свой abort. */
function deferredRunner() {
  const calls = [];
  const run = (signal, context) =>
    new Promise((resolve, reject) => {
      const call = { signal, context, resolve, reject, aborted: false };
      signal.addEventListener("abort", () => {
        call.aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
      calls.push(call);
    });
  return { calls, run };
}

/** Прогнать микрозадачи (и один макротик) без реальной задержки. */
const flush = () => new Promise((r) => setImmediate(r));

test("a slower superseded cycle never overwrites a newer refresh (latest-only)", async () => {
  const applied = [];
  const { calls, run } = deferredRunner();
  const poller = createPoller({ run, apply: (r) => applied.push(r), intervalMs: 100000, immediate: true });

  poller.start(); // цикл A — стартует и висит
  poller.refresh(); // цикл B — вытесняет A (обрывает его)

  // Отвечаем в обратном порядке: сначала новый B, потом старый A.
  calls[1].resolve("B");
  calls[0].resolve("A"); // A уже оборван — этот resolve ничего не применит
  await flush();

  assert.deepEqual(applied, ["B"], "применён только результат самого свежего цикла");
  assert.equal(calls[0].aborted, true, "вытесненный запрос был оборван");
  poller.stop();
});

test("polling never runs two requests in parallel (next starts only after the previous completes)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, run } = deferredRunner();
  const poller = createPoller({ run, apply() {}, intervalMs: 1000, immediate: true });

  poller.start();
  assert.equal(calls.length, 1, "один запуск");

  // Пока первый в полёте — сдвиг времени не порождает второй запрос.
  mock.timers.tick(5000);
  await flush();
  assert.equal(calls.length, 1, "нет пересечения, пока первый не завершился");

  // Завершаем первый — следующий планируется только через intervalMs.
  calls[0].resolve("a");
  await flush();
  assert.equal(calls.length, 1, "следующий тик не мгновенный");

  mock.timers.tick(1000);
  await flush();
  assert.equal(calls.length, 2, "второй запрос — лишь спустя интервал после завершения");

  poller.stop();
  mock.timers.reset();
});

test("stop() aborts the active request; a late result is not applied", async () => {
  const applied = [];
  const { calls, run } = deferredRunner();
  const poller = createPoller({ run, apply: (r) => applied.push(r), intervalMs: 100000, immediate: true });

  poller.start(); // цикл в полёте
  poller.stop(); // обрывает активный запрос

  assert.equal(calls[0].aborted, true, "активный запрос оборван при остановке");

  // Поздний ответ уже остановленного цикла применяться не должен.
  calls[0].resolve("late");
  await flush();
  assert.deepEqual(applied, [], "поздний результат после stop не применён");
});

test("stop() clears the scheduled timer — no new cycle fires afterwards", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, run } = deferredRunner();
  const poller = createPoller({ run, apply() {}, intervalMs: 1000, immediate: true });

  poller.start();
  calls[0].resolve("a"); // завершаем → планируется следующий тик через 1000
  await flush();
  assert.equal(calls.length, 1);

  poller.stop(); // должен снять запланированный таймер

  mock.timers.tick(10000);
  await flush();
  assert.equal(calls.length, 1, "после stop таймер снят — новый цикл не запускается");

  mock.timers.reset();
});

test("repeated start() does not spawn a second polling loop", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, run } = deferredRunner();
  const poller = createPoller({ run, apply() {}, intervalMs: 1000, immediate: true });

  poller.start();
  poller.start(); // no-op — цикл уже идёт
  poller.start();
  assert.equal(calls.length, 1, "только одна петля опроса");

  poller.stop();
  mock.timers.reset();
});

test("a transient error keeps polling; the next successful cycle recovers", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const applied = [];
  const errors = [];
  const { calls, run } = deferredRunner();
  const poller = createPoller({
    run,
    apply: (r) => applied.push(r),
    onError: (e) => errors.push(e),
    intervalMs: 1000,
    immediate: true
  });

  poller.start();
  calls[0].reject(Object.assign(new Error("boom"), { name: "TypeError" }));
  await flush();
  assert.equal(errors.length, 1, "ошибка самого свежего цикла доложена");
  assert.deepEqual(applied, [], "при ошибке ничего не применено");

  // Опрос продолжается: следующий тик запланирован несмотря на ошибку.
  mock.timers.tick(1000);
  await flush();
  assert.equal(calls.length, 2, "поллинг продолжился после ошибки");

  calls[1].resolve("ok");
  await flush();
  assert.deepEqual(applied, ["ok"], "следующий успешный цикл восстановил нормальное состояние");

  poller.stop();
  mock.timers.reset();
});

test("the abort of a superseded cycle is not surfaced as an error", async () => {
  const errors = [];
  const { calls, run } = deferredRunner();
  const poller = createPoller({
    run,
    apply() {},
    onError: (e) => errors.push(e),
    intervalMs: 100000,
    immediate: true
  });

  poller.start(); // A
  poller.refresh(); // B — обрывает A (A реджектится AbortError)
  calls[1].resolve("B");
  await flush();

  assert.deepEqual(errors, [], "отмена вытесненного цикла проглочена, а не показана");
  poller.stop();
});
