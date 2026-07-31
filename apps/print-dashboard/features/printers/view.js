/* ── Раздел «Оборудование фермы»: view ──────────────────────────
   Чистая разметка: (state) → HTML. Опросом, мутациями и состоянием владеет
   controller.js; здесь нет ни одного fetch и ни одного решения.

   Раздел существует ради одной операции, которая раньше стоила пересборки:
   принтеру сбросили код доступа — оператор вводит новый прямо здесь, и он
   действует со следующего опроса.

   Про секреты. Backend НИКОГДА не отдаёт значения: приходит только статус
   («задан», «берётся из ${VAR}», «не задан»). Поэтому поля учётных данных
   всегда пустые, а пустое поле означает «оставить как есть» — не «стереть».
   Стирание — отдельное явное действие. Так форму можно отправлять целиком,
   ни разу не получив секрет в браузер. */

import { esc } from "../../util.js";
import { chip, panel } from "../../shared/chips.js";
import { fmtDate } from "../../shared/format.js";

/* Какие учётные данные вообще осмысленны для протокола — приходит с backend
   (GET /options), здесь только запасной вариант на случай его недоступности. */
const FALLBACK_CREDENTIALS = {
  moonraker: ["apiKey"],
  bambu: ["serial", "accessCode"],
  creality: []
};

const CREDENTIAL_LABELS = {
  apiKey: "API-ключ Moonraker",
  serial: "Серийный номер",
  accessCode: "Код доступа (LAN)"
};

const CREDENTIAL_HINTS = {
  apiKey: "Нужен, только если в Moonraker включена авторизация по ключу.",
  serial: "С экрана принтера: настройки → сеть. Меняется только при замене платы.",
  accessCode: "С экрана принтера: настройки → сеть → LAN. Меняется при каждом сбросе — обновите его здесь."
};

export function errorBanner(state) {
  if (!state.error) return "";
  return `<div class="slice-panel sch-poll-error"><div class="slice-warn">⚠ Часть данных не обновилась (${esc(
    state.error
  )}) — показаны последние полученные; повторю попытку автоматически.</div></div>`;
}

/* ── Список принтеров ──────────────────────────────────────── */

export function printersHtml(state) {
  const printers = state.printers || [];
  const head = `<span class="slice-hint">настройки хранятся в базе фермы · применяются без пересборки</span>`;

  if (!printers.length) {
    return panel(
      "Настроенные принтеры",
      `<div class="slice-empty">Ни один принтер не настроен. Добавьте первый — форма ниже.</div>`,
      head
    );
  }

  const rows = printers.map((printer) => printerRow(printer, state)).join("");
  const enabled = printers.filter((p) => p.enabled).length;
  const summary = [
    chip(`${printers.length} в конфигурации`, "info"),
    chip(`${enabled} в работе`, enabled ? "ok" : "warn")
  ].join("");

  return panel("Настроенные принтеры", `<div class="sch-tags">${summary}</div>${rows}`, head);
}

function printerRow(printer, state) {
  const test = state.tests?.[printer.id];
  const busy = state.busy?.[printer.id];

  const facts = [
    chip(esc(printer.protocol), "info"),
    chip(esc(hostLabel(printer)), "info"),
    printer.enabled ? chip("в работе", "ok") : chip("отключён", "warn"),
    ...credentialChips(printer, state),
    testChip(test, busy)
  ]
    .filter(Boolean)
    .join("");

  return `
    <div class="prn-row" data-printer="${esc(printer.id)}">
      <div class="prn-head">
        <div class="prn-title">
          <b>${esc(printer.name)}</b>
          <code>${esc(printer.id)}</code>
        </div>
        <div class="prn-actions">
          <button type="button" class="btn btn-sm" data-prn-action="test" data-id="${esc(printer.id)}"
            ${busy === "test" ? "disabled" : ""}>
            ${busy === "test" ? "Проверяю…" : "Проверить связь"}
          </button>
          <button type="button" class="btn btn-sm" data-prn-action="toggle" data-id="${esc(printer.id)}"
            data-enabled="${printer.enabled ? "1" : "0"}" ${busy === "toggle" ? "disabled" : ""}>
            ${printer.enabled ? "Отключить" : "Включить"}
          </button>
          <button type="button" class="btn btn-sm btn-danger" data-prn-action="remove" data-id="${esc(printer.id)}"
            ${busy === "remove" ? "disabled" : ""}>Удалить</button>
        </div>
      </div>
      <div class="sch-tags">${facts}</div>
      ${testDetail(test)}
      <details class="ops-details prn-details">
        <summary>Настройки и учётные данные</summary>
        ${printerForm(printer, state)}
      </details>
    </div>`;
}

