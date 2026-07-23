/* ═══════════════════════════════════════════════════════════════
   Albedo — Зал Верховного Надзора (front-end, точка входа)
   Данные приходят с backend (print-orchestrator) через nginx-прокси
   /api/print-orchestrator/*. Состояние загружается из GET /api/dashboard,
   действия отправляются POST-запросами, панель периодически обновляется.

   Модули:
     api.js          — клиент REST API
     util.js         — DOM/формат/тосты
     nav.js          — навигация, scroll-spy, липкие смещения, появление секций
     cameraPlayers.js— живые WebRTC-плееры камер
     render/*        — отрисовка секций доски
     actions.js      — действия оператора и делегированные клики
   ═══════════════════════════════════════════════════════════════ */

import { apiGet, apiPost } from "./api.js";
import { createPoller } from "./shared/polling.js";
import { installActions } from "./actions.js";
import { reconcileCameras } from "./cameraPlayers.js";
import { ensureReveal, renderNav, setupNav, setupStickyOffsets } from "./nav.js";
import { renderBoard } from "./render/board.js";
import { syncModals } from "./render/modals.js";
import { renderTopbar } from "./render/sections.js";
import { setupScheduler } from "./render/scheduler.js";
import { setupSlicing } from "./render/slicing.js";
import { setupUploads } from "./render/uploads.js";
import { setNightWindow, setupTheme } from "./theme.js";
import { $, esc, toast } from "./util.js";

/* Состояние фермы — заполняется из GET /api/dashboard. До первой удачной
   загрузки равно null. */
let state = null;
let backendReachable = false;
let everLoaded = false;
/* Снимок последних отрисованных данных: если новый ответ идентичен,
   DOM не пересобираем (камеры не мигают, нет лишних перекачек кадров). */
let lastRenderedJson = null;

/* ── Аренда мониторинга ────────────────────────────────────── */

/* Пока вкладка видима, панель продлевает короткую аренду «оператор смотрит»:
   backend на это время включает подсветку поддерживаемых принтеров, чтобы в
   камерах было видно происходящее. Явной команды выключения нет — аренда
   истекает на backend сама (~90 с), поэтому скрытая или закрытая вкладка
   просто перестаёт её продлевать. Ошибки продления не трогают обновление
   доски: это отдельный тихий запрос. */

const LEASE_RENEW_INTERVAL_MS = 30000;
let leaseTimer = null;

function renewMonitoringLease() {
  apiPost("/api/monitoring/lease").catch(() => {});
}

function startLeaseRenewal() {
  if (leaseTimer !== null) return; // повторные visibilitychange не плодят таймеры
  renewMonitoringLease();
  leaseTimer = setInterval(renewMonitoringLease, LEASE_RENEW_INTERVAL_MS);
}

function stopLeaseRenewal() {
  if (leaseTimer === null) return;
  clearInterval(leaseTimer);
  leaseTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLeaseRenewal();
  else startLeaseRenewal();
});

/* ── Часы ──────────────────────────────────────────────────── */

