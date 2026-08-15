/* ── Навигация: два режима и два уровня ───────────────────────────
   Раньше доска была одной страницей из 19 секций: ~10 000 px на desktop и
   ~20 000 px (24 экрана) на телефоне, а над ними — 19 горизонтальных чипов.
   Оператор не мог ответить на простой вопрос «требуется ли моё вмешательство»,
   не пролистав всю административную часть.

   Теперь уровней три, и каждый отвечает на свой вопрос:

     1. Режим     — «что происходит сейчас?» (Зал) / «с чем я работаю?» (Работы);
     2. Раздел    — якорь внутри Зала либо вкладка внутри Работ;
     3. Подробности — карточка, окно, раскрывающаяся панель.

   В «Работах» одновременно открыт РОВНО ОДИН раздел: это не дашборд, сюда
   приходят за конкретной задачей. Он же инициализируется ЛЕНИВО — контроллер
   раздела (и его опрос) запускается при первом открытии, а не на старте
   страницы. На первой загрузке это снимает пять независимых опросов. */

import { $ } from "./util.js";
import { icon } from "./shared/icons.js";

/* Секции, для которых у backend пока нет реальных данных — read model честно
   возвращает пустые getMaintenance()/getPlan(). Пока так, секции убраны из
   навигации, scroll-spy и с доски, чтобы не вести в вечные заглушки.
   Вернуть секцию, когда появятся данные, = убрать её id из этого набора. */
const HIDDEN_SECTIONS = new Set(["maintenance", "plan"]);

export const isSectionVisible = (id) => !HIDDEN_SECTIONS.has(id);

/* Якоря Зала. Порядок обязан совпадать с порядком секций в index.html:
   scroll-spy (computeActiveNav) идёт по этому списку сверху вниз. Секции
   спутника (система, лента, быстрые действия) в списке нет намеренно: на
   широком экране они и так стоят рядом, а на телефоне лежат сразу за
   показателями — ещё три чипа стоили бы больше, чем экономили. */
const HALL_NAV = [
  ["summary", "Статус"],
  ["printers", "Принтеры"],
  ["queue", "Очередь"],
  ["night", "Ночь"],
  ["critical", "События"],
  ["warnings", "Внимание"],
  ["cameras", "Камеры"],
  ["materials", "Материалы"],
  ["today", "Показатели"],
].filter(([id]) => isSectionVisible(id));

/* Разделы Работ: подпись, значок и ключ ленивой инициализации. */
const WORK_NAV = [
  ["uploads", "Загрузка", "upload"],
  ["slicing", "Слайсинг", "slice"],
  ["scheduler", "Планировщик", "calendar"],
  ["operations", "Оператор", "operator"],
  ["hardware", "Оборудование", "gear"],
  ["automations", "Автоматизации", "sigil"],
];

const MODE_ICON = { hall: "crown", works: "slice" };
const MODE_KEY = "albedo-mode";
const WORK_KEY = "albedo-work";

let currentMode = "hall";
let currentWork = null;
let onWorkOpen = () => {};
const startedWork = new Set();

/* ── Построение разметки навигации ─────────────────────────── */

export function renderNav() {
  const nav = $("#section-nav");
  if (nav) {
    nav.innerHTML = HALL_NAV
      .map(([id, label]) => `<button type="button" class="nav-chip" data-goto="${id}">${label}</button>`)
      .join("");
  }

  const work = $("#worknav");
  if (work) {
    work.innerHTML = WORK_NAV
      .map(([id, label, ico], i) => `
        <button type="button" class="work-tab${i === 0 ? " is-active" : ""}" role="tab"
          id="worktab-${id}" aria-controls="${id}" aria-selected="${i === 0}"
          tabindex="${i === 0 ? 0 : -1}" data-work-tab="${id}">
          <span class="work-tab-ico">${icon(ico)}</span><span>${label}</span>
        </button>`)
      .join("");
  }

  for (const [mode, name] of Object.entries(MODE_ICON)) {
    const el = document.querySelector(`.mode-tab[data-mode="${mode}"] .mode-tab-ico`);
    if (el) el.innerHTML = icon(name);
  }

  // Сама разметка секций статична (index.html) — скрытые прячем целиком,
  // вместе с их якорями; .card не задаёт display, поэтому hidden работает.
  for (const id of HIDDEN_SECTIONS) {
    const section = document.getElementById(id);
    if (section) section.hidden = true;
  }
}

/* ── Режимы ────────────────────────────────────────────────── */

/** Открыть режим. `focus` — перевести фокус в панель (переход с клавиатуры). */
export function showMode(mode, { focus = false, remember = true } = {}) {
  if (mode !== "hall" && mode !== "works") mode = "hall";
  currentMode = mode;

  for (const m of ["hall", "works"]) {
    const panel = document.getElementById(`mode-${m}`);
    const tab = document.querySelector(`.mode-tab[data-mode="${m}"]`);
    const on = m === mode;
    if (panel) panel.hidden = !on;
    if (tab) {
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
  }

  // Якорная навигация Зала не имеет смысла в Работах: там свои вкладки.
  const secNav = $("#section-nav");
  if (secNav) secNav.hidden = mode !== "hall";

  if (mode === "works" && !currentWork) showWork(WORK_NAV[0][0], { remember });
  if (remember) {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* приватный режим */ }
  }
  if (focus) document.getElementById(`mode-${mode}`)?.focus();
  syncStickyOffsets();
  updateNavEdges();
  if (mode === "hall") updateActiveNav();
}

