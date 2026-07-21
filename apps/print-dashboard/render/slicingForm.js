/* ── Чистые помощники раздела «Слайсинг»: цель набора, доступность создания и
   каденс опроса. Никакого DOM/сети — модуль исполняется и в Node
   (tests/slicingForm.test.mjs), и в браузере (render/slicing.js). Держим здесь
   ровно ту логику, которую иначе пришлось бы дублировать между отрисовкой формы,
   валидацией отправки и опросом. */

/** Различные непустые классы принтеров из coverage — значения для цели-класса. */
export function distinctClasses(coverage) {
  const seen = new Set();
  const out = [];
  for (const c of coverage || []) {
    const cls = ((c && c.printerClass) || "").trim();
    if (cls && !seen.has(cls)) {
      seen.add(cls);
      out.push(cls);
    }
  }
  return out;
}

/** Что можно выбрать целью: список принтеров и список классов. */
export function targetOptions(coverage) {
  const printers = (coverage || []).filter((c) => c && c.printerId);
  return { printers, classes: distinctClasses(coverage) };
}

/**
 * Причина, по которой набор создать нельзя (или null, если можно). Пустой список
 * принтеров/coverage → нет валидной цели вообще; отсутствие active-профилей →
 * набор не из чего собрать. Возвращаем понятный оператору текст, а не молчание.
 */
export function createSetBlockReason(coverage, missingActive) {
  if (!(coverage && coverage.length)) {
    return "Нет доступных принтеров: добавьте принтер в конфигурацию фермы (config/printers.json) и импортируйте пресеты — без цели набор не создать.";
  }
  if (missingActive && missingActive.length) {
    return `Нет активных профилей: ${missingActive.join(", ")}. Набор собирается только из active-профилей — импортируйте/почините пресеты.`;
  }
  return null;
}

/**
 * Тело POST /profile-sets из данных формы и выбранного типа цели. Ровно одна
 * цель — конкретный принтер ИЛИ класс. Если значение цели не выбрано, возвращаем
 * { ok:false, error } с понятным текстом: форму нельзя отправлять без цели.
 */
export function buildCreateSetPayload(data, targetType) {
  const d = data || {};
  const base = {
    name: (d.name || "").trim(),
    machine: d.machine,
    process: d.process,
    filament: d.filament
  };
  if (targetType === "class") {
    const printerClass = (d.printerClass || "").trim();
    if (!printerClass) {
      return { ok: false, error: "Выберите класс принтеров или переключитесь на конкретный принтер." };
    }
    return { ok: true, payload: { ...base, printerClass } };
  }
  const printer = (d.printer || "").trim();
  if (!printer) {
    return { ok: false, error: "Выберите целевой принтер или переключитесь на класс." };
  }
  return { ok: true, payload: { ...base, printer } };
}

/**
 * Каденс опроса. Быстрый (fast), пока есть работа или ошибки загрузки; иначе —
 * редкий фоновый (idle), чтобы изменения, сделанные другим оператором или фоновым
 * процессом, не оставались невидимыми сколь угодно долго. Никогда не 0/null —
 * опрос идёт всегда.
 */
export function nextPollMs({ busyVariants, hasErrors }, { fast, idle }) {
  return busyVariants || hasErrors ? fast : idle;
}
