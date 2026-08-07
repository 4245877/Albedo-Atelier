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
   ни разу не получив секрет в браузер.

   Про характеристики. Backend присылает `specs`: по каждой характеристике —
   действующее значение и ИСТОЧНИК («с принтера», «по модели», «вручную»,
   «неизвестно»). Правило приоритета живёт на backend, здесь его нет; задача
   разметки — показать источник рядом со значением и не дать автоматически
   полученному выглядеть так же, как введённому руками. Поле формы при этом
   остаётся пустым: пустое поле означает «беру с принтера», а не «нет данных». */

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

/* Как называется источник значения. Слова те же, что в live-карточке принтера:
   одна характеристика не должна описываться в двух разделах по-разному. */
const SOURCE_LABELS = {
  printer: "с принтера",
  catalog: "по модели",
  manual: "вручную",
  unknown: "неизвестно"
};

/** Бейдж источника рядом со значением — главное визуальное различие раздела. */
function sourceBadge(spec) {
  const source = spec?.source || "unknown";
  const title = spec?.via ? ` title="${esc(spec.via)}"` : "";
  return `<span class="prn-source prn-source--${esc(source)}"${title}>${esc(
    SOURCE_LABELS[source] || source
  )}</span>`;
}

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

  /* Протокол и адрес — нейтральные факты: золото в этом разделе означает
     «сюда стоит посмотреть» (учётные данные, состояние связи). */
  const facts = [
    chip(esc(printer.protocol), "mute"),
    chip(esc(hostLabel(printer)), "mute"),
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
          <button type="button" class="btn btn-sm" data-prn-action="discover" data-id="${esc(printer.id)}"
            ${busy === "discover" ? "disabled" : ""}>
            ${busy === "discover" ? "Опрашиваю…" : "Опросить принтер"}
          </button>
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
      ${discoveryPanel(printer)}
      <details class="ops-details prn-details">
        <summary>Настройки и учётные данные</summary>
        ${printerForm(printer, state)}
      </details>
    </div>`;
}

/* ── Что известно о самом принтере ─────────────────────────── */

/**
 * Характеристики, полученные от принтера. Это ответ на вопрос «что я вообще
 * подключил» — раньше его давал только человек, вписавший всё руками.
 *
 * Пустая характеристика подписана явно («принтер не сообщает»), а не оставлена
 * прочерком: разница между «нет данных» и «данные есть, но нулевые» — это
 * разница между «нужно заполнить» и «всё в порядке».
 */
function discoveryPanel(printer) {
  const specs = printer.specs;
  if (!specs) return "";

  const rows = [
    specRow("Модель", specs.model, (v) => v),
    specRow("Прошивка", specs.firmware, (v) => v),
    specRow("Имя устройства", specs.deviceName, (v) => v),
    specRow("Рабочая область", specs.buildVolume, (v) => `${v.x} × ${v.y} × ${v.z} мм`),
    specRow("Диаметр сопла", specs.nozzleDiameterMm, (v) => `${v} мм`),
    specRow("Тип сопла", specs.nozzleType, (v) => v),
    specRow("Материал", specs.material, (v) => v),
    specRow("Мультиматериал", specs.ams, amsLabel),
    specRow("Экструдеров", specs.extruderCount, (v) => String(v)),
    specRow("Датчик филамента", specs.filamentSensor, (v) => (v ? "есть" : "нет")),
    specRow("Обогрев камеры", specs.heatedChamber, (v) => (v ? "есть" : "нет")),
    specRow("Кинематика", specs.kinematics, (v) => v)
  ]
    .filter(Boolean)
    .join("");

  return `
    <div class="prn-discovered">
      <div class="prn-discovered-head">
        <p class="panel-sub">Характеристики с принтера</p>
        ${discoveryStamp(printer.discovery)}
      </div>
      ${
        rows
          ? `<div class="prn-specs">${rows}</div>`
          : `<div class="slice-hint">Принтер ещё ничего о себе не сообщил — нажмите «Опросить принтер».</div>`
      }
      ${materialsList(specs.materials)}
      ${conflictNotes(specs)}
    </div>`;
}

/** Одна строка «характеристика — значение — источник». */
function specRow(label, spec, format) {
  if (!spec) return "";
  const known = spec.value !== null && spec.value !== undefined;
  // Неизвестное показываем только для того, что оператор обычно ищет глазами;
  // остальное просто не занимает место.
  if (!known && !ALWAYS_SHOWN.has(label)) return "";

  return `
    <div class="prn-spec">
      <span class="prn-spec-label">${esc(label)}</span>
      <span class="prn-spec-value">${
        known ? esc(format(spec.value)) : `<i>принтер не сообщает</i>`
      }</span>
      ${sourceBadge(spec)}
    </div>`;
}

/* Эти четыре нужны для планирования, поэтому их отсутствие — тоже факт,
   который должен быть виден, а не подразумеваться пустым местом. */
const ALWAYS_SHOWN = new Set(["Модель", "Рабочая область", "Диаметр сопла", "Тип сопла"]);

function amsLabel(ams) {
  if (!ams.present) return "нет";
  const parts = [ams.kind || "мультиматериал"];
  if (ams.slots) parts.push(`${ams.slots} слот(ов)`);
  return parts.join(", ");
}

/** Загруженные катушки — то, что сейчас реально стоит в принтере. */
function materialsList(spec) {
  const materials = spec?.value;
  if (!Array.isArray(materials) || !materials.length) return "";

  const items = materials
    .map((entry) => {
      const slot = entry.slot === null ? "внешняя катушка" : `слот ${entry.slot + 1}`;
      const swatch = entry.color
        ? `<span class="prn-swatch" style="background:${esc(entry.color)}"></span>`
        : `<span class="prn-swatch prn-swatch--empty"></span>`;
      const remain = entry.remainPct === null ? "" : ` · ${entry.remainPct}%`;
      return `<li${entry.active ? ' class="prn-material--active"' : ""}>${swatch}<span>${esc(slot)}: ${esc(
        entry.material || "пусто"
      )}${esc(remain)}${entry.active ? " · печатает" : ""}</span></li>`;
    })
    .join("");

  return `
    <div class="prn-materials">
      <div class="prn-materials-head">
        <p class="panel-sub">Загруженные материалы</p>
        ${sourceBadge(spec)}
      </div>
      <ul>${items}</ul>
    </div>`;
}

/**
 * Расхождения между принтером и тем, что вписал оператор.
 *
 * Побеждает принтер, но ручное значение не выбрасывается молча: показать его —
 * единственный способ заметить, что сопло поменяли физически, а в настройках
 * самого принтера не поправили (или наоборот).
 */
function conflictNotes(specs) {
  const notes = [
    conflictNote("Диаметр сопла", specs.nozzleDiameterMm, (v) => `${v} мм`),
    conflictNote("Тип сопла", specs.nozzleType, (v) => v),
    conflictNote("Рабочая область", specs.buildVolume, (v) => `${v.x} × ${v.y} × ${v.z} мм`),
    conflictNote("Материал", specs.material, (v) => v),
    conflictNote("Модель", specs.model, (v) => v),
    catalogNote("Рабочая область", specs.buildVolume, (v) => `${v.x} × ${v.y} × ${v.z} мм`)
  ].filter(Boolean);

  return notes.join("");
}

function conflictNote(label, spec, format) {
  if (!spec?.overriddenManual) return "";
  return `<div class="prn-conflict"><span aria-hidden="true">⚠</span><span>${esc(label)}: вручную задано «${esc(
    format(spec.overriddenManual)
  )}», но принтер сообщает «${esc(
    format(spec.value)
  )}» — действует значение принтера. Очистите поле в настройках или поправьте настройку на самом принтере.</span></div>`;
}

function catalogNote(label, spec, format) {
  if (!spec?.catalogHint) return "";
  return `<div class="slice-meta">${esc(label)}: по модели принтера — «${esc(
    format(spec.catalogHint)
  )}», действует введённое вручную значение.</div>`;
}

function discoveryStamp(discovery) {
  if (!discovery) return `<span class="slice-hint">опрос ещё не выполнялся</span>`;
  const when = discovery.probedAt ? fmtDate(discovery.probedAt) : "";
  if (discovery.succeeded) {
    return `<span class="slice-hint">обновлено ${esc(when)}</span>`;
  }
  // Неудачный опрос НЕ стирает выученное: показываем прежние данные и честно
  // помечаем, что они не свежие — предупреждающим тоном, а не рядовой подписью.
  return `<span class="slice-hint prn-stamp--failed">последний опрос не удался${when ? ` (${esc(when)})` : ""}${
    discovery.error ? `: ${esc(discovery.error)}` : ""
  } — показаны прежние данные</span>`;
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
  const specs = printer.specs || {};
  const auto = autoFields(printer, state);

  return `
    <form class="slice-form prn-form" data-prn-form="edit" data-id="${esc(printer.id)}">
      <div class="slice-hint prn-form-note">
        Пустое поле — значит «брать с принтера». Заполняйте только то, что принтер
        сообщить не может: введённое вручную помечается отдельно, а при расхождении
        действует значение принтера.
      </div>
      <div class="slice-grid">
        ${textField("name", "Название", printer.name, { required: true })}
        ${selectField("protocol", "Протокол", printer.protocol, protocolOptions(state))}
        ${textField("host", "Адрес (IP или имя)", printer.host, { required: true })}
        ${numberField("port", "Порт", printer.port)}
        ${textField("model", "Модель", printer.model, specHints("model", specs, auto, (v) => v))}
        ${selectField("type", "Тип", printer.type, [
          { id: "FDM", label: "FDM" },
          { id: "Resin", label: "Фотополимер" }
        ])}
        ${textField("printerClass", "Класс совместимости", printer.printerClass, {
          placeholder: "k2",
          hint: "Ярлык взаимозаменяемых машин — цель нарезки «для класса»."
        })}
        ${textField(
          "material",
          "Материал",
          printer.material,
          specHints("material", specs, auto, (v) => v)
        )}
        ${numberField("nozzleDiameterMm", "Диаметр сопла, мм", printer.nozzleDiameterMm, {
          step: "0.01",
          ...specHints("nozzleDiameterMm", specs, auto, (v) => String(v))
        })}
        ${textField(
          "nozzleType",
          "Тип сопла",
          printer.nozzleType,
          specHints("nozzleType", specs, auto, (v) => v)
        )}
        ${textField("swatch", "Цвет метки", printer.swatch, { placeholder: "#7fb3d8" })}
        ${textField("interfaceUrl", "Веб-интерфейс принтера", printer.interfaceUrl, {
          placeholder: "http://192.168.0.132:4408"
        })}
        ${textField("snapshotUrl", "URL кадра камеры", printer.snapshotUrl)}
        ${textField("streamUrl", "URL потока камеры", printer.streamUrl)}
        ${numberField("buildVolume.x", "Стол X, мм", bv.x, axisHints("x", specs, auto))}
        ${numberField("buildVolume.y", "Стол Y, мм", bv.y, axisHints("y", specs, auto))}
        ${numberField("buildVolume.z", "Стол Z, мм", bv.z, axisHints("z", specs, auto))}
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
            <span class="fld-head">${esc(label)}</span>
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
        <span class="fld-head">${esc(CREDENTIAL_LABELS[field] || field)}</span>
        <input type="password" name="secret:${esc(field)}" autocomplete="new-password" />
        <span></span>
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

/* ── Подсказки полей, зависящие от источника ───────────────── */

/** Какие поля этот протокол умеет определять сам — приходит с backend. */
function autoFields(printer, state) {
  const protocol = (state.options?.protocols || []).find((p) => p.id === printer.protocol);
  return new Set(protocol?.autoFields || []);
}

/**
 * Подсказка и плейсхолдер для поля, которое может заполниться само.
 *
 * Три состояния, и различать их — весь смысл: принтер уже сказал (значение
 * стоит плейсхолдером, поле можно не трогать); принтер умеет, но пока молчит;
 * принтер такого не сообщает вовсе — тогда это поле и есть та ручная работа,
 * которой не избежать.
 */
function specHints(field, specs, auto, format) {
  const spec = specs[field];
  const known = spec && spec.value !== null && spec.value !== undefined;
  const fromDevice = known && spec.source !== "manual";

  if (fromDevice) {
    return {
      placeholder: format(spec.value),
      badge: sourceBadge(spec),
      hint:
        spec.source === "manual"
          ? ""
          : `Оставьте пустым — значение берётся ${
              SOURCE_LABELS[spec.source]
            }${spec.via ? ` (${spec.via})` : ""}.`
    };
  }
  if (auto.has(field)) {
    return { hint: "Заполнится автоматически, как только принтер сообщит это значение." };
  }
  return {
    badge: known ? sourceBadge(spec) : "",
    hint: "Принтер эту характеристику не передаёт — заполните вручную."
  };
}

/** То же для одной оси стола: габариты приходят целиком, а поля три. */
function axisHints(axis, specs, auto) {
  const spec = specs.buildVolume;
  const known = spec && spec.value;
  if (known && spec.source !== "manual") {
    return { placeholder: String(spec.value[axis]), badge: sourceBadge(spec) };
  }
  if (auto.has("buildVolume")) {
    return { hint: axis === "x" ? "Заполнится автоматически с принтера." : "" };
  }
  return {};
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

/* Заголовок поля: подпись плюс, если значение может прийти с принтера, бейдж
   источника. Бейдж — уже готовая разметка (sourceBadge), поэтому не экранируется.
   Обёртка .fld-head обязательна: в колоночном <label> голый бейдж растягивался
   во всю ширину поля отдельной цветной полосой над вводом. Она же держит поля
   в ряду на одной высоте (см. subgrid в workflows.css). */
function fieldLabel(label, opts) {
  return `<span class="fld-head">${esc(label)}${opts.required ? " *" : ""}${opts.badge || ""}</span>`;
}

function fieldHint(opts) {
  return opts.hint ? `<span class="slice-hint">${esc(opts.hint)}</span>` : `<span></span>`;
}

function textField(name, label, value, opts = {}) {
  return `
    <label>
      ${fieldLabel(label, opts)}
      <input type="text" name="${esc(name)}" value="${esc(value ?? "")}"
        ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ""} />
      ${fieldHint(opts)}
    </label>`;
}

function numberField(name, label, value, opts = {}) {
  return `
    <label>
      ${fieldLabel(label, opts)}
      <input type="number" name="${esc(name)}" value="${value ?? ""}"
        ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ""}
        ${opts.step ? `step="${esc(opts.step)}"` : ""} min="0" />
      ${fieldHint(opts)}
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
      ${fieldLabel(label, opts)}
      <select name="${esc(name)}" ${opts.extra || ""}>${items}</select>
      ${fieldHint(opts)}
    </label>`;
}
