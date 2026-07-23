/* ── Защита мутаций от повторного запуска ─────────────────────────
   Единый in-flight guard для действий, запускаемых кнопками. Пока
   операция с данным ключом ещё выполняется, повторный вызов с тем же
   ключом игнорируется — двойное нажатие (или второй клик по кнопке,
   которую перерисовал поллинг) не порождает вторую одинаковую мутацию.
   Ключ освобождается в finally — в том числе при ошибке/таймауте, — так
   что после сбоя действие снова доступно.

   Модуль без DOM: покрывается юнит-тестом (tests/inflight.test.mjs). */

export function createInflightGuard() {
  const busy = new Set();

  /**
   * @param {string} key   идентификатор операции (совпадающие ключи = «та же мутация»)
   * @param {() => Promise<any>} fn  сама операция
   * @returns {Promise<{ skipped: boolean, value?: any }>} skipped=true, если ключ уже в работе
   */
  async function run(key, fn) {
    if (busy.has(key)) return { skipped: true };
    busy.add(key);
    try {
      return { skipped: false, value: await fn() };
    } finally {
      busy.delete(key);
    }
  }

  return {
    run,
    isBusy: (key) => busy.has(key)
  };
}