/** Открыть раздел Работ. Первое открытие поднимает его контроллер (ленивый старт). */
export function showWork(id, { focus = false, remember = true } = {}) {
  if (!WORK_NAV.some(([w]) => w === id)) id = WORK_NAV[0][0];
  currentWork = id;

  for (const [w] of WORK_NAV) {
    const panel = document.getElementById(w);
    const tab = document.querySelector(`[data-work-tab="${w}"]`);
    const on = w === id;
    if (panel) panel.hidden = !on;
    if (tab) {
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
  }

  if (!startedWork.has(id)) {
    startedWork.add(id);
    // Контроллер раздела поднимается ровно один раз и ровно тогда, когда его
    // впервые открыли: пять фоновых опросов на старте страницы не нужны никому.
    try { onWorkOpen(id); } catch (err) { console.error("work init failed", id, err); }
  }
  if (remember) {
    try { localStorage.setItem(WORK_KEY, id); } catch { /* приватный режим */ }
  }
  if (focus) document.querySelector(`[data-work-tab="${id}"]`)?.focus();
}

/**
 * Перейти к секции по её id — из любого режима. Быстрые действия и ссылки
 * внутри текста ведут в том числе в разделы Работ, поэтому переход обязан
 * сам переключить режим, а не молча проскроллить пустоту.
 */
export function gotoSection(id) {
  const workEntry = WORK_NAV.find(([w]) => w === id);
  if (workEntry) {
    showMode("works");
    showWork(id);
    document.getElementById("mode-works")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (currentMode !== "hall") showMode("hall");
  const target = document.getElementById(id);
  if (!target) return;
  setActiveNav(id);
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ── Текущий раздел: подсветка активной вкладки (scroll-spy) ── */
/* Навигация показывает, где пользователь сейчас находится: вкладка раздела,
   чей заголовок пришвартован под липкой шапкой, помечается активной. Заодно
   активная вкладка подтягивается в поле зрения при горизонтальной прокрутке. */

let activeNavId = null;
let navSpyScheduled = false;

function navSections() {
  return HALL_NAV.map(([id]) => document.getElementById(id)).filter((el) => el && !el.hidden);
}

function applyActiveNav() {
  const nav = $("#section-nav");
  if (!nav) return;
  nav.querySelectorAll(".nav-chip").forEach((chip) => {
    const on = chip.dataset.goto === activeNavId;
    chip.classList.toggle("is-active", on);
    if (on) chip.setAttribute("aria-current", "location");
    else chip.removeAttribute("aria-current");
  });
  const chip = activeNavId && nav.querySelector(`.nav-chip[data-goto="${activeNavId}"]`);
  if (chip) {
    const c = chip.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    if (c.left < n.left + 8 || c.right > n.right - 8) {
      nav.scrollTo({ left: chip.offsetLeft - (nav.clientWidth - chip.clientWidth) / 2, behavior: "smooth" });
    }
  }
}

/** Мгновенная подсветка «вы здесь» при клике по чипу; далее ведёт scroll-spy. */
export function setActiveNav(id) {
  activeNavId = id;
  applyActiveNav();
}

function computeActiveNav() {
  const sections = navSections();
  if (!sections.length) return null;
  const stackH = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--stack-h"), 10) || 130;
  const line = stackH + 20; // чуть ниже липкой навигации
  let id = sections[0].id;
  for (const sec of sections) {
    if (sec.getBoundingClientRect().top <= line) id = sec.id;
  }
  // У самого низа страницы последний раздел может не дотянуться до линии.
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  return atBottom ? sections[sections.length - 1].id : id;
}

function updateActiveNav() {
  if (currentMode !== "hall") return;
  const id = computeActiveNav();
  if (id && id !== activeNavId) {
    activeNavId = id;
    applyActiveNav();
  }
}

/* Края навигации затухают только там, куда ещё можно листать (см. CSS). */
function updateNavEdges() {
  for (const sel of ["#section-nav", "#worknav"]) {
    const nav = $(sel);
    if (!nav || nav.hidden) continue;
    const max = nav.scrollWidth - nav.clientWidth;
    nav.classList.toggle("fade-left", nav.scrollLeft > 2);
    nav.classList.toggle("fade-right", nav.scrollLeft < max - 2);
  }
}

function onPageScroll() {
  document.documentElement.classList.toggle("scrolled", window.scrollY > 6);
  if (navSpyScheduled) return;
  navSpyScheduled = true;
  requestAnimationFrame(() => {
    navSpyScheduled = false;
    updateActiveNav();
  });
}

/* Стрелки внутри группы вкладок — требование роли tablist: Tab выводит из
   группы целиком, а внутри неё перемещаются стрелками, Home/End — к краям. */
function wireTablist(container, selector, activate) {
  container.addEventListener("keydown", (e) => {
    const tabs = [...container.querySelectorAll(selector)].filter((t) => !t.disabled);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    activate(tabs[next]);
  });
}

export function setupNav({ onWorkOpen: cb } = {}) {
  if (cb) onWorkOpen = cb;

  const modebar = $("#modebar");
  if (modebar) {
    modebar.addEventListener("click", (e) => {
      const tab = e.target.closest(".mode-tab");
      if (!tab) return;
      showMode(tab.dataset.mode, { focus: false });
    });
    const switcher = modebar.querySelector(".modeswitch");
    if (switcher) {
      wireTablist(switcher, ".mode-tab", (t) => showMode(t.dataset.mode, { focus: true }));
    }
  }

  const work = $("#worknav");
  if (work) {
    work.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-work-tab]");
      if (!tab) return;
      showWork(tab.dataset.workTab);
    });
    wireTablist(work, "[data-work-tab]", (t) => showWork(t.dataset.workTab, { focus: true }));
    work.addEventListener("scroll", () => requestAnimationFrame(updateNavEdges), { passive: true });
  }

  document.documentElement.classList.toggle("scrolled", window.scrollY > 6);
  updateNavEdges();
  updateActiveNav();
  window.addEventListener("scroll", onPageScroll, { passive: true });
  window.addEventListener("resize", () => { updateNavEdges(); updateActiveNav(); });
  const nav = $("#section-nav");
  if (nav) nav.addEventListener("scroll", () => requestAnimationFrame(updateNavEdges), { passive: true });
  // Веб-шрифты меняют высоту стопки и ширину вкладок — пересчитываем после загрузки.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { updateNavEdges(); updateActiveNav(); });
  }
}

