/* ── Клиент API ─────────────────────────────────────────────────
   Backend доступен по тому же origin: nginx отдаёт эту страницу и
   проксирует /api/print-orchestrator/* в сервис print-orchestrator. */

export const API_BASE = "/api/print-orchestrator";

async function apiError(res) {
  const body = await res.json().catch(() => null);
  const message = body?.error?.message || `HTTP ${res.status}`;
  const err = new Error(message);
  err.code = body?.error?.code;
  return err;
}

export async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function apiPost(path, body) {
  const opts = { method: "POST", headers: { Accept: "application/json" } };
  // Отправляем тело (и Content-Type) только когда оно есть — иначе Fastify
  // отвергнет пустое тело при заявленном application/json.
  if (body !== undefined && body !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) throw await apiError(res);
  return res.json().catch(() => ({}));
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
