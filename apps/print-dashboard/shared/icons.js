/* ── Глифы Назарика: единая SVG-система ─────────────────────────
   Одна точка правды для КАЖДОГО значка интерфейса. До этого доска жила на
   тридцати с лишним символах юникода (⚠ ⛔ ☀ ☾ ✕ ✓ 🗂 🖼 📁 🔴 🟢 …): часть
   из них самохостящиеся Inter/Cormorant не покрывают вовсе (пустой квадрат),
   часть ОС подменяет собственными эмодзи — разного цвета, размера и базовой
   линии на Windows, macOS и Android. Значок интерфейса не имеет права
   зависеть от того, какой эмодзи-шрифт установлен у оператора.

   Правила набора (нарушать — значит вернуть разнобой):
     • одна сетка 20×20 и один визуальный вес: stroke-width 1.5, круглые
       окончания и стыки — линии читаются от 14 до 20 px;
     • только `currentColor` — цвет задаёт контекст (кнопка, статус, тема),
       внутри значка цветов нет;
     • заливка допускается лишь как акцент (зрачок, точка, остриё) и тоже
       currentColor;
     • ни одного значка «на всякий случай»: набор равен тому, что реально
       нарисовано на доске.

   Характер — Альбедо: тонкие линии, лёгкая заострённость, симметрия и
   готическая огранка (ромб-печать ❖ вместо кружка), но прежде всего —
   узнаваемость с первого взгляда. */

