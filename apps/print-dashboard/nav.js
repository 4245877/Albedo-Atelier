import { $ } from "./util.js";

/* ── Навигация по секциям ──────────────────────────────────── */

const NAV = [
  ["summary", "Статус"], ["queue", "Очередь"], ["night", "Ночь"], ["printers", "Принтеры"],
  ["critical", "События"], ["materials", "Материалы"], ["today", "Сегодня"], ["performance", "Показатели"],
  ["automations", "Автоматизации"], ["cameras", "Камеры"], ["maintenance", "Обслуживание"],
  ["actions", "Действия"], ["system", "Система"], ["feed", "Лента"], ["warnings", "Внимание"], ["plan", "План"],
];

export function renderNav() {
  $("#section-nav").innerHTML = NAV
    .map(([id, label]) => `<button type="button" class="nav-chip" data-goto="${id}">${label}</button>`)
    .join("");
}

/* ── Текущий раздел: подсветка активной вкладки (scroll-spy) ── */
/* Навигация показывает, где пользователь сейчас находится: вкладка раздела,
   чей заголовок пришвартован под липкой шапкой, помечается активной. Заодно
   активная вкладка подтягивается в поле зрения при горизонтальной прокрутке. */

let activeNavId = null;
let navSpyScheduled = false;

function navSections() {
  return NAV.map(([id]) => document.getElementById(id)).filter(Boolean);
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
    else break;
  }
  // У самого низа страницы последний раздел может не дотянуться до линии.
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  return atBottom ? sections[sections.length - 1].id : id;
}

function updateActiveNav() {
  const id = computeActiveNav();
  if (id && id !== activeNavId) {
    activeNavId = id;
    applyActiveNav();
  }
}

/* Края навигации затухают только там, куда ещё можно листать (см. CSS). */
function updateNavEdges() {
  const nav = $("#section-nav");
  if (!nav) return;
  const max = nav.scrollWidth - nav.clientWidth;
  nav.classList.toggle("fade-left", nav.scrollLeft > 2);
  nav.classList.toggle("fade-right", nav.scrollLeft < max - 2);
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

export function setupNav() {
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

/* ── Смещения под липкие шапку и навигацию ─────────────────── */
/* Высота шапки на мобильных зависит от переноса пилюль, поэтому меряем её
   в рантайме и отдаём в CSS-переменные — навигация липнет ровно под шапкой,
   а якорный скролл не прячет заголовки секций. */

function syncStickyOffsets() {
  const topbar = $(".topbar");
  if (!topbar) return;
  const nav = $(".section-nav");
  const topH = Math.ceil(topbar.getBoundingClientRect().height);
  const navH = nav ? Math.ceil(nav.getBoundingClientRect().height) : 0;
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
  window.addEventListener("resize", syncStickyOffsets);
  // Веб-шрифты меняют высоту бренда — пересчитываем после их загрузки.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncStickyOffsets);
}

/* ── Появление секций ──────────────────────────────────────── */

let revealed = false;

function setupReveal() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
  );
  document.querySelectorAll(".reveal").forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i * 60, 240)}ms`;
    io.observe(el);
  });
}

export function ensureReveal() {
  if (revealed) return;
  revealed = true;
  setupReveal();
}
