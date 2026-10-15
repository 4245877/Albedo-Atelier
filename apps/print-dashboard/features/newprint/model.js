/* ── «Новая печать»: модель пути ─────────────────────────────────
   Чистый модуль (без DOM и сети): что выбрано, что из этого следует и какой
   шаг сейчас. Шесть шагов одного пути —

     Файл → Принтер → Рецепт → Слайсинг → Результат → Запуск

   — раньше были разбросаны по четырём разделам (загрузка, слайсинг с профилями,
   планировщик, окно запуска), и оператор сам собирал из них печать. Здесь путь
   один, а технические разделы остаются для настройки, не для работы.

   Правила допуска здесь НЕ живут: можно ли нарезать, утверждён ли рецепт,
   готов ли вариант, можно ли стартовать — отвечает сервер (анализ, набор,
   вариант, окно запуска). Модель только читает его ответы и решает, какой шаг
   показать и что на нём доступно. */

export const STEPS = [
  { id: "file", label: "Файл" },
  { id: "printer", label: "Принтер" },
  { id: "recipe", label: "Рецепт" },
  { id: "slice", label: "Слайсинг" },
  { id: "result", label: "Результат" },
  { id: "launch", label: "Запуск" }
];

/* Шаги, которые нарезанному файлу не нужны: он уже G-code. */
const SLICING_STEPS = new Set(["recipe", "slice", "result"]);

/**
 * Чем файл является для этого пути: `model` (нужна нарезка), `print` (уже
 * нарезан — G-code или пакет), либо null — анализ не готов или файл непригоден.
 * Решение сервера (вердикт анализа и `status.executable`), не расширение имени.
 */
export function fileKind(item) {
  const analysis = item && item.analysis;
  if (!analysis || analysis.state !== "ready") return null;
  if (analysis.verdict === "needs_preparation") return "model";
  if (item.status && item.status.executable) return "print";
  return null;
}

/**
 * Что мешает идти дальше с выбранным файлом, словами сервера — или null.
 * Шаги, которые сервер называет «следующими» до нарезки/постановки (единицы,
 * пластина, чтение проверки, повтор анализа), — это и есть то, что осталось
 * сделать с файлом.
 */
export function fileHold(item) {
  if (!item) return null;
  const next = item.status && item.status.next;
  if (!next) return null;
  if (next.kind === "wait") return { kind: "wait", text: next.explanation };
  if (next.kind === "blocked") return { kind: "blocked", text: next.explanation };
  if (next.kind === "reanalyze") return { kind: "reanalyze", text: next.explanation };
  if (next.kind === "confirm_scale") return { kind: "confirm_scale", text: next.explanation };
  if (next.kind === "select_plate") return { kind: "select_plate", text: next.explanation };
  if (next.kind === "confirm_review") return { kind: "confirm_review", text: next.explanation };
  return null;
}