function hostLabel(printer) {
  return printer.port ? `${printer.host}:${printer.port}` : printer.host;
}

/* Учётные данные показываются статусом, а не значением: «задан», «из ${VAR}»
   или «не задан». Неразрешённая ${VAR} — отдельный, чинимый факт: принтер
   выглядел бы просто «offline», не объясняя почему. */
function credentialChips(printer, state) {
  const fields = credentialFields(printer, state);
  return fields.map((field) => {
    const status = printer.secrets?.[field];
    const label = CREDENTIAL_LABELS[field] || field;
    if (!status?.set) return chip(`${esc(label)}: не задан`, "error");
    if (status.source === "env") {
      return status.resolved
        ? chip(`${esc(label)}: из \${${esc(status.envVar)}}`, "info")
        : chip(`${esc(label)}: \${${esc(status.envVar)}} не задана`, "error");
    }
    return chip(`${esc(label)}: задан`, "ok");
  });
}

function credentialFields(printer, state) {
  const fromBackend = (state.options?.protocols || []).find((p) => p.id === printer.protocol);
  return fromBackend?.credentials || FALLBACK_CREDENTIALS[printer.protocol] || [];
}

function testChip(test, busy) {
  if (busy === "test") return chip("проверяю связь…", "info", true);
  if (!test) return "";
  return test.online
    ? chip(`связь есть · ${esc(test.status)}`, "ok")
    : chip("связи нет", "error");
}

function testDetail(test) {
  if (!test) return "";
  const when = test.checkedAt ? ` · ${esc(fmtDate(test.checkedAt))}` : "";
  if (test.online) {
    return `<div class="slice-meta">Принтер ответил: состояние «${esc(test.status)}»${when}.</div>`;
  }
  return `<div class="slice-warn">⚠ Принтер не ответил${when}${
    test.error ? `: ${esc(test.error)}` : ""
  }</div>`;
}

/* ── Форма настроек одного принтера ────────────────────────── */