/** Восстановить режим прошлого визита: возврат на панель не должен сбрасывать место. */
export function restoreMode() {
  let mode = "hall";
  let work = null;
  try {
    mode = localStorage.getItem(MODE_KEY) || "hall";
    work = localStorage.getItem(WORK_KEY);
  } catch { /* приватный режим */ }
  if (work) currentWork = null;
  showMode(mode, { remember: false });
  if (mode === "works" && work) showWork(work, { remember: false });
}

/* ── Смещения под липкие шапку и навигацию ─────────────────── */
/* Высота шапки на мобильных зависит от переноса пилюль, поэтому меряем её
   в рантайме и отдаём в CSS-переменные — навигация липнет ровно под шапкой,
   а якорный скролл не прячет заголовки секций. */

function syncStickyOffsets() {
  const topbar = $(".topbar");
  if (!topbar) return;
  const bar = $("#modebar");
  /* На телефоне шапка не липкая (см. styles/dashboard.css): она уезжает вверх,
     и под навигацию резервировать её высоту нельзя — иначе вкладки повисли бы
     на 160 px ниже верха экрана, а якорный скролл оставлял бы такую же дыру
     над заголовком секции. Спрашиваем у стилей, а не у ширины окна: порог
     живёт в одном месте — в media-запросе. */
  const topSticky = getComputedStyle(topbar).position === "sticky";
  const topH = topSticky ? Math.ceil(topbar.getBoundingClientRect().height) : 0;
  const navH = bar ? Math.ceil(bar.getBoundingClientRect().height) : 0;
  const root = document.documentElement.style;
  root.setProperty("--topbar-h", `${topH}px`);
  root.setProperty("--stack-h", `${topH + navH + 12}px`);
}

export function setupStickyOffsets() {
  syncStickyOffsets();
  const topbar = $(".topbar");
  if (topbar && "ResizeObserver" in window) {
    new ResizeObserver(syncStickyOffsets).observe(topbar);
  }
  const bar = $("#modebar");
  if (bar && "ResizeObserver" in window) {
    new ResizeObserver(syncStickyOffsets).observe(bar);
  }
  window.addEventListener("resize", syncStickyOffsets);
  // Веб-шрифты меняют высоту бренда — пересчитываем после их загрузки.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncStickyOffsets);
}

/* ── Появление секций ──────────────────────────────────────── */
/* Появление — украшение, а не условие показа. Секции первого экрана класса
   .reveal не несут вовсе; для остальных пред-скрытие включает только класс
   `has-js` (ставится синхронно в <head>), а страховочный `reveal-all` через
   1.2 с показывает всё, даже если наблюдатель не отработал. */

let revealed = false;

function setupReveal() {
  const targets = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      }
    },
    { rootMargin: "0px 0px -6% 0px", threshold: 0.02 }
  );
  targets.forEach((el, i) => {
    // Каскад задержек короткий: это подача, а не ожидание.
    el.style.transitionDelay = `${Math.min(i * 40, 160)}ms`;
    io.observe(el);
  });
}

export function ensureReveal() {
  if (revealed) return;
  revealed = true;
  setupReveal();
}
