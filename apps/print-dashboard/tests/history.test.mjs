import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blockedReason,
  historyQuery,
  launchPrinterFor,
  primaryAction,
  recipeLines,
  reprepareSelection,
  scaleText,
  secondaryActions
} from "../features/history/model.js";
import { detailsHtml, entryHtml, historyHtml } from "../features/history/view.js";

/*
 * «История печати»: what was printed, where, with which settings — and the
 * one obvious next step. What may be done is the SERVER's answer (`actions`);
 * these pin that the screen offers exactly that and says why when it can't.
 */

const RECIPE = {
  variantId: "slc_1",
  profileSetId: "pset_1",
  profileSetName: "K2 · PETG",
  profileSetUsable: true,
  machine: "K2",
  process: "0.2 @K2",
  filament: "PETG @K2",
  targetPrinterId: "k2",
  targetPrinterClass: null,
  scaleFactor: 1,
  orcaVersion: "2.3.0",
  etaS: 3500,
  filamentG: 11.4
};

function entry(over = {}) {
  return {
    taskId: "task_1",
    title: "cube.stl",
    state: "COMPLETED",
    reason: null,
    createdAt: "2026-10-14T09:00:00.000Z",
    closedAt: "2026-10-14T10:00:00.000Z",
    material: "PETG",
    run: {
      id: "run_1",
      printerId: "k2",
      printerName: "Creality K2",
      state: "SUCCEEDED",
      startedAt: "2026-10-14T09:10:00.000Z",
      endedAt: "2026-10-14T10:00:00.000Z",
      durationS: 3000,
      filamentUsedG: 12.3
    },
    runCount: 1,
    file: { artifactId: "art_out", name: "cube.gcode", sha256: "a".repeat(64), sizeBytes: 1200 },
    source: { artifactId: "art_src", name: "cube.stl" },
    recipe: RECIPE,
    lineage: { reprintOf: null, previousTaskId: null, reprintedAs: [] },
    actions: {
      reprint: { allowed: true, code: null, reason: null, route: "variant" },
      retry: { allowed: false, code: "not_failed", reason: "только неудавшуюся" },
      reprepare: { artifactId: "art_src", printerId: "k2", profileSetId: "pset_1" }
    },
    ...over
  };
}

test("the main button: a finished print is printed again; a failed one is retried as the same job", () => {
  assert.deepEqual(primaryAction(entry()), { kind: "reprint", label: "Напечатать ещё раз" });
  const failed = entry({
    state: "FAILED",
    actions: { ...entry().actions, retry: { allowed: true, code: null, reason: null } }
  });
  assert.deepEqual(primaryAction(failed), { kind: "retry", label: "Повторить" });
  assert.deepEqual(
    secondaryActions(failed).map((a) => a.kind),
    ["reprint", "reprepare"],
    "a failed print can still be made a new print, or the model prepared anew"
  );
});

test("a deleted file: the way forward is preparing the model again, and the screen says why", () => {
  const gone = entry({
    actions: {
      reprint: { allowed: false, code: "file_deleted", reason: "файл «cube.gcode» удалён из хранилища — подготовьте модель заново", route: null },
      retry: { allowed: false, code: "not_failed", reason: null },
      reprepare: { artifactId: "art_src", printerId: "k2", profileSetId: "pset_1" }
    }
  });
  assert.deepEqual(primaryAction(gone), { kind: "reprepare", label: "Подготовить заново" });
  assert.match(blockedReason(gone), /удалён/);
  const html = entryHtml(gone, { open: new Set(["task_1"]) });
  assert.match(html, /data-hist-action="reprepare"/);
  assert.doesNotMatch(html, /data-hist-action="reprint"/);
  assert.match(html, /Как есть не напечатать: файл «cube\.gcode» удалён/);
});

