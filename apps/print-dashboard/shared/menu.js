/* ── Меню «ещё» (⋯) ──────────────────────────────────────────────
   Разрушающие и редкие действия живут здесь, а не в общем ряду кнопок:
   «Отменить печать» не должна стоять в пикселе от «Сделать снимок».

   Меню полностью доступно с клавиатуры (роль menu/menuitem, стрелки, Home/End,
   Escape с возвратом фокуса на кнопку) и закрывается по клику вне себя.

   ПОЧЕМУ ПАНЕЛЬ НА ВРЕМЯ ПОКАЗА ЖИВЁТ В <body>. Пока она была
   `position: absolute` внутри карточки, её резала сама карточка:
   `.printer-card` объявлена `overflow: hidden` (иначе кадр камеры вылезал бы
   из скруглённого угла), а кнопка «⋯» стоит в самом низу карточки — меню
   раскрывалось ровно за её нижнюю границу и обрезалось по ней. Вторая
   половина той же беды: при наведении карточка получает `transform`, то есть
   собственный стековый контекст, и `z-index` панели переставал что-либо
   значить относительно соседних карточек. Ни то, ни другое не лечится
   правкой z-index: обрезает ПРЕДОК, а не порядок слоёв.

   Поэтому открытая панель переезжает в <body>, встаёт `position: fixed` и
   позиционируется от прямоугольника кнопки: выбираем сторону раскрытия,
   прижимаемся к краям экрана и, если места не хватает нигде, отдаём панели
   собственную прокрутку вместо ухода за край. Геометрия вынесена в чистую
   placeMenu() — она проверяется тестами без браузера.

   Важное следствие для доски: пока меню открыто, перерисовывать карточки
   нельзя — очередной тик опроса (раз в 6 с) снёс бы открытое меню прямо
   из-под курсора. Поэтому модуль отдаёт `isMenuOpen()`, и renderAll() его
   спрашивает. */

import { API_BASE } from "../api.js";
import { esc } from "../util.js";
import { icon } from "./icons.js";

/** Зазор между кнопкой и панелью. */
const GAP = 6;
/** Неприкосновенная кромка экрана: к самому краю меню не прижимается. */
const EDGE = 8;

let openHost = null;   // .menu-host открытого меню (кнопка остаётся в нём)
let openPanel = null;  // его панель — на время показа она в <body>
let openSize = null;   // естественный размер панели, измеренный при открытии

/** Открыто ли сейчас хоть одно меню (доска на это время не пересобирается). */
export function isMenuOpen() {
  // Хост мог исчезнуть с перерисовкой раздела. Тогда меню не «открыто», а
  // портал обязан быть убран: иначе панель осталась бы висеть в <body>
  // сиротой — без кнопки, но поверх страницы.
  if (openHost && !openHost.isConnected) close(openHost);
  return Boolean(openHost);
}

/**
 * Элемент, по которому следует проверять принадлежность разделу. Пункты
 * открытого меню физически лежат в <body>, поэтому `section.contains(item)`
 * их не находит; для них отвечаем кнопкой-владельцем, оставшейся в разметке
 * раздела (см. features/printers/controller.js).
 */
export function menuOwner(el) {
  return openPanel && el && openPanel.contains(el) ? openHost : el;
}

/**
 * Разметка меню действий.
 * @param {Array<{act,label,icon,disabled,reason,danger,href,external,absolute}>} items
 * @param {{id: string, label?: string, dataId?: string, attr?: string}} o
 *   `attr` — имя data-атрибута действия. По умолчанию `data-act` (общий
 *   обработчик доски); разделы «Работ» со своим делегатом передают свой,
 *   иначе их пункты перехватывал бы чужой обработчик.
 */
export function menuHtml(items, { id, label = "Ещё действия", dataId = "", attr = "data-act" } = {}) {
  if (!items.length) return "";
  const idAttr = dataId ? ` data-id="${esc(dataId)}"` : "";
  const rows = items.map((it) => {
    const cls = `menu-item${it.danger ? " menu-item-danger" : ""}${it.disabled ? " is-disabled" : ""}`;
    const body = `<span class="menu-ico">${icon(it.icon || "sigil")}</span>
      <span class="menu-label">${esc(it.label)}</span>
      ${it.reason ? `<span class="menu-reason">${esc(it.reason)}</span>` : ""}`;
    if (it.href && !it.disabled) {
      const href = it.absolute ? esc(it.href) : `${API_BASE}${esc(it.href)}`;
      return `<a class="${cls}" role="menuitem" tabindex="-1" href="${href}" target="_blank" rel="noopener">${body}</a>`;
    }
    // Недоступный пункт остаётся в списке и НАЗЫВАЕТ причину: иначе действие
    // просто исчезало бы, и оператор не понимал, почему его нет.
    return `<button type="button" class="${cls}" role="menuitem" tabindex="-1"
      ${esc(attr)}="${esc(it.act)}"${idAttr} ${it.disabled ? 'disabled aria-disabled="true"' : ""}>${body}</button>`;
  }).join("");

  return `
    <div class="menu-host" data-menu-host>
      <button type="button" class="btn btn-sm btn-icon" data-menu-toggle
        aria-haspopup="menu" aria-expanded="false" aria-controls="menu-${esc(id)}"
        aria-label="${esc(label)}" title="${esc(label)}">${icon("more")}</button>
      <div class="menu" id="menu-${esc(id)}" role="menu" aria-label="${esc(label)}" hidden>${rows}</div>
    </div>`;
}

