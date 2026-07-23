/* ── Единый надёжный поллер без гонок ─────────────────────────────
   Общий примитив опроса для всех независимых разделов дашборда
   (доска, планировщик, загрузки). Гарантирует:

     • single-flight  — одновременно исполняется не более одного запроса;
     • latest-only     — применяется результат ТОЛЬКО самого свежего цикла:
                         более ранний ответ, пришедший позже, отбрасывается;
     • отмена          — предыдущий/остановленный запрос обрывается через
                         AbortController, а его поздний результат не применяется;
     • after-completion — следующий запрос планируется ПОСЛЕ завершения
                         предыдущего с заданной задержкой (пересечения исключены
                         конструктивно, а не только защитой от гонок);
     • устойчивость    — после временной ошибки цикл продолжается;
     • чистый стоп      — stop() снимает таймер и обрывает активный запрос;
     • без двойных петель — повторный start() при уже запущенном цикле no-op;
     • без unhandled rejection — все ошибки run() проходят через onError/глушение.

   Модуль намеренно без DOM, чтобы покрываться юнит-тестами (tests/polling.test.mjs)
   в изоляции — как и родственный poll.js (createLatestOnly для главной доски). */

/**
 * @template T
 * @param {object} deps
 * @param {(signal: AbortSignal, context: any) => Promise<T>} deps.run   выполнить запрос
 * @param {(result: T, context: any) => void} deps.apply                 применить результат (только для самого свежего цикла)
 * @param {(err: any, context: any) => void} [deps.onError]              обработать ошибку (кроме отмены; только для самого свежего цикла)
 * @param {number} deps.intervalMs                                       задержка перед следующим циклом (после завершения текущего)
 * @param {boolean} [deps.immediate=true]                                выполнить первый цикл сразу при start()
 * @param {any | (() => any)} [deps.pollContext]                         контекст, передаваемый автоматическим циклам (объект или фабрика)
 * @returns {{ start(context?: any): void, stop(): void, refresh(context?: any): void, isRunning(): boolean }}
 */
export function createPoller({ run, apply, onError, intervalMs, immediate = true, pollContext = {} }) {
  let seq = 0;
  let controller = null;
  let timer = null;
  let running = false;

  function resolvePollContext() {
    return typeof pollContext === "function" ? pollContext() : pollContext;
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function reschedule() {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void cycle(resolvePollContext());
    }, intervalMs);
  }

  async function cycle(context) {
    // Вытесняем предыдущий незавершённый запрос: single-flight + отмена.
    if (controller) controller.abort();
    const ac = new AbortController();
    controller = ac;
    const mySeq = ++seq;
    // latest: остаёмся ли мы самым свежим циклом к моменту завершения. Если нас
    // вытеснил новый цикл или поллер остановлен — переносить следующий тик будет
    // (или не будет — при stop) он, а не мы, иначе появятся две петли.
    let latest = true;
    try {
      const result = await run(ac.signal, context);
      if (!running || mySeq !== seq) {
        latest = false;
        return;
      }
      apply(result, context);
    } catch (err) {
      // Отмена (вытеснение более новым циклом или stop) — не ошибка.
      if ((err && err.name === "AbortError") || !running || mySeq !== seq) {
        latest = false;
        return;
      }
      if (onError) onError(err, context);
    } finally {
      if (controller === ac) controller = null;
      if (running && latest) reschedule();
    }
  }

  return {
    /** Запустить цикл опроса. Повторный вызов при уже запущенном — no-op. */
    start(context) {
      if (running) return;
      running = true;
      if (immediate) void cycle(context === undefined ? resolvePollContext() : context);
      else reschedule();
    },
    /** Остановить: снять таймер, оборвать активный запрос, обесценить поздние ответы. */
    stop() {
      running = false;
      clearTimer();
      if (controller) {
        controller.abort();
        controller = null;
      }
      // Инвалидируем любой ещё висящий in-flight: даже если run() проигнорирует
      // abort и разрешится, его результат уже не пройдёт проверку mySeq !== seq.
      seq++;
    },
    /** Немедленный внеочередной цикл (например, после мутации). Возвращает промис
        завершения цикла, чтобы вызывающий мог его дождаться. Если остановлен — no-op. */
    refresh(context = {}) {
      if (!running) return Promise.resolve();
      clearTimer();
      return cycle(context);
    },
    isRunning() {
      return running;
    }
  };
}
