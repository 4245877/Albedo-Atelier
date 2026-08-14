/* ── DOM-утилиты (выбор, экранирование, тосты, пустые состояния) ──
   Только DOM-помощники. Форматирование чисел/дат — shared/format.js,
   чипы/бейджи/панели — shared/chips.js, блоки принтера — render/printerParts.js. */

export const $ = (sel) => document.querySelector(sel);

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Экранирование строки для селектора атрибута ([data-x="…"]). */
export function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

/** Пустое состояние секции: данных реально нет — не подставляем выдуманные. */
export function emptyRow(text) {
  return `<li class="row"><div class="grow row-sub">${esc(text)}</div></li>`;
}

/* ── Тосты ─────────────────────────────────────────────────── */

/* Сколько живёт уведомление. Прежние 3.4 с не давали дочитать даже короткую
   фразу, а длинные («приказ не исполнен: …») исчезали раньше, чем взгляд
   доходил до причины. Считаем по типу: отказ разбирают дольше, чем успех, а
   любое уведомление можно закрыть рукой и придержать наведением. */
const TOAST_MS = { "toast-danger": 15000, "toast-ok": 7000, default: 8000 };
/* Больше четырёх карточек в углу — уже не уведомления, а перекрытый интерфейс:
   самое старое уходит, освобождая место новому. */
const MAX_TOASTS = 4;

/** `ms` — для самоочевидных подтверждений (смена облика зала): читать там нечего,
    и держать карточку общие 8 с незачем. Возвращает функцию закрытия. */
export function toast(msg, kind = "", { ms } = {}) {
  const stack = $("#toasts");
  if (!stack) return;

  const el = document.createElement("div");
  el.className = kind ? `toast ${kind}` : "toast";
  // Отказ читается вслух немедленно: контейнер объявлен polite, и без role=alert
  // сообщение об ошибке ждало бы паузы в речи скринридера.
  if (kind === "toast-danger") el.setAttribute("role", "alert");
  el.innerHTML =
    `<span class="star" aria-hidden="true">❖</span>` +
    `<span class="toast-msg">${msg}</span>` +
    `<button type="button" class="toast-close" aria-label="Закрыть уведомление" title="Закрыть">✕</button>`;
  stack.appendChild(el);

  // Живыми считаем только те, что ещё не уходят: иначе уже погашенные карточки
  // считались бы за место в стеке и вытесняли свежие.
  const live = stack.querySelectorAll(".toast:not([data-closing])");
  for (let i = 0; i < live.length - MAX_TOASTS; i++) live[i].remove();

  const total = ms || TOAST_MS[kind] || TOAST_MS.default;
  let left = total;
  let startedAt = Date.now();
  let timer = setTimeout(close, total);

  function close() {
    if (el.dataset.closing) return;
    el.dataset.closing = "1";
    clearTimeout(timer);
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    // Страховка на случай, если анимация не проиграется (элемент вне потока,
    // отключённые переходы): карточка не должна остаться в DOM навсегда.
    setTimeout(() => el.remove(), 600);
  }

  // Наведение и фокус придерживают отсчёт: длинное сообщение можно дочитать
  // спокойно, не гоняясь за исчезающей карточкой.
  function hold() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    left -= Date.now() - startedAt;
  }
  function resume() {
    if (timer || el.dataset.closing) return;
    startedAt = Date.now();
    // После отпускания даём дочитать: меньше 2.5 с уже не успеть.
    timer = setTimeout(close, Math.max(2500, left));
  }

  el.addEventListener("pointerenter", hold);
  el.addEventListener("pointerleave", resume);
  el.addEventListener("focusin", hold);
  el.addEventListener("focusout", resume);
  el.querySelector(".toast-close").addEventListener("click", close);

  return close;
}
