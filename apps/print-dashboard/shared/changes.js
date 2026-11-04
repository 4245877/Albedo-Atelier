/* Успешная мутация инвалидирует связанные чтения сразу, в том числе в другой
   вкладке браузера. Передаём только имена ресурсов и путь, без телеметрии,
   содержимого файлов и ответа API. Фоновый опрос остаётся страховкой. */
export function mutationResources(path) {
  const p = path.split("?")[0];
  if (/^\/api\/print\/artifacts(?:\/|$)/.test(p)) return ["artifacts", "tasks", "slicing"];
  if (/^\/api\/print\/slicing(?:\/|$)/.test(p)) return ["slicing", "artifacts", "tasks"];
  if (/^\/api\/print\/(operations|schedule)(?:\/|$)/.test(p)) return ["operations", "printers", "tasks"];
  if (/^\/api\/print\/(tasks|queue|launch|runs|assignments|scheduler)(?:\/|$)/.test(p) ||
      /^\/api\/queue(?:\/|$)/.test(p)) return ["tasks", "printers", "operations"];
  if (/^\/api\/printers\//.test(p) && !/\/(snapshot|light)$/.test(p)) return ["printers", "tasks", "operations"];
  if (/^\/api\/automations(?:\/|$)/.test(p)) return ["tasks", "printers"];
  return [];
}

export function createChangeBus({ target, openChannel } = {}) {
  let channel;
  const listeners = new Set();
  const deliver = (change) => {
    if (!change || !Array.isArray(change.resources)) return;
    for (const listener of listeners) {
      // Ошибка одного представления не превращает успешную запись API в отказ
      // и не мешает остальным разделам получить обновление.
      try { listener(change); } catch (error) { console.error("print change listener failed", error); }
    }
  };
  function connect() {
    if (channel || !openChannel) return;
    try {
      channel = openChannel();
      channel.onmessage = (event) => deliver(event.data);
    } catch { /* недоступен в приватном режиме — локальные события работают */ }
  }
  function disconnect() {
    channel?.close();
    channel = null;
  }
  const receive = (event) => deliver(event.detail);
  target?.addEventListener("print-data-changed", receive);
  return {
    publish(path, method) {
      const resources = mutationResources(path);
      if (!resources.length) return;
      const change = { path, method, resources };
      // Не зависим от CustomEvent: этот же bus проверяется без браузера.
      deliver(change);
      connect();
      try { channel?.postMessage(change); } catch { /* локальное обновление уже доставлено */ }
    },
    subscribe(resources, callback) {
      connect();
      const listener = (change) => {
        if (change.resources.some((r) => resources.includes(r))) callback(change);
      };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      disconnect();
      target?.removeEventListener("print-data-changed", receive);
      listeners.clear();
    },
    connect,
    disconnect
  };
}

let bus;
function browserBus() {
  if (typeof document === "undefined") return null;
  if (bus) return bus;
  bus = createChangeBus({
    target: document,
    openChannel: typeof BroadcastChannel === "function"
      ? () => new BroadcastChannel("atelier-print-changes") : undefined
  });
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => bus.disconnect());
    window.addEventListener("pageshow", () => bus.connect());
  }
  return bus;
}

export function notifyMutation(path, method) {
  browserBus()?.publish(path, method);
}

export function subscribePrintChanges(resources, callback) {
  return browserBus()?.subscribe(resources, callback) ?? (() => {});
}

/** Hidden work sections refresh when reopened; they need no duplicate reads now. */
export function isSectionVisible(id) {
  const section = document.getElementById(id);
  return Boolean(!document.hidden && section && !section.closest("[hidden]"));
}
