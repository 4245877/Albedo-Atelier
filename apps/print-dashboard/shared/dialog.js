/* ── Диалоговый слой: ловушка фокуса и подтверждение действия ────
   Два примитива, которых доске не хватало:

   1. `createFocusTrap` — пока открыто модальное окно, Tab не имеет права
      уводить в доску за скрымом, Esc обязан закрывать, а после закрытия фокус
      обязан вернуться туда, откуда окно открыли. Фон помечается `inert`, если
      движок это умеет, — тогда содержимое за скрымом недоступно ни клавиатуре,
      ни скринридеру.

   2. `confirmAction` — собственное подтверждение вместо `window.confirm()`.
      Системный диалог не умеет ничего из того, что здесь обязательно:
      он безымянный («OK / Cancel»), не называет объект, не показывает
      последствий, не отличает необратимое от рядового, не знает облика зала
      и на телефоне выглядит уведомлением браузера, а не решением оператора.

      Для по-настоящему необратимого можно потребовать ввести имя объекта
      (`requireText`) — тогда «Удалить» перестаёт быть случайным движением. */

import { esc } from "../util.js";
import { icon, spinner } from "./icons.js";

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])"
].join(",");

/**
 * Держит фокус внутри `container`, помечает остальную страницу `inert`,
 * возвращает фокус на `returnTo` при освобождении.
 */
