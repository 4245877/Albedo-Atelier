/* ── Меню «ещё» (⋯) ──────────────────────────────────────────────
   Разрушающие и редкие действия живут здесь, а не в общем ряду кнопок:
   «Отменить печать» не должна стоять в пикселе от «Сделать снимок».

   Меню полностью доступно с клавиатуры (роль menu/menuitem, стрелки, Home/End,
   Escape с возвратом фокуса на кнопку) и закрывается по клику вне себя.

   Важное следствие для доски: пока меню открыто, перерисовывать карточки
   нельзя — очередной тик опроса (раз в 6 с) снёс бы открытое меню прямо
   из-под курсора. Поэтому модуль отдаёт `isMenuOpen()`, и renderAll() его
   спрашивает. */

import { API_BASE } from "../api.js";
import { esc } from "../util.js";
import { icon } from "./icons.js";

let openHost = null;

/** Открыто ли сейчас хоть одно меню (доска на это время не пересобирается). */
export function isMenuOpen() {
  return Boolean(openHost && openHost.isConnected);
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

function items(host) {
  return [...host.querySelectorAll('.menu-item:not([disabled])')];
}

function close(host, { focusToggle = false } = {}) {
  if (!host) return;
  const panel = host.querySelector(".menu");
  const toggle = host.querySelector("[data-menu-toggle]");
  if (panel) panel.hidden = true;
  if (toggle) toggle.setAttribute("aria-expanded", "false");
  host.removeAttribute("data-open");
  if (openHost === host) openHost = null;
  if (focusToggle && toggle) toggle.focus();
}

function open(host) {
  if (openHost && openHost !== host) close(openHost);
  const panel = host.querySelector(".menu");
  const toggle = host.querySelector("[data-menu-toggle]");
  if (!panel) return;
  panel.hidden = false;
  host.setAttribute("data-open", "1");
  if (toggle) toggle.setAttribute("aria-expanded", "true");
  openHost = host;

  // Меню, упирающееся в правый край окна, раскрывается влево; упирающееся
  // в низ — вверх. Считаем после показа, по фактическим размерам.
  panel.classList.remove("to-left", "to-top");
  const r = panel.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) panel.classList.add("to-left");
  if (r.bottom > window.innerHeight - 8 && r.height < window.innerHeight - 24) panel.classList.add("to-top");
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
      close(item.closest("[data-menu-host]"));
      return;
    }
    if (openHost) close(openHost);
  });

  document.addEventListener("keydown", (e) => {
    if (!openHost) {
      // Стрелка вниз на самой кнопке открывает меню и встаёт на первый пункт.
      const toggle = e.target.closest?.("[data-menu-toggle]");
      if (toggle && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const host = toggle.closest("[data-menu-host]");
          open(host);
          items(host)[0]?.focus();
        }
      }
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
      close(openHost);
    }
  });

  // Прокрутка страницы уводит меню от своей кнопки — закрываем.
  window.addEventListener("scroll", () => { if (openHost) close(openHost); }, { passive: true, capture: true });
}