function printerForm(printer, state) {
  const fields = credentialFields(printer, state);
  const bv = printer.buildVolume || {};

  return `
    <form class="slice-form prn-form" data-prn-form="edit" data-id="${esc(printer.id)}">
      <div class="slice-grid">
        ${textField("name", "Название", printer.name, { required: true })}
        ${selectField("protocol", "Протокол", printer.protocol, protocolOptions(state))}
        ${textField("host", "Адрес (IP или имя)", printer.host, { required: true })}
        ${numberField("port", "Порт", printer.port)}
        ${textField("model", "Модель", printer.model)}
        ${selectField("type", "Тип", printer.type, [
          { id: "FDM", label: "FDM" },
          { id: "Resin", label: "Фотополимер" }
        ])}
        ${textField("printerClass", "Класс совместимости", printer.printerClass, {
          placeholder: "k2",
          hint: "Ярлык взаимозаменяемых машин — цель нарезки «для класса»."
        })}
        ${textField("material", "Материал (по конфигурации)", printer.material)}
        ${numberField("nozzleDiameterMm", "Диаметр сопла, мм", printer.nozzleDiameterMm, {
          step: "0.01"
        })}
        ${textField("nozzleType", "Тип сопла", printer.nozzleType)}
        ${textField("swatch", "Цвет метки", printer.swatch, { placeholder: "#7fb3d8" })}
        ${textField("interfaceUrl", "Веб-интерфейс принтера", printer.interfaceUrl, {
          placeholder: "http://192.168.0.132:4408"
        })}
        ${textField("snapshotUrl", "URL кадра камеры", printer.snapshotUrl)}
        ${textField("streamUrl", "URL потока камеры", printer.streamUrl)}
        ${numberField("buildVolume.x", "Стол X, мм", bv.x)}
        ${numberField("buildVolume.y", "Стол Y, мм", bv.y)}
        ${numberField("buildVolume.z", "Стол Z, мм", bv.z)}
      </div>

      ${credentialsFieldset(printer, fields)}
      ${lightFieldset(printer)}

      <label class="sch-check">
        <input type="checkbox" name="allowInsecureTls" ${printer.allowInsecureTls ? "checked" : ""} />
        Разрешить TLS без проверки сертификата (Bambu LAN — только в доверенной сети)
      </label>

      <div class="sch-edit-actions">
        <button type="submit" class="btn btn-primary btn-sm" ${
          state.busy?.[printer.id] === "save" ? "disabled" : ""
        }>Сохранить</button>
        <span class="slice-hint">Применяется сразу — перезапуск и пересборка не нужны.</span>
      </div>
    </form>`;
}

/* Учётные данные: поле всегда пустое (значения backend не отдаёт), пустое =
   «оставить как есть». Стереть можно только явной галочкой — иначе обычное
   сохранение формы молча обнуляло бы код доступа. */
function credentialsFieldset(printer, fields) {
  if (!fields.length) {
    return `<fieldset class="slice-target prn-secrets">
      <legend>Учётные данные</legend>
      <div class="slice-hint">Этому протоколу учётные данные не нужны.</div>
    </fieldset>`;
  }

  const rows = fields
    .map((field) => {
      const status = printer.secrets?.[field] || {};
      const label = CREDENTIAL_LABELS[field] || field;
      const state = status.set
        ? status.source === "env"
          ? `сейчас берётся из \${${esc(status.envVar)}}${status.resolved ? "" : " — переменная не задана!"}`
          : "сейчас задан"
        : "сейчас не задан";
      return `
        <div class="prn-secret">
          <label>
            ${esc(label)}
            <input type="password" name="secret:${esc(field)}" autocomplete="new-password"
              placeholder="оставьте пустым, чтобы не менять" />
          </label>
          <div class="slice-hint">${esc(state)}. ${esc(CREDENTIAL_HINTS[field] || "")}</div>
          ${
            status.set
              ? `<label class="sch-check prn-clear">
                   <input type="checkbox" name="clear:${esc(field)}" />
                   стереть
                 </label>`
              : ""
          }
        </div>`;
    })
    .join("");

  return `<fieldset class="slice-target prn-secrets">
    <legend>Учётные данные</legend>
    ${rows}
  </fieldset>`;
}

function lightFieldset(printer) {
  const light = printer.light || {};
  const enabled = light.enabled;
  return `
    <details class="ops-details prn-light">
      <summary>Подсветка камеры</summary>
      <div class="slice-grid">
        ${selectField("light.enabled", "Управление подсветкой", enabled === null || enabled === undefined ? "" : String(enabled), [
          { id: "", label: "по умолчанию для протокола" },
          { id: "true", label: "включено" },
          { id: "false", label: "выключено" }
        ])}
        ${textField("light.pin", "Пин Moonraker", light.pin, { placeholder: "LED" })}
        ${textField("light.bambuNode", "Узел подсветки Bambu", light.bambuNode, {
          placeholder: "chamber_light"
        })}
        ${textField("light.onGcode", "G-code включения", light.onGcode)}
        ${textField("light.offGcode", "G-code выключения", light.offGcode)}
        ${textField("light.statusObject", "Объект состояния", light.statusObject)}
      </div>
      <label class="sch-check">
        <input type="checkbox" name="light.invert" ${light.invert ? "checked" : ""} />
        Пин инвертирован (светит при VALUE=0)
      </label>
    </details>`;
}

