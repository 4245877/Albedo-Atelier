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
