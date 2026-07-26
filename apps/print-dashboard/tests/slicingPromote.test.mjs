import assert from "node:assert/strict";
import { test } from "node:test";

import { executionHtml, variantsHtml } from "../features/slicing/view.js";

/*
 * The slice → queue → execution surface. These are pure `(state) → HTML`
 * functions, so the rendering rules the operator depends on are testable
 * without a browser:
 *
 *   - "Добавить в очередь" appears ONLY for a variant the server would accept;
 *   - a promoted variant shows its queue state instead of the button (so the
 *     state survives a page reload — it is read from the server, not remembered
 *     in the DOM);
 *   - the execution panel never hides the difference between "запланировано",
 *     "файл готов" and "разрешено к запуску".
 */

const READY_VARIANT = {
  id: "slc_1",
  state: "ready",
  sourceArtifactId: "art_src",
  profileSetId: "pset_1",
  targetPrinterId: "k2",
  targetPrinterClass: null,
  outputArtifactId: "art_out",
  orcaEtaS: 3600,
  filamentG: 20,
  dimensions: { size: [100, 100, 100] },
  warnings: [],
  blockers: [],
  updatedAt: "2026-07-26T12:00:00.000Z"
};

const OUTPUT_OK = {
  artifact: { id: "art_out", name: "cube.gcode", kind: "gcode", sizeBytes: 2048 },
  analysis: {
    state: "ready",
    verdict: "schedulable",
    material: "PLA",
    nozzleDiameterMm: 0.4,
    warnings: [],
    blockers: []
  }
};

function baseState(over = {}) {
  return {
    runtime: { coverage: [{ printerId: "k2", printerName: "Creality K2" }] },
    profiles: [],
    sets: [{ id: "pset_1", name: "K2 · PLA", approved: true }],
    variants: [READY_VARIANT],
    models: [{ artifact: { id: "art_src", name: "cube.stl" } }],
    outputs: [OUTPUT_OK],
    tasks: [],
    assignments: [],
    errors: [],
    ...over
  };
}

test("a ready, analysed variant offers «Добавить в очередь» with the facts behind the decision", () => {
  const html = variantsHtml(baseState());

  assert.match(html, /data-slice-action="promote"/);
  assert.doesNotMatch(html, /data-slice-action="promote"[^>]*disabled/);
  assert.match(html, /Добавить в очередь/);
  // The operator sees WHAT would be queued, not just a button.
  assert.match(html, /Материал: PLA/);
  assert.match(html, /Сопло: 0\.4 мм/);
  assert.match(html, /Размер файла: 2 КБ/);
  assert.match(html, /анализ G-code: пройден/);
  assert.match(html, /Время печати \(по OrcaSlicer\)/);
  assert.match(html, /Creality K2/);
});

test("a variant whose output analysis is not schedulable cannot be promoted, and says why", () => {
  const html = variantsHtml(
    baseState({
      outputs: [
        {
          ...OUTPUT_OK,
          analysis: {
            state: "ready",
            verdict: "blocked",
            warnings: [],
            blockers: [{ code: "forbidden_command", message: "M502 в start G-code" }]
          }
        }
      ]
    })
  );

  assert.match(html, /data-slice-action="promote"[^>]*disabled/);
  assert.match(html, /анализ G-code: blocked/);
  // The concrete reason is shown — never a bare "что-то пошло не так".
  assert.match(html, /M502 в start G-code/);
});

test("an unfinished variant offers no promotion at all", () => {
  const html = variantsHtml(
    baseState({ variants: [{ ...READY_VARIANT, state: "running", outputArtifactId: null }] })
  );
  assert.doesNotMatch(html, /data-slice-action="promote"/);
});

