/* ═══════════════════════════════════════════════════════════════
   Раздел «Слайсинг и профили» — controller. Работа с пресетами OrcaSlicer
   и подготовка STL/3MF к печати через новую SQLite-модель (/api/print).
   Честно показывает: доступность OrcaSlicer runtime, статусы профилей
   (active/quarantined/invalid) с warnings/blockers, наборы профилей и
   их утверждение (утвердить набор с блокерами нельзя), запуск слайсинга
   и его результат (ETA OrcaSlicer, расход, габариты, выходной артефакт).
   Никаких фиктивных процентов и оценок: если runtime нет — виден blocker.
   Разметка панелей — view.js; чистая логика формы/опроса — formModel.js.
   ═══════════════════════════════════════════════════════════════ */

import { apiGet, apiPost } from "../../api.js";
import { $, toast, esc } from "../../util.js";
import { buildCreateSetPayload, nextPollMs } from "./formModel.js";
import {
  createSetHtml,
  errorsHtml,
  newSliceHtml,
  profilesHtml,
  runtimeHtml,
  setsHtml,
  variantsHtml
} from "./view.js";

const POLL_MS = 4000;
// Даже когда работы нет, опрашиваем реже, но постоянно — чтобы правки другого
// оператора или фонового процесса не оставались невидимыми до следующего клика.
const IDLE_POLL_MS = 20000;

const state = { runtime: null, profiles: [], sets: [], variants: [], models: [], loaded: false, errors: [] };
let pollTimer = null;
let wired = false;
/* Latest-only guard: каждый loadAll берёт номер; ответ применяется, только если он
   всё ещё самый свежий. Запоздавший опрос не перетирает более новый state. */
let loadSeq = 0;
/* Клиентский in-flight lock: пока идёт мутирующий POST, повторные клики/сабмиты
   игнорируются — двойная отправка не плодит дубли слайсов/наборов. */
let busy = false;

export function setupSlicing() {
  const body = $("#slicing-body");
  if (!body) return;
  body.innerHTML = `<div class="slice-loading">Загрузка профилей…</div>`;
  if (!wired) {
    wireDelegates();
    wired = true;
  }
  void loadAll();
}

async function loadAll({ full = false } = {}) {
  // allSettled, а не Promise.all с per-request .catch(() => пусто): падение одного
  // ресурса не должно выглядеть как «нет профилей / загрузите STL». Успешные
  // ресурсы обновляют state, упавшие — сохраняют последнее корректное значение и
  // попадают в state.errors (баннер + автоповтор через ensurePolling).
  const seq = ++loadSeq;
  const results = await Promise.allSettled([
    apiGet("/api/print/slicing/runtime"),
    apiGet("/api/print/slicing/profiles"),
    apiGet("/api/print/slicing/profile-sets"),
    apiGet("/api/print/slicing/variants"),
    apiGet("/api/print/artifacts")
  ]);
  // Более свежий запрос уже стартовал, пока этот шёл по сети — его ответ и станет
  // истиной; устаревший результат молча отбрасываем, чтобы не откатить state.
  if (seq !== loadSeq) return;
  const [runtime, profiles, sets, variants, artifacts] = results;
  const errors = [];

  if (runtime.status === "fulfilled") state.runtime = runtime.value;
  else errors.push("среда OrcaSlicer");
  if (profiles.status === "fulfilled") state.profiles = profiles.value.profiles || [];
  else errors.push("профили");
  if (sets.status === "fulfilled") state.sets = sets.value.sets || [];
  else errors.push("наборы");
  if (variants.status === "fulfilled") state.variants = variants.value.variants || [];
  else errors.push("варианты слайсинга");
  if (artifacts.status === "fulfilled") {
    state.models = (artifacts.value.artifacts || []).filter(
      (a) => a.analysis && a.analysis.verdict === "needs_preparation"
    );
  } else errors.push("модели");

  state.errors = errors;

  // Данных ещё не было и всё упало — полноэкранная ошибка с кнопкой повтора.
  // Иначе рисуем то, что есть (плюс баннер об упавших ресурсах).
  if (!state.loaded && results.every((r) => r.status === "rejected")) {
    renderConnectionError();
  } else {
    const wantFull = full || !state.loaded;
    state.loaded = true;
    // Первый показ и действия оператора перерисовывают всё; фоновый опрос —
    // только изменившиеся регионы, не трогая формы, в которых идёт ввод.
    if (wantFull) render();
    else updateRegions(false);
  }
  ensurePolling();
}