/** Нормализованное имя класса принтеров (как на сервере: без регистра и краёв). */
function normClass(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Рецепты, которыми можно резать для принтера: утверждённые и не заблокированные
 * наборы, привязанные к нему самому или к его классу. Утверждение и блокировки
 * — данные сервера; здесь только сопоставление с выбранным принтером.
 */
export function recipesFor(sets, printer) {
  if (!printer) return [];
  const cls = normClass(printer.printerClass);
  return (sets || []).filter(
    (s) =>
      s.approved === true &&
      s.validation !== "blocked" &&
      (s.printerId === printer.printerId || (cls !== "" && normClass(s.printerClass) === cls))
  );
}

/**
 * Принтеры для выбора. Для модели рядом — сколько у принтера готовых рецептов:
 * без рецепта нарезать нечем, и это надо сказать до клика, а не после.
 */
export function printerChoices(coverage, sets, kind) {
  return (coverage || []).map((p) => {
    const recipes = kind === "model" ? recipesFor(sets, p).length : null;
    return {
      printerId: p.printerId,
      name: p.printerName || p.printerId,
      model: p.model || null,
      printerClass: p.printerClass || null,
      recipes,
      usable: kind !== "model" || recipes > 0
    };
  });
}

/**
 * Что принтер делает сейчас — одной пометкой рядом с ним в списке выбора.
 *
 * Пометка, а не запрет: нарезать под занятый принтер можно (печатать — потом),
 * а окно запуска всё равно проверит принтер перед отправкой. Но выбирать
 * принтер, не видя, что он печатает, молчит или ждёт снятия детали, — значит
 * узнать об этом только в самом конце пути. Источник — то же представление
 * принтера, что у карточки в Зале (`/api/printers`), включая серверную
 * `readiness`; без неё — только статус устройства.
 */
export function printerStateNote(view) {
  if (!view) return null;
  if (view.status === "offline") return { text: "нет связи", tone: "warn" };
  if (view.status === "error") return { text: "ошибка на принтере", tone: "error" };
  if (view.status === "printing") return { text: "печатает", tone: "info" };
  if (view.status === "paused") return { text: "на паузе", tone: "info" };
  const readiness = view.readiness;
  if (readiness && readiness.canAcceptJob === false && readiness.label) return { text: readiness.label, tone: "warn" };
  if (view.status === "idle") return { text: "свободен", tone: "ok" };
  return null;
}

const VARIANT_RUNNING = new Set(["pending", "running"]);

/**
 * Состояние всего пути — что сделано, где мы, что дальше.
 *
 * `selection`: { artifactId, printerId, setId, variantId, taskId }.
 * `data`: { items, coverage, sets, variants } — ответы сервера.
 * Возвращает шаги с состоянием (`done` | `current` | `todo` | `skipped`) и
 * вычисленные выбранные объекты, чтобы вид не искал их заново.
 */
export function resolveFlow(selection, data) {
  const sel = selection || {};
  const item = (data.items || []).find((it) => it.artifact && it.artifact.id === sel.artifactId) || null;
  const kind = fileKind(item);
  const hold = item ? fileHold(item) : null;
  const printer = (data.coverage || []).find((p) => p.printerId === sel.printerId) || null;
  const recipes = kind === "model" ? recipesFor(data.sets, printer) : [];
  const set = recipes.find((s) => s.id === sel.setId) || null;
  // Только нарезка, запущенная на этом пути. Старый вариант того же файла
  // принадлежит своему (возможно, уже закрытому) заданию и в очередь не встанет;
  // повтор той же нарезки сервер отдаёт из кэша мгновенно.
  const variant = (sel.variantId && (data.variants || []).find((v) => v.id === sel.variantId)) || null;
  const taskId = sel.taskId || null;

  const fileDone = Boolean(item && kind && !hold);
  const printerDone = fileDone && Boolean(printer) && (kind !== "model" || recipes.length > 0);
  const recipeDone = printerDone && (kind !== "model" || Boolean(set));
  const sliceDone = recipeDone && (kind !== "model" || (variant !== null && !VARIANT_RUNNING.has(variant.state)));
  const resultDone = sliceDone && (kind !== "model" || Boolean(taskId));
  const done = {
    file: fileDone,
    printer: printerDone,
    recipe: recipeDone,
    slice: sliceDone,
    result: resultDone,
    launch: false
  };

  let current = null;
  const steps = STEPS.map((step) => {
    if (kind === "print" && SLICING_STEPS.has(step.id)) return { ...step, state: "skipped" };
    if (done[step.id]) return { ...step, state: "done" };
    if (current === null) {
      current = step.id;
      return { ...step, state: "current" };
    }
    return { ...step, state: "todo" };
  });

  return { steps, current, item, kind, hold, printer, recipes, set, variant, taskId };
}

/**
 * «Как в прошлый раз»: принтер и рецепт последней готовой нарезки этой модели —
 * если и принтер, и рецепт можно выбрать сейчас (рецепт по-прежнему утверждён и
 * подходит принтеру). Иначе null: предлагать то, что мастер сам не разрешит
 * выбрать, — значит предлагать тупик.
 */
export function lastRecipeFor(artifactId, variants, sets, coverage) {
  if (!artifactId) return null;
  const previous = (variants || [])
    .filter((v) => v.sourceArtifactId === artifactId && v.state === "ready" && v.targetPrinterId)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  for (const v of previous) {
    const printer = (coverage || []).find((p) => p.printerId === v.targetPrinterId);
    if (!printer) continue;
    const set = recipesFor(sets, printer).find((s) => s.id === v.profileSetId);
    if (!set) continue;
    return {
      printerId: printer.printerId,
      setId: set.id,
      printerName: printer.printerName || printer.printerId,
      setName: set.name
    };
  }
  return null;
}

/** Можно ли поставить вариант в очередь: сервер признал его готовым и проверенным. */
export function variantPromotable(variant, outputAnalysis) {
  if (!variant || variant.state !== "ready" || !variant.outputArtifactId) return false;
  return Boolean(outputAnalysis && outputAnalysis.state === "ready" && outputAnalysis.verdict === "schedulable");
}

/** Варианты, за которыми надо следить опросом (нарезка ещё идёт). */
export function isSlicing(variant) {
  return Boolean(variant && VARIANT_RUNNING.has(variant.state));
}
