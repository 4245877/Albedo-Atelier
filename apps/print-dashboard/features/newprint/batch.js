/* ── «Новая печать»: пакет моделей — модель пути ───────────────────
   Несколько моделей — один принтер и один рецепт. Путь тот же, что у одной
   модели, и сервер делает для каждой ровно то же самое: те же проверки, тот же
   кэш, одна подготовка на модель. Пакет меняет только форму: выбор нескольких
   файлов, строку на модель в нарезке и результате и «поставить готовые в
   очередь» одним действием. Запускается каждая печать по отдельности — у
   каждой свой стол, и его освобождение подтверждает человек.

   Чистый модуль (без DOM и сети), как и model.js. */

import { STEPS, fileHold, fileKind, isSlicing, recipesFor, variantPromotable } from "./model.js";

export const BATCH_STEPS = STEPS.map((s) => (s.id === "file" ? { ...s, label: "Модели" } : s));

/** Сколько моделей в одном пакете — столько же принимает сервер. */
export const MAX_BATCH = 25;

/** Пустое состояние пакета: всё, что из выбора моделей следует. */
export const BATCH_RESET = {
  artifactIds: [],
  filesConfirmed: false,
  printerId: null,
  setId: null,
  batchId: null,
  variants: {},
  refused: {},
  tasks: {},
  queued: false
};

/** Что сбрасывает изменение каждого шага пакета. Выбор моделей «Изменить» не теряет. */
export const BATCH_RESETS = {
  file: {
    filesConfirmed: false,
    printerId: null,
    setId: null,
    batchId: null,
    variants: {},
    refused: {},
    tasks: {},
    queued: false
  },
  printer: { printerId: null, setId: null, batchId: null, variants: {}, refused: {}, tasks: {}, queued: false },
  recipe: { setId: null, batchId: null, variants: {}, refused: {}, tasks: {}, queued: false },
  slice: { batchId: null, variants: {}, refused: {}, tasks: {}, queued: false },
  result: { tasks: {}, queued: false }
};

/** Модели, которые вообще могут войти в пакет: проанализированная модель (не G-code). */
export function batchCandidates(items) {
  return (items || []).filter((it) => it.artifact && fileKind(it) === "model");
}

/** Выбор/снятие модели в пакете (не больше {@link MAX_BATCH}). */
export function toggleBatchFile(ids, artifactId) {
  const list = Array.isArray(ids) ? ids : [];
  if (list.includes(artifactId)) return list.filter((id) => id !== artifactId);
  if (list.length >= MAX_BATCH) return list;
  return [...list, artifactId];
}

/**
 * Состояние пакетного пути. `selection` — выбор пакета (см. {@link BATCH_RESET}),
 * `data` — те же ответы сервера, что у одиночного пути.
 *
 * Возвращает шаги и строки: по одной на модель, с её вариантом, отказом,
 * выходным файлом и заданием.
 */
export function resolveBatchFlow(selection, data) {
  const sel = selection || {};
  const ids = Array.isArray(sel.artifactIds) ? sel.artifactIds : [];
  const items = ids
    .map((id) => (data.items || []).find((it) => it.artifact && it.artifact.id === id))
    .filter(Boolean);
  const isReady = (it) => fileKind(it) === "model" && !fileHold(it);
  const ready = items.filter(isReady);
  const held = items.filter((it) => !isReady(it));
  const printer = (data.coverage || []).find((p) => p.printerId === sel.printerId) || null;
  const recipes = recipesFor(data.sets, printer);
  const set = recipes.find((s) => s.id === sel.setId) || null;

  const variants = sel.variants || {};
  const refusedMap = sel.refused || {};
  const tasks = sel.tasks || {};
  const rows = ready.map((item) => {
    const id = item.artifact.id;
    const variantId = variants[id] || null;
    const variant = variantId ? (data.variants || []).find((v) => v.id === variantId) || null : null;
    const output =
      variant && variant.outputArtifactId
        ? (data.outputs || []).find((o) => o.artifact && o.artifact.id === variant.outputArtifactId) || null
        : null;
    const analysis = output ? output.analysis : null;
    return {
      item,
      variant,
      refused: refusedMap[id] || null,
      output,
      promotable: variantPromotable(variant, analysis),
      taskId: variantId ? tasks[variantId] || null : null
    };
  });

  const requested = Boolean(sel.batchId);
  const slicing = rows.some((r) => isSlicing(r.variant));
  const outputPending = rows.some(
    (r) => r.variant && r.variant.state === "ready" && !(r.output && r.output.analysis && r.output.analysis.state === "ready")
  );

  const fileDone = sel.filesConfirmed === true && ready.length > 0 && held.length === 0;
  const printerDone = fileDone && Boolean(printer) && recipes.length > 0;
  const recipeDone = printerDone && Boolean(set);
  const sliceDone = recipeDone && requested && !slicing;
  const resultDone = sliceDone && sel.queued === true;
  const done = { file: fileDone, printer: printerDone, recipe: recipeDone, slice: sliceDone, result: resultDone, launch: false };

  let current = null;
  const steps = BATCH_STEPS.map((step) => {
    if (done[step.id]) return { ...step, state: "done" };
    if (current === null) {
      current = step.id;
      return { ...step, state: "current" };
    }
    return { ...step, state: "todo" };
  });

  return {
    mode: "batch",
    kind: "model",
    steps,
    current,
    items,
    ready,
    held,
    printer,
    recipes,
    set,
    rows,
    requested,
    slicing,
    outputPending,
    promotable: rows.filter((r) => r.promotable && !r.taskId),
    queued: rows.filter((r) => r.taskId),
    /** Есть ли среди выбранных STL, ждущие подтверждения единиц. */
    needsUnits: held.filter((it) => {
      const hold = fileHold(it);
      return hold && hold.kind === "confirm_scale";
    })
  };
}