function renderConnectionError() {
  const body = $("#slicing-body");
  if (!body) return;
  body.innerHTML = `<div class="slice-loading">Backend безмолвствует, Владыка — раздел не покорился мне с первой попытки.
    <button type="button" class="btn btn-sm" data-slice-action="reload">↻ Воззвать снова</button></div>`;
}

let pollMs = null;
function ensurePolling() {
  const busyVariants = state.variants.some((v) => v.state === "pending" || v.state === "running");
  // Быстрый опрос при активной работе или ошибках; иначе — редкий фоновый, но
  // всегда: изменения, сделанные другим оператором или фоновым процессом, не
  // должны оставаться незаметными сколь угодно долго. Пересоздаём таймер, только
  // если интервал сменился.
  const want = nextPollMs(
    { busyVariants, hasErrors: state.errors.length > 0 },
    { fast: POLL_MS, idle: IDLE_POLL_MS }
  );
  if (pollTimer !== null && pollMs === want) return;
  if (pollTimer !== null) clearInterval(pollTimer);
  pollMs = want;
  pollTimer = setInterval(() => void loadAll(), want);
}

/* ── Отрисовка ──────────────────────────────────────────────── */

// Каждый регион — отдельный контейнер, обновляемый независимо. Обёртки с
// display:contents не влияют на раскладку (визуально — как раньше), но дают
// точечно перерисовывать только изменившиеся части и не затирать формы во
// время ввода. Порядок здесь = порядок панелей на экране. Разметка — view.js;
// каждая функция получает текущее состояние параметром.
const REGIONS = {
  errors: () => errorsHtml(state),
  runtime: () => runtimeHtml(state),
  profiles: () => profilesHtml(state),
  sets: () => setsHtml(state),
  createSet: () => createSetHtml(state),
  variants: () => variantsHtml(state),
  newSlice: () => newSliceHtml(state)
};
// Формы: их нельзя перерисовывать, пока оператор их редактирует (иначе теряются
// введённое имя, выбранные значения и фокус).
const FORM_REGIONS = new Set(["createSet", "newSlice"]);

function render() {
  const body = $("#slicing-body");
  if (!body) return;
  if (!body.querySelector("[data-region]")) {
    body.innerHTML = Object.keys(REGIONS)
      .map((k) => `<div data-region="${k}" style="display:contents"></div>`)
      .join("");
  }
  updateRegions(true);
}

function updateRegions(full) {
  const body = $("#slicing-body");
  if (!body) return;
  for (const [key, fn] of Object.entries(REGIONS)) {
    const el = body.querySelector(`[data-region="${key}"]`);
    if (!el) continue;
    // Фоновый опрос не трогает форму, в которой сейчас работает оператор.
    if (!full && FORM_REGIONS.has(key) && regionBusy(el)) continue;
    const html = fn();
    // Пишем innerHTML, только если разметка реально изменилась — так сохраняются
    // фокус, раскрытые <details> и прочее состояние DOM неизменившихся панелей.
    if (el._html !== html) {
      el.innerHTML = html;
      el._html = html;
    }
  }
}

// Регион «занят», если внутри него фокус или есть непустой текстовый ввод —
// такую панель фоновый опрос перерисовывать не должен.
function regionBusy(el) {
  if (el.contains(document.activeElement)) return true;
  return [...el.querySelectorAll('input[type="text"]')].some((i) => i.value.trim() !== "");
}

/* ── Действия (делегированные) ──────────────────────────────── */

