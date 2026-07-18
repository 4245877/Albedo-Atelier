/* ── Однопоточный опрос без гонок ────────────────────────────────
   Обёртка над периодическим асинхронным запросом, которая гарантирует, что
   применится результат ТОЛЬКО самого свежего запуска: более ранний ответ,
   пришедший позже нового, отбрасывается, а предыдущий запрос отменяется через
   AbortController. Это и есть защита от того, что «старый GET завершится после
   нового и вернёт UI к устаревшему состоянию».

   Логика намеренно вынесена в чистый модуль без DOM, чтобы её можно было
   покрыть юнит-тестом (tests/poll.test.mjs) в изоляции. */

/**
 * @param {object} deps
 * @param {(signal: AbortSignal, opts: any) => Promise<any>} deps.run  запуск запроса
 * @param {(result: any, opts: any) => void} deps.apply  применение результата (только для самого свежего)
 * @param {(err: any, opts: any) => void} [deps.onError] обработка ошибки (только для самого свежего, кроме отмены)
 * @returns {(opts?: any) => Promise<void>} триггер очередного запуска
 */
export function createLatestOnly({ run, apply, onError }) {
  let seq = 0;
  let controller = null;

  return async function trigger(opts) {
    // Отменяем предыдущий незавершённый запрос: single-flight + отмена.
    if (controller) controller.abort();
    const ac = new AbortController();
    controller = ac;
    const mySeq = ++seq;

    try {
      const result = await run(ac.signal, opts);
      // Пока мы ждали, стартовал более новый запуск — этот результат устарел.
      if (mySeq !== seq) return;
      apply(result, opts);
    } catch (err) {
      // Отмена (нас вытеснил более новый запуск) — не ошибка.
      if (err && err.name === "AbortError") return;
      if (mySeq !== seq) return;
      if (onError) onError(err, opts);
    } finally {
      if (controller === ac) controller = null;
    }
  };
}
