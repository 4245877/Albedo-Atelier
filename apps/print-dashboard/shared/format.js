/* ── Общие функции форматирования ──────────────────────────────
   Единственное место, где числа/даты/длительности превращаются в текст.
   Никакого DOM — модуль исполняется и в Node (юнит-тесты), и в браузере.
   Раньше эти функции были продублированы в uploads/slicing/scheduler/util. */

/** Байты → человекочитаемо («1.2 МБ»); null/undefined → `empty` (по умолчанию «—»). */
export function fmtBytes(n, empty = "—") {
  if (n == null || !Number.isFinite(n)) return empty;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

/** Секунды → «2 ч 05 м»/«42 м»; null → null (вызывающий сам решает, что показать). */
export function fmtDuration(s) {
  if (s == null) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} ч ${m} м` : `${m} м`;
}

/** Минуты → «1 ч 05 м»/«42 м»; пусто/0/отрицательное → «—» (карточки принтеров). */
export function fmtLeft(min) {
  if (!min || min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} ч ${String(m).padStart(2, "0")} м` : `${m} м`;
}

/** Диаметр сопла «0.4» без плавающего хвоста (0.40000001 → 0.4). */
export function fmtNozzle(mm) {
  if (mm == null) return null;
  return String(Math.round(mm * 100) / 100);
}

/** ISO → «дд.мм чч:мм» локально; непарсимое → `empty` (по умолчанию «—»). */
export function fmtDate(iso, empty = "—") {
  if (!iso) return empty;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? empty
    : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Как {@link fmtDate}, но пустой ответ — «» (панель слайсинга исторически без прочерка). */
export function fmtWhen(iso) {
  return fmtDate(iso, "");
}

/** Миллисекунды эпохи → «чч:мм» локально; непарсимое → «». */
export function fmtTime(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** ISO → значение для input[type=datetime-local] в локальном времени. */
export function isoToInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Значение datetime-local (локальное) → ISO; непарсимое → null. */
export function inputToIso(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