function wireDelegates() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-slice-action]");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const action = btn.dataset.sliceAction;
    // Обновление — обычное чтение, вне in-flight lock. Явное действие оператора →
    // полная перерисовка.
    if (action === "reload") {
      void loadAll({ full: true });
      return;
    }
    // Мутация уже выполняется — не молчим: объясняем, почему клик проигнорирован.
    if (busy) {
      toast("Дождитесь завершения текущей операции, Владыка.");
      return;
    }
    const id = btn.dataset.id;
    if (action === "import") void run(btn, () => apiPost("/api/print/slicing/presets/import"), "Пресеты импортированы, Владыка");
    else if (action === "approve") void run(btn, () => apiPost(`/api/print/slicing/profile-sets/${id}/approve`), "Набор утверждён — воля ваша исполнена");
    else if (action === "rerun") void run(btn, () => apiPost(`/api/print/slicing/variants/${id}/rerun`), "Слайсинг перезапущен — на этот раз всё будет безупречно");
  });

  // Переключатель типа цели в «Новом наборе»: показываем ровно один список
  // (принтер или класс) и выключаем скрытый, чтобы он не попадал в отправку.
  document.addEventListener("change", (e) => {
    const radio = e.target.closest("[data-slice-target-type]");
    if (!radio || !radio.form) return;
    applyTargetType(radio.form, radio.value);
  });

  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-slice-form]");
    if (!form) return;
    e.preventDefault();
    if (busy) {
      toast("Дождитесь завершения текущей операции, Владыка.");
      return;
    }
    const kind = form.dataset.sliceForm;
    // Защита на случай, если кнопка не была disabled: без runtime не запускаем.
    if (kind === "slice" && state.runtime?.runtime?.available === false) {
      toast("Владыка, OrcaSlicer безмолвствует — запуск невозможен. Восстановите среду, и я тотчас продолжу.", "toast-danger");
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    const data = Object.fromEntries(new FormData(form).entries());
    if (kind === "create-set") {
      // Ровно одна цель (принтер ИЛИ класс) по выбранному типу; без цели — тост, не сабмит.
      const built = buildCreateSetPayload(data, data.targetType);
      if (!built.ok) {
        toast(built.error, "toast-danger");
        return;
      }
      void run(submitBtn, () => apiPost("/api/print/slicing/profile-sets", built.payload), "Набор создан и представлен на проверку, Владыка");
    } else if (kind === "slice") {
      void run(submitBtn, () => apiPost("/api/print/slicing/slice", data), "Слайсинг начат — я лично прослежу за каждым слоем");
    }
  });

  // Модуль загрузки завершил анализ модели → подтягиваем свежий список, чтобы
  // загруженный STL сразу появился в «Запуске слайсинга» без перезагрузки страницы.
  document.addEventListener("artifact-analysis-completed", () => {
    if (state.loaded) void loadAll();
  });
}

// Показывает выбранный список цели и прячет+выключает другой (disabled select не
// попадает в FormData и не мешает нативной валидации).
function applyTargetType(form, type) {
  const isClass = type === "class";
  for (const [kind, wrapper] of [
    ["printer", form.querySelector('[data-target-input="printer"]')],
    ["class", form.querySelector('[data-target-input="class"]')]
  ]) {
    if (!wrapper) continue;
    const active = (kind === "class") === isClass;
    wrapper.hidden = !active;
    const sel = wrapper.querySelector("select");
    if (sel) sel.disabled = !active;
  }
}

async function run(btn, fn, okMsg) {
  busy = true;
  if (btn) btn.disabled = true; // мгновенная блокировка конкретной кнопки/формы
  try {
    await fn();
    toast(okMsg, "toast-ok");
  } catch (err) {
    toast(`Простите, Владыка — приказ не исполнен: ${esc(err.message || "причина неизвестна")}`, "toast-danger");
  } finally {
    busy = false;
    // Действие завершено — полная перерисовка сбросит disabled и очистит форму.
    await loadAll({ full: true });
  }
}