/* ── Геометрия раскрытия ───────────────────────────────────────
   Чистая функция: никакого DOM, только числа. Здесь же лежат все крайние
   случаи (карточка у края экрана, узкий вьюпорт, длинный список пунктов),
   поэтому они проверяются тестами, а не глазами в браузере. */

/**
 * Куда поставить панель меню.
 * @param {{left:number,right:number,top:number,bottom:number}} anchor кнопка «⋯», координаты вьюпорта
 * @param {{width:number,height:number}} panel естественный размер панели
 * @param {{width:number,height:number}} view видимая область без полос прокрутки
 * @returns {{left:number, top:number, maxHeight:number, side:"down"|"up"}}
 *   `maxHeight` — предел, за которым панель прокручивается сама.
 */
export function placeMenu(anchor, panel, view, { gap = GAP, edge = EDGE } = {}) {
  const below = Math.max(0, view.height - edge - (anchor.bottom + gap));
  const above = Math.max(0, anchor.top - gap - edge);
  // Вниз — пока панель туда помещается целиком; не помещается — вверх; не
  // помещается нигде (низкий вьюпорт, длинный список) — сторона с бОльшим
  // запасом, и панель получает предел высоты со своей прокруткой.
  const side = panel.height <= below || (panel.height > above && below >= above) ? "down" : "up";
  // Запас никогда не больше самого экрана: кнопку могло увезти прокруткой за
  // его край, и «свободная высота» вышла бы фиктивной.
  const room = Math.max(0, Math.min(side === "down" ? below : above, view.height - 2 * edge));
  const height = Math.min(panel.height, room);
  let top = side === "down" ? anchor.bottom + gap : anchor.top - gap - height;
  top = Math.min(Math.max(top, edge), Math.max(edge, view.height - edge - height));

  // Кнопка «⋯» стоит последней в своём ряду, поэтому панель прижата к её
  // правому краю. У левой кромки экрана (узкий вьюпорт, карточка у края)
  // разворачиваем в другую сторону — от левого края кнопки.
  let left = anchor.right - panel.width;
  if (left < edge) left = anchor.left;
  // И в любом случае панель остаётся внутри экрана: она шире свободного
  // места — прижимаем к левой кромке, но за правую не выпускаем.
  left = Math.min(Math.max(left, edge), Math.max(edge, view.width - edge - panel.width));

  return { left, top, maxHeight: room, side };
}

/* ── Показ и скрытие ───────────────────────────────────────── */

/** Панель меню, к которому относится элемент (учитывая портал в <body>). */
function panelOf(host) {
  return host === openHost && openPanel ? openPanel : host.querySelector(".menu");
}

/** Хост меню по любому его элементу — в том числе по пункту, живущему в <body>. */
function hostOf(el) {
  if (openPanel && openPanel.contains(el)) return openHost;
  return el.closest("[data-menu-host]");
}

function items(host) {
  const panel = panelOf(host);
  return panel ? [...panel.querySelectorAll(".menu-item:not([disabled])")] : [];
}

/** Пересчёт позиции открытой панели по текущему положению кнопки. */
function reposition() {
  if (!openHost || !openPanel || !openSize) return;
  if (!openHost.isConnected) { close(openHost); return; }
  const toggle = openHost.querySelector("[data-menu-toggle]");
  if (!toggle) { close(openHost); return; }

  const a = toggle.getBoundingClientRect();
  const view = {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight
  };
  // Кнопку увезло прокруткой за пределы экрана — держать меню больше не за
  // что: панель висела бы посреди страницы сама по себе.
  if (a.bottom <= 0 || a.top >= view.height || a.right <= 0 || a.left >= view.width) {
    close(openHost);
    return;
  }

  const p = placeMenu(a, openSize, view);
  openPanel.style.left = `${p.left}px`;
  openPanel.style.top = `${p.top}px`;
  openPanel.style.maxHeight = `${p.maxHeight}px`;
  openPanel.dataset.side = p.side;
}