function tickClock() {
  $("#clock").textContent = new Date().toLocaleTimeString("ru-RU", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/* ── Загрузка данных и отрисовка ───────────────────────────── */

function renderAll() {
  if (!state) return;
  const snapshot = JSON.stringify(state);
  if (snapshot === lastRenderedJson) {
    // Данные не изменились — трогаем только шапку (статус связи), DOM доски
    // оставляем как есть, чтобы не пересоздавать <img> камер (без мерцания).
    renderTopbar(state, backendReachable);
    return;
  }
  lastRenderedJson = snapshot;
  // Навигация статична (постоянный список разделов) — строим один раз при
  // старте, чтобы обновления данных не сбрасывали активную вкладку и позицию
  // горизонтальной прокрутки.
  renderBoard(state);
  // Доска пересобрана — вернуть живые видеоплееры в новые крепления, чтобы
  // трансляция не прерывалась при обновлении телеметрии.
  reconcileCameras();
  renderTopbar(state, backendReachable);
  // Открытое окно деталей принтера держим в согласии со свежим состоянием.
  syncModals();
  ensureReveal();
}

function renderBackendError(err) {
  const pills = $("#hero-pills");
  if (pills) {
    pills.innerHTML = `
      <span class="pill pill-danger"><i class="dot dot-pulse"></i>Backend безмолвствует</span>
      <span class="pill pill-warn"><i class="dot"></i>Взываю вновь каждые 6 с…</span>`;
  }
  toast(`Владыка, ферма не отвечает на мой зов: ${esc(err.message)}. Я не покину пост, пока связь не вернётся`, "toast-danger");
}

/* Опрос доски проходит через общий createPoller: single-flight + latest-only +
   отмена подвисших запросов. Старый ответ, пришедший позже нового, отбрасывается
   и не откатывает UI. Следующий тик планируется ПОСЛЕ завершения предыдущего,
   а stop() (на pagehide) снимает таймер и обрывает активный запрос. */
const DASHBOARD_POLL_MS = 6000;
const dashboardPoller = createPoller({
  run: (signal) => apiGet("/api/dashboard", { signal }),
  apply: (data, { wasReachable }) => {
    state = data;
    backendReachable = true;
    // Эффективное ночное окно фермы определяет backend (NIGHT_PRINT_WINDOW);
    // auto-тема следует ему. Старый payload без этих полей оставляет fallback.
    setNightWindow(data.night?.windowStart, data.night?.windowEnd);
    renderAll();
    if (everLoaded && !wasReachable) toast("Связь восстановлена — зал вновь под моим неусыпным надзором, Владыка ❖", "toast-ok");
    everLoaded = true;
  },
  onError: (err, { silent }) => {
    backendReachable = false;
    renderTopbar(state, backendReachable);
    if (!silent) renderBackendError(err);
  },
  intervalMs: DASHBOARD_POLL_MS,
  // Первый тик запускаем вручную (refresh с silent:false); дальше — по таймеру.
  immediate: false,
  // Фоновые тики — тихие; wasReachable читаем на момент цикла (backend мог отпасть).
  pollContext: () => ({ silent: true, wasReachable: backendReachable })
});

/** Перезагрузить состояние и перерисовать. По умолчанию тихо (для поллинга). */
function refresh({ silent = true } = {}) {
  return dashboardPoller.refresh({ silent, wasReachable: backendReachable });
}

/* ── Старт ─────────────────────────────────────────────────── */

installActions({ getState: () => state, refresh });

setupTheme();
renderNav();
renderTopbar(state, backendReachable);
// Раздел загрузки живёт независимо от опроса доски: инициализируем один раз.
setupUploads();
// Раздел слайсинга (профили OrcaSlicer, наборы, подготовка) — тоже независим.
setupSlicing();
// Раздел планировщика (ручная очередь, совместимость, план, ночь) — независим.
setupScheduler();
tickClock();
setInterval(tickClock, 1000);

// Видимость секций не должна зависеть от загрузки данных: если backend
// недоступен на первом заходе, доска (и сообщение об ошибке в hero) всё равно
// проявляется, а не остаётся с opacity:0.
ensureReveal();
setupStickyOffsets();
setupNav();

// Запускаем цикл опроса, затем — немедленная первая (не тихая) загрузка. Дальше
// каждый следующий тик планируется через DASHBOARD_POLL_MS после завершения
// предыдущего — подвисший GET не накладывается на новый.
dashboardPoller.start();
void refresh({ silent: false });

// Первая аренда мониторинга — сразу после открытия видимой панели.
if (!document.hidden) startLeaseRenewal();

// Уход со страницы: снять таймеры опроса и аренды, оборвать активный запрос.
window.addEventListener("pagehide", () => {
  dashboardPoller.stop();
  stopLeaseRenewal();
});
