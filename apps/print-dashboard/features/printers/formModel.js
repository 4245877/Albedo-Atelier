/* ── Чистая модель формы принтера: (поля формы) → тело запроса ──
   Ни DOM, ни сети — модуль исполняется и в браузере (controller.js), и в Node
   (tests/printerForm.test.mjs). Здесь живёт единственное правило, которое иначе
   расползлось бы по обработчикам и однажды разошлось бы с backend:

     ПУСТОЕ ПОЛЕ УЧЁТНЫХ ДАННЫХ = «НЕ МЕНЯТЬ», А НЕ «СТЕРЕТЬ».

   Backend не отдаёт секреты наружу, поэтому поля кода доступа и серийного
   номера всегда пустые. Если бы отправка формы трактовала пустоту как пустую
   строку, любое сохранение настроек молча обнуляло бы код доступа принтера, и
   ферма теряла бы с ним связь при следующем опросе. Стирание — отдельное
   явное действие (галочка «стереть»), которое шлёт null. */

/** Поля, которые backend принимает как есть (пустая строка = очистить). */
const TEXT_FIELDS = [
  "name",
  "host",
  "model",
  "protocol",
  "type",
  "printerClass",
  "material",
  "nozzleType",
  "swatch",
  "interfaceUrl",
  "snapshotUrl",
  "streamUrl"
];

const NUMBER_FIELDS = ["port", "nozzleDiameterMm"];

const LIGHT_TEXT_FIELDS = ["pin", "bambuNode", "onGcode", "offGcode", "statusObject", "statusField"];

/** Учётные данные: приходят из полей `secret:<поле>` / галочек `clear:<поле>`. */
export const SECRET_FIELDS = ["apiKey", "serial", "accessCode"];

const num = (raw) => {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Собирает тело POST/PATCH из значений формы.
 *
 * @param {{values?: Record<string,string>, flags?: Record<string,boolean>}} form
 *   values — текстовые поля и селекты, flags — состояние чекбоксов
 *   (именно состояние, а не факт присутствия: снятая галочка — тоже решение).
 * @param {{create?: boolean}} [opts] create — включить id (он неизменяем после
 *   создания, и backend отказывает в его смене).
 */
export function buildPrinterPayload(form, opts = {}) {
  const values = form?.values || {};
  const flags = form?.flags || {};
  const payload = {};

  if (opts.create) payload.id = String(values.id ?? "").trim();

  for (const field of TEXT_FIELDS) {
    if (field in values) payload[field] = String(values[field] ?? "").trim();
  }
  for (const field of NUMBER_FIELDS) {
    if (field in values) payload[field] = num(values[field]);
  }

  // На создании необязательные пустые поля просто не отправляем: backend
  // подставит собственные значения по умолчанию, а не пустые строки.
  if (opts.create) {
    for (const field of [...TEXT_FIELDS, ...NUMBER_FIELDS]) {
      if (payload[field] === "" || payload[field] === null) delete payload[field];
    }
  }

  const volume = buildVolume(values);
  if (volume !== undefined) payload.buildVolume = volume;

  const light = buildLight(values, flags);
  if (light !== undefined) payload.light = light;

  for (const flag of ["enabled", "allowInsecureTls"]) {
    if (flag in flags) payload[flag] = Boolean(flags[flag]);
  }

  Object.assign(payload, buildSecrets(values, flags));
  return payload;
}

/** Габариты стола отправляются целиком или не отправляются вовсе. */
function buildVolume(values) {
  const keys = ["x", "y", "z"].map((axis) => `buildVolume.${axis}`);
  if (!keys.some((key) => key in values)) return undefined;
  const [x, y, z] = keys.map((key) => num(values[key]));
  if (x === null && y === null && z === null) return null;
  return { x, y, z };
}

function buildLight(values, flags) {
  const present =
    "light.enabled" in values ||
    "light.invert" in flags ||
    LIGHT_TEXT_FIELDS.some((field) => `light.${field}` in values);
  if (!present) return undefined;

  const light = {};
  if ("light.enabled" in values) {
    const raw = String(values["light.enabled"] ?? "").trim();
    // Пусто — это «не выбрано»: пусть backend применит правило протокола.
    light.enabled = raw === "" ? null : raw === "true";
  }
  if ("light.invert" in flags) light.invert = Boolean(flags["light.invert"]);
  for (const field of LIGHT_TEXT_FIELDS) {
    const key = `light.${field}`;
    if (key in values) light[field] = String(values[key] ?? "").trim();
  }
  return light;
}

/**
 * Учётные данные. Три исхода на поле, и различие между ними — весь смысл
 * сценария «сбросили код доступа»:
 *   • введено значение → отправляем его;
 *   • отмечено «стереть» → отправляем null (единственный способ обнулить);
 *   • пусто и не отмечено → поле НЕ попадает в запрос, сохранённое остаётся.
 */
function buildSecrets(values, flags) {
  const out = {};
  for (const field of SECRET_FIELDS) {
    const typed = String(values[`secret:${field}`] ?? "").trim();
    if (typed) out[field] = typed;
    else if (flags[`clear:${field}`]) out[field] = null;
  }
  return out;
}
