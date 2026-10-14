/* ── Единицы STL ─────────────────────────────────────────────────
   Чистый модуль (без DOM): выбор единиц для подтверждения масштаба модели.
   Значения — канонические имена единиц сервера (domain/shared/units.ts). */

/* Раньше здесь были «mm»/«cm»/«m», а сервер принимал только
   «millimeter»/«centimeter»/«meter»: подтвердить STL можно было лишь в дюймах. */
export const UNIT_CHOICES = [
  { value: "millimeter", label: "Миллиметры", factor: 1 },
  { value: "centimeter", label: "Сантиметры", factor: 10 },
  { value: "inch", label: "Дюймы", factor: 25.4 },
  { value: "meter", label: "Метры", factor: 1000 }
];