const P = {
  /* ── Статусы и вердикты ── */
  warn: `<path d="M10 3.6 17 15.8H3z"/><path d="M10 8.2v3.3"/><circle cx="10" cy="13.9" r=".85" fill="currentColor" stroke="none"/>`,
  blocked: `<circle cx="10" cy="10" r="6.6"/><path d="M5.3 14.7 14.7 5.3"/>`,
  check: `<path d="M4.4 10.5 8.2 14.2 15.6 6.2"/>`,
  cross: `<path d="M5.4 5.4 14.6 14.6M14.6 5.4 5.4 14.6"/>`,
  info: `<circle cx="10" cy="10" r="6.8"/><path d="M10 9.2v4.2"/><circle cx="10" cy="6.6" r=".85" fill="currentColor" stroke="none"/>`,
  /* Ромб-печать Назарика: герб, маркер списка, знак тоста. */
  sigil: `<path d="M10 3.2 14.6 10 10 16.8 5.4 10z"/>`,
  sigilFilled: `<path d="M10 3.2 14.6 10 10 16.8 5.4 10z" fill="currentColor" stroke="none"/>`,
  dot: `<circle cx="10" cy="10" r="3.6" fill="currentColor" stroke="none"/>`,

  /* ── Управление печатью ── */
  play: `<path d="M7.4 5.2 15 10l-7.6 4.8z"/>`,
  pause: `<path d="M7.6 5.4v9.2M12.4 5.4v9.2"/>`,
  stop: `<rect x="6" y="6" width="8" height="8" rx="1.4"/>`,
  /* «Отмена печати» — не «✕» и не «стоп»: перечёркнутое сопло. */
  cancelPrint: `<path d="M6.6 4.6h6.8l-1 5.2a2.4 2.4 0 0 1-2.4 1.9h0a2.4 2.4 0 0 1-2.4-1.9z"/><path d="M10 11.7v2.6"/><path d="M4.2 4.2l11.6 11.6"/>`,

  /* ── Свет ── */
  sun: `<circle cx="10" cy="10" r="3.3"/><path d="M10 2.6v1.9M10 15.5v1.9M4.8 4.8l1.35 1.35M13.85 13.85 15.2 15.2M2.6 10h1.9M15.5 10h1.9M4.8 15.2l1.35-1.35M13.85 6.15 15.2 4.8"/>`,
  moon: `<path d="M15.7 12.3A6.5 6.5 0 1 1 8.6 4.2a5.5 5.5 0 0 0 7.1 8.1Z"/>`,

  /* ── Камеры и снимки ── */
  camera: `<path d="M2.8 10C4.8 6.8 7.2 5.3 10 5.3s5.2 1.5 7.2 4.7c-2 3.2-4.4 4.7-7.2 4.7S4.8 13.2 2.8 10Z"/><ellipse cx="10" cy="10" rx="1.05" ry="2.3" fill="currentColor" stroke="none"/>`,
  shutter: `<path d="M3.4 7.4A1.6 1.6 0 0 1 5 5.8h1.9l1-1.6h4.2l1 1.6H15a1.6 1.6 0 0 1 1.6 1.6v6a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6z"/><circle cx="10" cy="10.4" r="2.5"/>`,
  frame: `<rect x="3.2" y="4.4" width="13.6" height="11.2" rx="1.6"/><path d="M3.2 12.6 7 9.2l3.2 2.9 2.5-2 4.1 3.4"/><circle cx="7.2" cy="7.6" r="1" fill="currentColor" stroke="none"/>`,

  /* ── Файлы ── */
  folder: `<path d="M3.2 15.2V5.6a1 1 0 0 1 1-1h3.3l1.5 1.9h6.8a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1Z"/>`,
  file: `<path d="M5.4 3.6h5.2l4 4v8.8a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1Z"/><path d="M10.4 3.6v4.2h4.2"/>`,
  /* Печатаемый файл: тот же лист, но с остриём ромба Назарика. */
  filePrintable: `<path d="M5.4 3.6h5.2l4 4v8.8a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1Z"/><path d="M10.4 3.6v4.2h4.2"/><path d="M9.5 10.2 11.7 13 9.5 15.8 7.3 13z" fill="currentColor" stroke="none"/>`,
  files: `<path d="M6.6 3.6h4.6l3.4 3.4v7.2a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1Z"/><path d="M11 3.6v3.4h3.4"/><path d="M3.6 6.6v9a1.4 1.4 0 0 0 1.4 1.4h7"/>`,
  upload: `<path d="M10 13.4V4.4"/><path d="M6.4 7.9 10 4.3l3.6 3.6"/><path d="M4.6 13.4v2a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-2"/>`,
  download: `<path d="M10 4.2v9"/><path d="M6.4 9.7 10 13.3l3.6-3.6"/><path d="M4.6 15.6h10.8"/>`,

  /* ── Оборудование и процессы ── */
  printer: `<path d="M5.2 16.4v-10a2 2 0 0 1 2-2h5.6a2 2 0 0 1 2 2v10"/><path d="M3.4 16.4h13.2"/><path d="M6.6 7.8h6.8"/><rect x="8.3" y="7.8" width="3.4" height="2.6" rx=".6"/><path d="M10 10.4v2.4"/>`,
  queue: `<path d="M4 5.6h12"/><path d="M4 10h8.4"/><path d="M4 14.4h5"/><path d="M15.1 12.2 17.2 14.5 15.1 16.8 13 14.5z"/>`,
  slice: `<path d="M3 6.6 10 3.1l7 3.5-7 3.5z"/><path d="M3 6.6v6.8l7 3.5 7-3.5V6.6"/><path d="M10 10.1v6.8"/>`,
  calendar: `<rect x="3.4" y="4.6" width="13.2" height="12" rx="1.6"/><path d="M3.4 8.2h13.2"/><path d="M7 3.1v3M13 3.1v3"/><path d="M6.6 11.4h3M6.6 13.9h5"/>`,
  operator: `<circle cx="10" cy="6.2" r="2.6"/><path d="M4.6 16.6c0-3 2.4-5 5.4-5s5.4 2 5.4 5"/>`,
  gear: `<circle cx="10" cy="10" r="3.1"/><path d="M10 2.7v2.2M10 15.1v2.2M4.85 4.85l1.55 1.55M13.6 13.6l1.55 1.55M2.7 10h2.2M15.1 10h2.2M4.85 15.15 6.4 13.6M13.6 6.4l1.55-1.55"/>`,
  material: `<path d="M6.3 4h7.4l2.8 3.8L10 16.6 3.5 7.8z"/><path d="M3.5 7.8h13"/><path d="M10 16.6 7.3 7.8 10 4l2.7 3.8z"/>`,
  gauge: `<path d="M3.6 14.4a7.2 7.2 0 1 1 12.8 0"/><path d="M10 14.4 13.5 9.7"/><circle cx="10" cy="14.4" r="1.05" fill="currentColor" stroke="none"/>`,
  pulse: `<path d="M2.8 10h3.1l1.7-4.6 2.9 9.4 1.8-4.8h4.9"/>`,
  shield: `<path d="M10 2.9 15.5 5v4.5c0 3.5-2.3 5.9-5.5 7.1-3.2-1.2-5.5-3.6-5.5-7.1V5z"/><path d="M10 6.9v3.5"/><circle cx="10" cy="12.9" r=".85" fill="currentColor" stroke="none"/>`,
  eye: `<path d="M2.8 10C4.8 6.8 7.2 5.3 10 5.3s5.2 1.5 7.2 4.7c-2 3.2-4.4 4.7-7.2 4.7S4.8 13.2 2.8 10Z"/><circle cx="10" cy="10" r="2.1"/>`,
  feed: `<circle cx="4.6" cy="5.2" r=".9" fill="currentColor" stroke="none"/><circle cx="4.6" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="4.6" cy="14.8" r=".9" fill="currentColor" stroke="none"/><path d="M8.2 5.2h8M8.2 10h5.4M8.2 14.8h8"/>`,
  spark: `<path d="M4.5 13.7 3.4 6.2l4 2.9L10 4.6l2.6 4.5 4-2.9-1.1 7.5z"/><path d="M5.1 16.3h9.8"/>`,
  route: `<path d="M3.5 15.4C6.5 10.4 10.5 7.4 16 5.9"/><path d="M13 5.4 16 5.9l-.9 3.2"/>`,

  /* ── Навигация и раскрытие ── */
  chevronDown: `<path d="M5.8 8 10 12.2 14.2 8"/>`,
  chevronRight: `<path d="M8 5.8 12.2 10 8 14.2"/>`,
  chevronLeft: `<path d="M12 5.8 7.8 10 12 14.2"/>`,
  arrowUp: `<path d="M10 15.6V4.8"/><path d="M5.9 8.9 10 4.8l4.1 4.1"/>`,
  arrowDown: `<path d="M10 4.4v10.8"/><path d="M14.1 11.1 10 15.2l-4.1-4.1"/>`,
  arrowLeft: `<path d="M15.4 10H4.6"/><path d="M8.7 5.9 4.6 10l4.1 4.1"/>`,
  arrowRight: `<path d="M4.6 10h10.8"/><path d="M11.3 5.9 15.4 10l-4.1 4.1"/>`,
  external: `<path d="M8.4 4.6H5.4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/><path d="M11 4.6h4.4V9"/><path d="M15.4 4.6 9.6 10.4"/>`,
  more: `<circle cx="4.8" cy="10" r="1.15" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.2" cy="10" r="1.15" fill="currentColor" stroke="none"/>`,
  refresh: `<path d="M15.8 8.4A6.1 6.1 0 0 0 5 6.2"/><path d="M4.2 11.6A6.1 6.1 0 0 0 15 13.8"/><path d="M4.4 4v2.6h2.6"/><path d="M15.6 16v-2.6H13"/>`,
  plus: `<path d="M10 4.6v10.8M4.6 10h10.8"/>`,
  minus: `<path d="M4.6 10h10.8"/>`,
  pencil: `<path d="M13.4 3.9 16.1 6.6 7.2 15.5 3.8 16.2l.7-3.4z"/><path d="M11.6 5.7 14.3 8.4"/>`,
  trash: `<path d="M4.6 6.1h10.8"/><path d="M8.1 6.1V4.7a1 1 0 0 1 1-1h1.8a1 1 0 0 1 1 1v1.4"/><path d="M5.9 6.1l.7 9a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.7-9"/><path d="M8.6 9v4M11.4 9v4"/>`,
  search: `<circle cx="8.9" cy="8.9" r="4.7"/><path d="M12.4 12.4 16.2 16.2"/>`,
  clock: `<circle cx="10" cy="10" r="6.6"/><path d="M10 6.2V10l2.6 1.6"/>`,
  lock: `<rect x="4.7" y="8.6" width="10.6" height="7.4" rx="1.5"/><path d="M7.2 8.6V6.9a2.8 2.8 0 0 1 5.6 0v1.7"/>`,
  link: `<path d="M8.4 11.6a2.8 2.8 0 0 0 4 0l2.2-2.2a2.8 2.8 0 0 0-4-4l-.9.9"/><path d="M11.6 8.4a2.8 2.8 0 0 0-4 0l-2.2 2.2a2.8 2.8 0 0 0 4 4l.9-.9"/>`,

  /* ── Атмосфера ── */
  feather: `<path d="M15.4 4C10.6 6.4 7 11 5.2 19c4.6-1.3 8.1-5 9.8-10.9z" fill="currentColor" fill-opacity=".22"/><path d="M5.2 19C8.6 12.9 12 8.1 15.4 4"/><path d="M9.2 9.2 12 9.8M7.7 12.3l2.9.6"/>`,
  crown: `<path d="M3.6 14.2 4.9 6l3.3 3.3L10 4.9l1.8 4.4L15.1 6l1.3 8.2z"/><path d="M4.4 16.4h11.2"/>`,
  wing: `<path d="M3.4 5.6c5.4.3 9.5 3.2 12.4 8.8"/><path d="M4.6 9.1c3.7.3 6.6 2.2 8.8 5.8"/><path d="M6.5 12.6c2.2.3 4 1.4 5.4 3.4"/>`,
};

