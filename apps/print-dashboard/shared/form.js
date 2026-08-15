/* ── Ошибки форм: общий контракт ────────────────────────────────
   Раньше каждая форма сообщала об отказе по-своему, а общий блок ошибки в
   окне задания стоял ПОСЛЕ ряда кнопок: сообщение «задание не принято»
   появлялось ниже «Отмена / Добавить в очередь», за пределами взгляда, и
   выглядело как подпись к чему-то другому. Поле при этом никак не менялось —
   оператор не знал, что именно поправить.

   Правила, которые задаёт этот модуль:
     • общий блок ошибки стоит НАД действиями и объявлен role="alert";
     • у проблемного поля — своя строка ошибки, aria-invalid и связь через
       aria-describedby, чтобы скринридер прочитал причину вместе с полем;
     • фокус уходит на первое проблемное поле, а не остаётся на кнопке;
     • обязательные поля проверяются на blur — но только после того, как
       оператор в них уже побывал: ругаться на пустое поле, которого ещё не
       касались, значит кричать раньше, чем что-то произошло. */

import { esc } from "../util.js";
import { icon } from "./icons.js";

/** Разметка общего блока ошибки. Ставить строго ПЕРЕД `.modal-actions`. */
export function formErrorHtml(id) {
  return `<div class="form-error" id="${esc(id)}" role="alert" hidden></div>`;
}

/** Показать/скрыть общий блок ошибки формы. */
export function showFormError(box, message) {
  if (!box) return;
  if (!message) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `${icon("warn")}<span>${esc(message)}</span>`;
  box.hidden = false;
}

/** Пометить поле ошибочным: рамка, aria-invalid и своя строка причины. */
export function setFieldError(form, name, message) {
  const input = form.elements[name];
  if (!input) return;
  const field = input.closest(".field") || input.parentElement;
  const errId = `err-${name.replace(/[^a-z0-9_-]/gi, "-")}`;
  let box = field?.querySelector(`#${CSS.escape(errId)}`);

  if (!message) {
    input.removeAttribute("aria-invalid");
    field?.classList.remove("has-error");
    if (box) box.remove();
    const described = (input.getAttribute("aria-describedby") || "")
      .split(/\s+/).filter((x) => x && x !== errId).join(" ");
    if (described) input.setAttribute("aria-describedby", described);
    else input.removeAttribute("aria-describedby");
    return;
  }

  input.setAttribute("aria-invalid", "true");
  field?.classList.add("has-error");
  if (!box) {
    box = document.createElement("p");
    box.className = "field-error";
    box.id = errId;
    field?.appendChild(box);
  }
  box.textContent = message;
  const described = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
  described.add(errId);
  input.setAttribute("aria-describedby", [...described].join(" "));
}

/** Снять все пометки ошибок формы (перед новой проверкой). */
export function clearFieldErrors(form) {
  form.querySelectorAll("[aria-invalid]").forEach((el) => {
    if (el.name) setFieldError(form, el.name, null);
  });
}

/** Перевести фокус на первое поле с ошибкой. Возвращает true, если нашлось. */
export function focusFirstInvalid(form) {
  const bad = form.querySelector('[aria-invalid="true"]');
  if (!bad) return false;
  bad.focus();
  return true;
}

/**
 * Проверка на blur для обязательных полей.
 * @param {HTMLFormElement} form
 * @param {Record<string,{required?:boolean,message?:string,validate?:(v:string)=>string}>} rules
 */
export function wireBlurValidation(form, rules) {
  const touched = new Set();
  form.addEventListener("blur", (e) => {
    const el = e.target;
    if (!el.name || !rules[el.name]) return;
    touched.add(el.name);
    setFieldError(form, el.name, checkField(el, rules[el.name]));
  }, true);
  // Пока поле правят, снятая ошибка не возвращается на каждую букву —
  // подсказка исчезает, как только причина устранена.
  form.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.name || !rules[el.name] || !touched.has(el.name)) return;
    if (!checkField(el, rules[el.name])) setFieldError(form, el.name, null);
  });
}

function checkField(el, rule) {
  const value = String(el.value || "").trim();
  if (rule.required && !value) return rule.message || "Это поле обязательно";
  if (rule.validate) return rule.validate(value) || "";
  return "";
}

/**
 * Проверяет форму целиком по тем же правилам. Возвращает число ошибок и
 * расставляет пометки.
 */
export function validateForm(form, rules) {
  let bad = 0;
  for (const [name, rule] of Object.entries(rules)) {
    const el = form.elements[name];
    if (!el) continue;
    const message = checkField(el, rule);
    setFieldError(form, name, message);
    if (message) bad++;
  }
  return bad;
}