test("nothing possible at all: no button pretends otherwise, and the reason is on the card", () => {
  const dead = entry({
    source: null,
    actions: {
      reprint: { allowed: false, code: "file_missing", reason: "файл этой печати не сохранился", route: null },
      retry: { allowed: false, code: "not_failed", reason: null },
      reprepare: null
    }
  });
  assert.equal(primaryAction(dead), null);
  assert.deepEqual(secondaryActions(dead), []);
  const html = entryHtml(dead);
  assert.doesNotMatch(html, /data-hist-action="(reprint|retry|reprepare)"/);
  assert.match(html, /не сохранился/);
});

test("the settings it was made with are listed as recorded, scale in words", () => {
  assert.deepEqual(recipeLines(entry()), [
    ["Рецепт", "K2 · PETG"],
    ["Профиль принтера", "K2"],
    ["Профиль печати", "0.2 @K2"],
    ["Филамент", "PETG @K2"],
    ["Масштаб", "1:1 (миллиметры)"],
    ["OrcaSlicer", "2.3.0"]
  ]);
  assert.equal(scaleText(10), "×10");
  assert.equal(scaleText(null), null);
  assert.deepEqual(recipeLines(entry({ recipe: null })), []);

  const html = detailsHtml(entry({ recipe: { ...RECIPE, profileSetUsable: false } }));
  assert.match(html, /K2 · PETG/);
  assert.match(html, /Рецепт больше не утверждён/);
  assert.match(html, /печать завершена/);
});

test("«подготовить заново» hands the wizard the model, printer, recipe and the print it repeats", () => {
  assert.deepEqual(reprepareSelection(entry()), {
    artifactId: "art_src",
    printerId: "k2",
    setId: "pset_1",
    previousTaskId: "task_1"
  });
  assert.equal(reprepareSelection(entry({ actions: { ...entry().actions, reprepare: null } })), null);
  assert.equal(launchPrinterFor(entry()), "k2");
  assert.equal(launchPrinterFor(entry({ run: null })), "k2", "the recipe's printer when it never ran");
});

test("the card shows where, when, how long and what; lineage when it is a repeat", () => {
  const html = entryHtml(
    entry({ lineage: { reprintOf: "task_0", previousTaskId: null, reprintedAs: ["task_2", "task_3"] }, runCount: 2 })
  );
  assert.match(html, /cube\.stl/);
  assert.match(html, /напечатано/);
  assert.match(html, /Creality K2/);
  assert.match(html, /50 м/);
  assert.match(html, /12\.3 г/);
  assert.match(html, /повтор/);
  assert.match(html, /напечатано ещё 2×/);
  assert.match(html, /попыток: 2/);
  assert.match(html, /data-hist-action="reprint" data-id="task_1"/);
});

test("the list: filters, an honest empty state, and «показать раньше» only when there is more", () => {
  const empty = historyHtml({ entries: [], filter: "", more: false, loading: false, error: null, busy: null, open: new Set() });
  assert.match(empty, /Завершённых печатей пока нет/);
  assert.match(empty, /data-hist-filter="COMPLETED"/);
  assert.doesNotMatch(empty, /data-hist-action="more"/);

  const filtered = historyHtml({ entries: [], filter: "FAILED", more: false, loading: false, error: null, busy: null, open: new Set() });
  assert.match(filtered, /Таких печатей ещё не было/);
  assert.match(filtered, /data-hist-filter="FAILED"\s+aria-pressed="true"/);

  const page = historyHtml({ entries: [entry()], filter: "", more: true, loading: false, error: null, busy: "task_1", open: new Set() });
  assert.match(page, /data-hist-action="more"/);
  assert.match(page, /Выполняю…/, "the busy card says it is working");
  assert.match(page, /data-hist-action="reprint"[^>]*disabled/);
});

test("the query carries the filter and the cursor, nothing else", () => {
  assert.equal(historyQuery(), "/api/print/history?limit=30");
  assert.equal(
    historyQuery({ state: "FAILED", cursor: "2026-10-14T10:00:00.000Z~task_1", limit: 10 }),
    "/api/print/history?limit=10&state=FAILED&cursor=2026-10-14T10%3A00%3A00.000Z%7Etask_1"
  );
});