/** Значки-заглушки для неизвестного имени: лучше ромб, чем пустое место. */
const FALLBACK = "sigil";

export const ICON_NAMES = Object.keys(P);

/**
 * Inline-SVG значок.
 *
 * @param {string} name  имя из набора выше
 * @param {{size?:number, cls?:string, title?:string}} opts
 *   `size`  — сторона в px (по умолчанию наследует размер из CSS-класса);
 *   `cls`   — дополнительный класс (например `ico-lg`);
 *   `title` — доступное имя. Без него значок скрыт от скринридера
 *             (`aria-hidden`) — это верно для подавляющего большинства мест,
 *             где рядом уже есть текст.
 */
export function icon(name, { size, cls = "", title = "" } = {}) {
  const body = P[name] || P[FALLBACK];
  const klass = cls ? `ico ${cls}` : "ico";
  const dim = size ? ` width="${size}" height="${size}"` : "";
  const a11y = title
    ? ` role="img" aria-label="${escAttr(title)}"`
    : ' aria-hidden="true" focusable="false"';
  return `<svg class="${klass}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${dim}${a11y}>${body}</svg>`;
}

/** Крутящийся индикатор ожидания для кнопок и панелей (`.is-busy`). */
export function spinner(cls = "") {
  return `<svg class="ico spin ${cls}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="6.6" opacity=".25"/><path d="M16.6 10a6.6 6.6 0 0 0-6.6-6.6"/></svg>`;
}

function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
