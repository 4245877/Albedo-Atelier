/* ── Клиент API ─────────────────────────────────────────────────
   Backend доступен по тому же origin: nginx отдаёт эту страницу и
   проксирует /api/print-orchestrator/* в сервис print-orchestrator. */

export const API_BASE = "/api/print-orchestrator";

async function apiError(res) {
  const body = await res.json().catch(() => null);
  // HTTP-статус сохраняем всегда — даже если тело пустое или без error.message,
  // вызывающий код (напр. распознавание 409) не должен терять эту информацию.
  const message = body?.error?.message || `HTTP ${res.status}`;
  const err = new Error(message);
  err.code = body?.error?.code;
  err.status = res.status;
  return err;
}

/*
 * Объединяет необязательный внешний signal вызывающей стороны с собственным
 * жёстким дедлайном (timeout). Возвращает итоговый signal и cleanup(), который
 * ОБЯЗАТЕЛЬНО снимает таймер после завершения запроса (иначе таймаут-таймер
 * висел бы до срабатывания и удерживал event loop).
 *
 * Различение исходов по reason итогового AbortError:
 *   • timeout   → DOMException "TimeoutError"  (настоящий сбой);
 *   • внешняя отмена → reason внешнего signal (обычно "AbortError" — вытеснён,
 *                      вызывающий его игнорирует).
 * Мы НЕ создаём отдельный контроллер, игнорирующий переданный signal: внешний
 * signal подписан и пробрасывается в общий контроллер.
 */
function withDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;

  const onExternalAbort = () => controller.abort(signal.reason);

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  if (!controller.signal.aborted && timeoutMs != null && timeoutMs > 0) {
    timer = setTimeout(
      () => controller.abort(new DOMException(`Истекло ожидание (${timeoutMs} мс)`, "TimeoutError")),
      timeoutMs
    );
  }

  function cleanup() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }

  return { signal: controller.signal, cleanup };
}

export async function apiGet(path, { signal, timeoutMs = 15000 } = {}) {
  const deadline = withDeadline(signal, timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: deadline.signal
    });
    if (!res.ok) throw await apiError(res);
    return await res.json();
  } finally {
    deadline.cleanup();
  }
}

export async function apiPost(path, body, { signal, timeoutMs = 15000 } = {}) {
  const opts = { method: "POST", headers: { Accept: "application/json" } };
  // Отправляем тело (и Content-Type) только когда оно есть — иначе Fastify
  // отвергнет пустое тело при заявленном application/json.
  if (body !== undefined && body !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  // Мутации тоже получают жёсткий дедлайн (и, при необходимости, внешний signal),
  // чтобы подвисший POST не держал кнопку заблокированной бесконечно.
  const deadline = withDeadline(signal, timeoutMs);
  opts.signal = deadline.signal;
  try {
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (!res.ok) throw await apiError(res);
    return await res.json().catch(() => ({}));
  } finally {
    deadline.cleanup();
  }
}

/*
 * Загрузка одного файла через multipart с честным прогрессом. fetch() не
 * отдаёт прогресс отправки, поэтому используем XHR: каждый файл — отдельный
 * запрос POST /api/print/artifacts, что и даёт точный процент по каждому файлу.
 * Токен управления подставляет nginx-прокси (как и для остальных действий),
 * Content-Type multipart XHR выставляет сам из FormData.
 */
export function uploadArtifact(file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/api/print/artifacts`);
    xhr.responseType = "json";
    xhr.setRequestHeader("Accept", "application/json");

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    });

    xhr.addEventListener("load", () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
      } else {
        const err = new Error(body?.error?.message || `HTTP ${xhr.status}`);
        err.code = body?.error?.code;
        reject(err);
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Сеть недоступна")));
    xhr.addEventListener("abort", () => reject(new DOMException("Отменено", "AbortError")));

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });
}