/* ── Форма добавления ──────────────────────────────────────── */

export function addFormHtml(state) {
  const protocol = state.draftProtocol || "moonraker";
  const fields = (state.options?.protocols || []).find((p) => p.id === protocol);
  const credentials = fields?.credentials || FALLBACK_CREDENTIALS[protocol] || [];
  const hint = fields?.hint || "";

  const credentialInputs = credentials
    .map(
      (field) => `
      <label>
        ${esc(CREDENTIAL_LABELS[field] || field)}
        <input type="password" name="secret:${esc(field)}" autocomplete="new-password" />
      </label>`
    )
    .join("");

  return panel(
    "Добавить принтер",
    `<form class="slice-form prn-form" data-prn-form="create">
      <div class="slice-grid">
        ${textField("id", "Идентификатор", "", {
          required: true,
          placeholder: "bambu-a1-combo",
          hint: "Латиница, цифры, дефис. Потом не меняется."
        })}
        ${textField("name", "Название", "", { required: true, placeholder: "Bambu Lab A1 Combo" })}
        ${selectField("protocol", "Протокол", protocol, protocolOptions(state), {
          extra: 'data-prn-draft-protocol="1"'
        })}
        ${textField("host", "Адрес (IP или имя)", "", { required: true, placeholder: "192.168.0.187" })}
        ${numberField("port", "Порт", "")}
        ${textField("model", "Модель", "")}
        ${credentialInputs}
      </div>
      ${hint ? `<div class="slice-hint">${esc(hint)}</div>` : ""}
      <label class="sch-check">
        <input type="checkbox" name="enabled" checked />
        Сразу включить в работу (опрос и очередь)
      </label>
      ${
        protocol === "bambu"
          ? `<label class="sch-check">
               <input type="checkbox" name="allowInsecureTls" checked />
               Разрешить TLS без проверки сертификата — Bambu LAN иначе не подключается
             </label>`
          : ""
      }
      <div class="sch-edit-actions">
        <button type="submit" class="btn btn-primary btn-sm" ${
          state.busy?.__create ? "disabled" : ""
        }>Добавить принтер</button>
        <span class="slice-hint">Незаполненный принтер можно сохранить выключенным и дополнить позже.</span>
      </div>
    </form>`
  );
}

/* ── Примитивы полей ───────────────────────────────────────── */

function protocolOptions(state) {
  const protocols = state.options?.protocols;
  if (protocols?.length) return protocols.map((p) => ({ id: p.id, label: p.label }));
  return [
    { id: "moonraker", label: "Moonraker" },
    { id: "bambu", label: "Bambu Lab" },
    { id: "creality", label: "Creality" }
  ];
}

function textField(name, label, value, opts = {}) {
  return `
    <label>
      ${esc(label)}${opts.required ? " *" : ""}
      <input type="text" name="${esc(name)}" value="${esc(value ?? "")}"
        ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ""} />
      ${opts.hint ? `<span class="slice-hint">${esc(opts.hint)}</span>` : ""}
    </label>`;
}

function numberField(name, label, value, opts = {}) {
  return `
    <label>
      ${esc(label)}
      <input type="number" name="${esc(name)}" value="${value ?? ""}"
        ${opts.step ? `step="${esc(opts.step)}"` : ""} min="0" />
    </label>`;
}

function selectField(name, label, value, options, opts = {}) {
  const items = options
    .map(
      (o) =>
        `<option value="${esc(o.id)}" ${String(o.id) === String(value ?? "") ? "selected" : ""}>${esc(
          o.label
        )}</option>`
    )
    .join("");
  return `
    <label>
      ${esc(label)}
      <select name="${esc(name)}" ${opts.extra || ""}>${items}</select>
    </label>`;
}