export function createFocusTrap(container, { returnTo = null, onEscape = null } = {}) {
  const previous = returnTo || document.activeElement;
  const siblings = [...document.body.children].filter((el) => el !== container && !el.contains(container));
  const inerted = [];
  for (const el of siblings) {
    if (!el.hasAttribute("inert")) {
      el.setAttribute("inert", "");
      inerted.push(el);
    }
  }

  function focusables() {
    return [...container.querySelectorAll(FOCUSABLE)].filter(
      (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement
    );
  }

  function onKeydown(e) {
    if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (!items.length) {
      e.preventDefault();
      container.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("keydown", onKeydown, true);

  /** Перевести фокус на первый осмысленный элемент окна. */
  function focusFirst() {
    const preferred = container.querySelector("[data-autofocus]");
    const target = preferred || focusables()[0] || container;
    target.focus();
  }

  return {
    focusFirst,
    release() {
      document.removeEventListener("keydown", onKeydown, true);
      for (const el of inerted) el.removeAttribute("inert");
      // Фокус возвращается на кнопку, которой окно открыли: иначе после Esc он
      // падал в начало документа, и клавиатурный обход начинался заново.
      if (previous && previous.isConnected && typeof previous.focus === "function") {
        previous.focus();
      }
    }
  };
}

/* ── Подтверждение опасного действия ───────────────────────── */

let confirmRoot = null;

function ensureConfirmRoot() {
  if (confirmRoot) return confirmRoot;
  confirmRoot = document.createElement("div");
  confirmRoot.className = "modal-backdrop confirm-backdrop";
  confirmRoot.hidden = true;
  document.body.appendChild(confirmRoot);
  return confirmRoot;
}

/**
 * Показывает окно подтверждения и разрешается в true/false.
 *
 * @param {object} o
 * @param {string} o.title        что произойдёт: «Удалить принтер»
 * @param {string} o.object       над чем: «Creality K2 Plus»
 * @param {string} [o.body]       последствия, обычным текстом
 * @param {string[]} [o.points]   перечень последствий
 * @param {string} [o.cta]        подпись подтверждающей кнопки
 * @param {"danger"|"warn"} [o.tone]
 * @param {boolean} [o.irreversible] пометить действие необратимым
 * @param {string} [o.requireText]  требовать ввод этой строки (обычно имя объекта)
 * @param {() => Promise<any>} [o.run] действие; окно держит состояние «выполняю…»
 *        и закрывается только после ответа. Без него окно просто возвращает true.
 */
export function confirmAction({
  title,
  object = "",
  body = "",
  points = [],
  cta = "Подтвердить",
  tone = "danger",
  irreversible = false,
  requireText = null,
  run = null
} = {}) {
  const root = ensureConfirmRoot();
  const opener = document.activeElement;

  return new Promise((resolve) => {
    const needsText = Boolean(requireText);
    root.innerHTML = `
      <div class="modal modal-confirm tone-${esc(tone)}" role="alertdialog" aria-modal="true"
        aria-labelledby="confirm-title" aria-describedby="confirm-body" tabindex="-1">
        <div class="confirm-head">
          <span class="confirm-mark" aria-hidden="true">${icon(tone === "danger" ? "warn" : "info", { cls: "ico-lg" })}</span>
          <div>
            <h2 id="confirm-title">${esc(title)}</h2>
            ${object ? `<p class="confirm-object">${esc(object)}</p>` : ""}
          </div>
        </div>
        <div class="confirm-body" id="confirm-body">
          ${body ? `<p>${esc(body)}</p>` : ""}
          ${points.length ? `<ul class="confirm-points">${points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
          ${irreversible ? `<p class="confirm-irreversible">${icon("blocked")}<span>Действие необратимо — отменить его я не смогу.</span></p>` : ""}
        </div>
        ${needsText ? `
          <label class="field confirm-verify">
            <span class="field-lbl">Для подтверждения введите <b>${esc(requireText)}</b></span>
            <input class="input f-m" id="confirm-text" autocomplete="off" spellcheck="false"
              aria-describedby="confirm-verify-hint" />
            <span class="field-hint" id="confirm-verify-hint">Точное совпадение, чтобы это не могло произойти случайно.</span>
          </label>` : ""}
        <div class="modal-actions">
          <button type="button" class="btn" data-confirm-no ${needsText ? "" : "data-autofocus"}>Отмена</button>
          <button type="button" class="btn btn-${tone === "danger" ? "danger-solid" : "primary"}"
            data-confirm-yes ${needsText ? "disabled" : "data-autofocus"}>${esc(cta)}</button>
        </div>
      </div>`;

    root.hidden = false;
    document.documentElement.classList.add("modal-open");
    const dialog = root.querySelector(".modal-confirm");
    const yes = root.querySelector("[data-confirm-yes]");
    const no = root.querySelector("[data-confirm-no]");
    const field = root.querySelector("#confirm-text");

    const trap = createFocusTrap(root, { returnTo: opener, onEscape: () => finish(false) });
    trap.focusFirst();

    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      root.hidden = true;
      root.innerHTML = "";
      document.documentElement.classList.remove("modal-open");
      trap.release();
      resolve(value);
    }

    if (field) {
      field.addEventListener("input", () => {
        yes.disabled = field.value.trim() !== requireText;
      });
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !yes.disabled) { e.preventDefault(); yes.click(); }
      });
    }

    no.addEventListener("click", () => finish(false));
    root.addEventListener("click", (e) => { if (e.target === root) finish(false); });

    yes.addEventListener("click", async () => {
      if (yes.disabled) return;
      if (!run) { finish(true); return; }
      // Действие выполняется, не закрывая окна: оператор видит, что приказ
      // принят, и не жмёт кнопку второй раз.
      yes.disabled = true;
      no.disabled = true;
      if (field) field.disabled = true;
      dialog.classList.add("is-busy");
      const label = yes.textContent;
      yes.innerHTML = `${spinner()}<span>Исполняю…</span>`;
      try {
        await run();
        finish(true);
      } catch (err) {
        dialog.classList.remove("is-busy");
        yes.disabled = false;
        no.disabled = false;
        if (field) field.disabled = false;
        yes.textContent = label;
        let box = dialog.querySelector(".form-error");
        if (!box) {
          box = document.createElement("div");
          box.className = "form-error";
          box.setAttribute("role", "alert");
          dialog.querySelector(".modal-actions").before(box);
        }
        box.textContent = `Не исполнено: ${err?.message || "причина неизвестна"}`;
      }
    });
  });
}
