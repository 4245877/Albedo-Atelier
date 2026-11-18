export const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";

export async function probeCdp() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const version = await response.json();
    if (!version?.webSocketDebuggerUrl) throw new Error("Missing CDP WebSocket URL");
    return version;
  } catch (error) {
    if (process.env.CHROME_CDP_URL) {
      throw new Error(`Chrome CDP is unavailable at ${CDP_URL}`, { cause: error });
    }
    return null;
  }
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const exceptions = [];
  let seq = 0;

  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const command = pending.get(message.id);
    if (command) {
      pending.delete(message.id);
      clearTimeout(command.timer);
      if (message.error) command.reject(new Error(message.error.message));
      else command.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params?.exceptionDetails;
      exceptions.push(detail?.exception?.description || detail?.text || "uncaught exception");
    }
  };

  ws.onclose = () => {
    for (const command of pending.values()) {
      clearTimeout(command.timer);
      command.reject(new Error("CDP WebSocket closed"));
    }
    pending.clear();
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("CDP WebSocket did not open"));
    }, 10000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket failed"));
    };
  });

  const send = (method, params = {}) => {
    if (ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Cannot send ${method}: CDP WebSocket is closed`));
    }
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const expression = params.expression?.slice(0, 100);
        reject(new Error(`CDP timed out: ${method}${expression ? ` (${expression})` : ""}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  return { send, exceptions, close: () => ws.close() };
}