test("a promoted variant shows its queue state and a way to the queue (state survives a reload)", () => {
  const html = variantsHtml(
    baseState({
      tasks: [
        {
          id: "task_1",
          title: "cube.stl",
          state: "QUEUED",
          sliceVariantId: "slc_1",
          onDeviceFile: "cube.gcode"
        }
      ]
    })
  );

  // The button is gone precisely because the SERVER says it is already queued —
  // a reload re-renders the same thing, and a second click cannot duplicate it.
  assert.doesNotMatch(html, /data-slice-action="promote"/);
  assert.match(html, /в очереди: QUEUED/);
  assert.match(html, /cube\.gcode/);
  assert.match(html, /data-goto="scheduler"/);
});

test("execution: a prepared file offers a start; the stages stay visibly distinct", () => {
  const html = executionHtml(
    baseState({
      tasks: [{ id: "task_1", title: "cube.stl", state: "QUEUED", sliceVariantId: "slc_1" }],
      assignments: [
        {
          assignment: {
            id: "asg_1",
            taskId: "task_1",
            printerId: "k2",
            state: "PROPOSED",
            source: "manual",
            invalidatedAt: null,
            invalidatedReason: null,
            binding: {
              expectedRemotePath: "cube.gcode",
              material: "PLA",
              nozzleMm: 0.4,
              etaS: 3600
            }
          },
          deviceArtifact: {
            state: "VERIFIED",
            transferMode: "adapter_upload",
            verification: "name_and_size",
            remotePath: "cube.gcode",
            lastError: null
          },
          fileReady: true,
          nextAction: "start"
        }
      ]
    })
  );

  assert.match(html, /Исполнение/);
  assert.match(html, /data-slice-action="start-assignment"/);
  assert.match(html, /файл сверен/);
  // The verification METHOD is shown, so "проверено" is never mistaken for a hash check.
  assert.match(html, /проверка: name_and_size/);
  assert.match(html, /PROPOSED/, "«запланировано» stays distinct from «запущено»");
});

test("execution: an adapter without upload demands a manual transfer, not a start", () => {
  const html = executionHtml(
    baseState({
      tasks: [{ id: "task_1", title: "cube.stl", state: "QUEUED", sliceVariantId: "slc_1" }],
      assignments: [
        {
          assignment: {
            id: "asg_2",
            taskId: "task_1",
            printerId: "x1c",
            state: "PROPOSED",
            source: "manual",
            invalidatedAt: null,
            invalidatedReason: null,
            binding: { expectedRemotePath: "cube.gcode", material: "PLA", nozzleMm: 0.4, etaS: 3600 }
          },
          deviceArtifact: {
            state: "NOT_PRESENT",
            transferMode: "manual_file_transfer",
            verification: null,
            remotePath: "cube.gcode",
            lastError: null
          },
          fileReady: false,
          nextAction: "confirm-file"
        }
      ]
    })
  );

  assert.doesNotMatch(html, /data-slice-action="start-assignment"/);
  assert.match(html, /data-slice-action="confirm-file"/);
  assert.match(html, /не умеет загружать файлы/);
  assert.match(html, /cube\.gcode/, "the exact path the operator must copy to");
});

test("execution: an invalidated assignment offers no action and demands a replan", () => {
  const html = executionHtml(
    baseState({
      tasks: [{ id: "task_1", title: "cube.stl", state: "QUEUED", sliceVariantId: "slc_1" }],
      assignments: [
        {
          assignment: {
            id: "asg_3",
            taskId: "task_1",
            printerId: "k2",
            state: "PROPOSED",
            source: "plan",
            invalidatedAt: "2026-07-26T13:00:00.000Z",
            invalidatedReason: "изменены параметры планирования",
            binding: { expectedRemotePath: "cube.gcode", material: "PLA", nozzleMm: 0.4, etaS: 3600 }
          },
          deviceArtifact: null,
          fileReady: false,
          nextAction: "replan"
        }
      ]
    })
  );

  assert.doesNotMatch(html, /data-slice-action="start-assignment"/);
  assert.doesNotMatch(html, /data-slice-action="prepare-file"/);
  assert.match(html, /Назначение устарело/);
  assert.match(html, /Требуется перепланирование/);
});