function close(host, { focusToggle = false } = {}) {
  if (!host) return;
  const panel = panelOf(host);
  const toggle = host.querySelector("[data-menu-toggle]");
  if (panel) {
    panel.hidden = true;
    panel.style.cssText = "";
    delete panel.dataset.side;
    // Панель возвращается в свою карточку: разметка снова целая, и следующая
    // перерисовка уносит её вместе с хостом, не оставляя сироты в <body>.
    if (host.isConnected) host.appendChild(panel);
    else panel.remove();
  }
  if (toggle) toggle.setAttribute("aria-expanded", "false");
  host.removeAttribute("data-open");
  if (openHost === host) { openHost = null; openPanel = null; openSize = null; }
  if (focusToggle && toggle) toggle.focus();
}

function open(host) {
  if (openHost && openHost !== host) close(openHost);
  const panel = host.querySelector(".menu");
  const toggle = host.querySelector("[data-menu-toggle]");
  if (!panel) return;

  document.body.appendChild(panel);
  panel.hidden = false;
  host.setAttribute("data-open", "1");
  if (toggle) toggle.setAttribute("aria-expanded", "true");
  openHost = host;
  openPanel = panel;

  // Естественный размер меряем ОДИН раз, при открытии: дальше панель только
  // переставляется. Повторный замер требовал бы снимать max-height, а это
  // сбрасывало бы собственную прокрутку панели прямо под пальцем.
  panel.style.left = "0px";
  panel.style.top = "0px";
  panel.style.maxHeight = "";
  const box = panel.getBoundingClientRect();
  openSize = { width: box.width, height: box.height };
  reposition();

  // Появившаяся полоса прокрутки могла расширить панель — уточняем ширину,
  // иначе прижатая к правому краю панель вылезла бы за него на её толщину.
  const shown = panel.getBoundingClientRect();
  if (shown.width > openSize.width + 0.5) {
    openSize.width = shown.width;
    reposition();
  }
}

/** Один делегированный обработчик на весь документ — меню живут в перерисовываемой разметке. */
export function installMenus() {
  document.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-menu-toggle]");
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      const host = toggle.closest("[data-menu-host]");
      if (host === openHost) close(host);
      else open(host);
      return;
    }
    const item = e.target.closest(".menu-item");
    if (item) {
      // Действие исполняет общий обработчик data-act; меню просто закрывается.
      close(hostOf(item));
      return;
    }
    // Клик по самой панели (её полоса прокрутки, отступы между пунктами) меню
    // не закрывает: иначе перетаскивание ползунка захлопывало бы список.
    if (openPanel && openPanel.contains(e.target)) return;
    if (openHost) close(openHost);
  });

  document.addEventListener("keydown", (e) => {
    if (!openHost) {
      // Стрелка вниз на самой кнопке открывает меню и встаёт на первый пункт;
      // стрелка вверх — на последний. Enter и пробел жмут кнопку сами.
      const toggle = e.target.closest?.("[data-menu-toggle]");
      if (!toggle || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      e.preventDefault();
      const host = toggle.closest("[data-menu-host]");
      open(host);
      const list = items(host);
      (e.key === "ArrowDown" ? list[0] : list[list.length - 1])?.focus();
      return;
    }
    const list = items(openHost);
    const i = list.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close(openHost, { focusToggle: true });
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      list[i < 0 ? 0 : (i + 1) % list.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === "Tab") {
      // Закрываем ДО того, как браузер выберет следующий элемент: панель
      // возвращается в разметку, и Tab уходит по обычному порядку страницы,
      // а не из конца <body>.
      close(openHost);
    }
  });

  // Прокрутка и смена размера окна не отрывают меню от кнопки — панель
  // переставляется (а если кнопку увезло с экрана, меню закрывается). Раньше
  // ЛЮБАЯ прокрутка в документе просто закрывала меню, включая прокрутку
  // самого списка.
  // Пересчитываем синхронно, а не через requestAnimationFrame: браузер и так
  // отдаёт scroll не чаще кадра, а лишний кадр задержки — это видимое
  // «отставание» панели от собственной кнопки.
  const track = () => { if (openHost) reposition(); };
  window.addEventListener("scroll", track, { passive: true, capture: true });
  window.addEventListener("resize", track, { passive: true });
  // Мобильный вьюпорт живёт своей жизнью: адресная строка, клавиатура, зум.
  window.visualViewport?.addEventListener("resize", track, { passive: true });
  window.visualViewport?.addEventListener("scroll", track, { passive: true });
}
