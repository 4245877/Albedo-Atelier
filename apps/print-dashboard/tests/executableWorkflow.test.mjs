/* ── Что интерфейс делает с уже готовым к печати файлом ─────────
   Единственный критерий, ради которого этот файл существует: у ЛЮБОГО принятого
   системой файла должно быть либо очевидное следующее действие, либо честное
   объяснение, почему печать невозможна. Зелёного успешного состояния без
   продолжения существовать не должно.

   До сих пор оно существовало ровно у половины входа: загруженный G-code и
   нарезанный .gcode.3mf получали вердикт «готово к планированию» — и ни одного
   элемента управления, который сдвинул бы их к принтеру. */

import assert from "node:assert/strict";
import test from "node:test";

import { itemHtml } from "../features/uploads/view.js";
import { queueJobStatus, queueRow } from "../render/sections.js";
import { taskModalHtml } from "../features/task/view.js";

/* Карточка загрузки в том виде, в каком её собирает контроллер: серверные
   `status.next` / `status.scale` / `status.review` — решение backend, здесь его
   только отрисовывают. */
function uploadItem(over = {}) {
  return {
    key: "art_1",
    name: "bracket.gcode",
    sizeBytes: 120_000,
    stage: "done",
    progress: 1,
    error: null,
    artifact: { id: "art_1", name: "bracket.gcode", sizeBytes: 120_000 },
    analysis: {
      state: "ready",
      verdict: "schedulable",
      detectedFormat: "gcode",
      warnings: [],
      blockers: [],
      data: {}
    },
    task: { id: "tsk_1", title: "bracket.gcode", state: "DRAFT", reason: null },
    deletionBlocker: null,
    blobExisted: false,
    status: {
      next: {
        kind: "enqueue",
        label: "Поставить в очередь",
        explanation: "Файл готов к печати. Поставьте его в очередь.",
        actionable: true,
        taskId: "tsk_1"
      },
      executable: true,
      scale: { required: false, units: null, scaleFactor: null, confirmedBy: null, confirmedAt: null, stale: false },
      review: { required: false, codes: [], confirmedBy: null, confirmedAt: null, note: null, stale: false, staleReason: null }
    },
    ...over
  };
}

test("готовый к печати файл получает действие «Поставить в очередь»", () => {
  const html = itemHtml(uploadItem());
  assert.match(html, /data-enqueue="art_1"/, "кнопка есть и указывает на артефакт");
  assert.match(html, /Поставить в очередь/);
  assert.match(html, /Файл готов к печати/, "и объясняет, что произойдёт");
});

test("нарезанный 3MF сначала просит прочитать причину проверки", () => {
  const html = itemHtml(
    uploadItem({
      name: "bracket.gcode.3mf",
      analysis: {
        state: "ready",
        verdict: "review",
        detectedFormat: "3mf",
        warnings: [{ code: "threemf_sliced_payload", message: "Файл уже нарезан для «Bambu Lab A1»" }],
        blockers: [],
        data: { threeMfClass: "sliced" }
      },
      status: {
        ...uploadItem().status,
        next: {
          kind: "confirm_review",
          label: "Прочитать и подтвердить",
          explanation: "Файл уже нарезан, но его параметры заданы чужим профилем печати.",
          actionable: true,
          taskId: "tsk_1"
        },
        review: {
          required: true,
          codes: ["threemf_sliced_payload"],
          confirmedBy: null,
          confirmedAt: null,
          note: null,
          stale: false,
          staleReason: null
        }
      }
    })
  );
  assert.match(html, /data-confirm-review="art_1"/);
  assert.doesNotMatch(html, /data-enqueue/, "в очередь — только после подтверждения");
  assert.match(html, /чужим профилем/, "и причина названа, а не спрятана");
});

test("подтверждённая проверка называет, кто именно её принял", () => {
  const base = uploadItem();
  const html = itemHtml({
    ...base,
    status: {
      ...base.status,
      review: {
        required: false,
        codes: [],
        confirmedBy: "мастер",
        confirmedAt: "2026-08-14T12:00:00.000Z",
        note: "профиль сверил",
        stale: false,
        staleReason: null
      }
    }
  });
  assert.match(html, /Проверку подтвердил мастер/);
  assert.match(html, /профиль сверил/);
});

test("STL просит подтвердить единицы, а не молча считается миллиметровым", () => {
  const base = uploadItem();
  const html = itemHtml({
    ...base,
    name: "bracket.stl",
    analysis: { ...base.analysis, verdict: "needs_preparation", detectedFormat: "stl" },
    status: {
      ...base.status,
      executable: false,
      next: {
        kind: "confirm_scale",
        label: "Подтвердить единицы",
        explanation: "STL не хранит единицы измерения, поэтому габариты пока недоказуемы.",
        actionable: true,
        taskId: "tsk_1"
      },
      scale: { required: true, units: null, scaleFactor: null, confirmedBy: null, confirmedAt: null, stale: false }
    }
  });
  assert.match(html, /data-confirm-scale="art_1"/);
  assert.match(html, /не хранит единицы/);
});

test("файл, который печатать нельзя, объясняет причину и не показывает кнопку", () => {
  const base = uploadItem();
  const html = itemHtml({
    ...base,
    status: {
      ...base.status,
      next: {
        kind: "blocked",
        label: "",
        explanation: "Печать этого файла невозможна: в архиве нет 3D-модели",
        actionable: false,
        taskId: "tsk_1"
      }
    }
  });
  assert.match(html, /Печать этого файла невозможна/);
  assert.doesNotMatch(html, /data-enqueue|data-confirm-review|data-confirm-scale/);
  assert.match(html, /is-inert/, "блок без действия оформлен как объяснение, а не как кнопка");
});

/* ── Очередь: готовность вместо «QUEUED значит готово» ────────── */

test("строка очереди говорит, на чём можно запустить, а не что она QUEUED", () => {
  const st = queueJobStatus(
    { id: "tsk_1", title: "bracket", status: "ready", reason: "" },
    { taskId: "tsk_1", state: "ready", summary: "Можно запустить на «Bambu Lab A1»", canLaunch: true }
  );
  assert.equal(st.blocked, false);
  assert.equal(st.detail, "Можно запустить на «Bambu Lab A1»");
});

test("QUEUED без пригодного принтера больше не показывается готовым", () => {
  const st = queueJobStatus(
    { id: "tsk_1", title: "bracket", status: "ready", reason: "" },
    {
      taskId: "tsk_1",
      state: "blocked",
      summary: "Принтер занят (Bambu Lab A1)",
      canLaunch: false,
      primaryProblem: { code: "PRINTER_BUSY", title: "Принтер занят", action: "…" }
    }
  );
  assert.equal(st.blocked, true);
  assert.equal(st.key, "blocked");
  assert.match(st.reason, /Принтер занят/);
});

test("готовность спросили и не получили — строка говорит «неизвестно», а не «готово»", () => {
  /* Отказ /api/print/launch раньше возвращал строку к прежней логике по двум
     колонкам БД: QUEUED + WAITING снова читались как «готово к запуску». То
     есть чем хуже отвечал сервер, тем увереннее доска утверждала, что печатать
     можно — ровно то обещание, ради снятия которого готовность и появилась. */
  const st = queueJobStatus(
    { id: "tsk_9", title: "bracket", status: "ready", reason: "" },
    null,
    true
  );
  assert.equal(st.key, "unknown");
  assert.notEqual(st.badge, "badge-idle", "зелёного «готово» здесь быть не может");
  assert.match(st.label, /готовность неизвестна/);
  assert.match(st.detail, /не ответил/);
  assert.match(st.actionLabel, /Проверить/);
});

test("готовность просто ещё не пришла — прежнее поведение сохраняется", () => {
  // Отличие от отказа: никто не спрашивал (первый тик, старый payload).
  const st = queueJobStatus({ id: "tsk_9", title: "bracket", status: "ready", reason: "" }, null, false);
  assert.equal(st.key, "ready");
  assert.equal(st.badge, "badge-idle");
});

test("кнопка запуска есть у каждой строки, а не только у первой", () => {
  const html = queueRow(
    { id: "tsk_7", title: "bracket", status: "ready", reason: "" },
    [],
    { taskId: "tsk_7", state: "ready", summary: "Можно запустить на «K2»", canLaunch: true }
  );
  assert.match(html, /data-act="launch" data-task="tsk_7"/);
  // И название ведёт в карточку задания — ответ на «почему не печатает».
  assert.match(html, /data-act="task" data-task="tsk_7"/);
});

/* ── Карточка задания ────────────────────────────────────────── */

const CHAIN = {
  task: {
    id: "tsk_1",
    title: "bracket.gcode",
    state: "QUEUED",
    material: "PETG",
    pinnedPrinterId: null,
    onDeviceFile: "bracket-2e515f1e.gcode"
  },
  artifact: { id: "art_1", name: "bracket.gcode", sizeBytes: 120_000, sha256: "a".repeat(64) },
  sourceArtifact: null,
  analyses: [
    {
      state: "ready",
      verdict: "schedulable",
      detectedFormat: "gcode",
      material: "PETG",
      nozzleDiameterMm: 0.4,
      estimatedDurationS: 5329,
      warnings: [],
      blockers: []
    }
  ],
  sliceVariants: [],
  queueEntry: { state: "WAITING", position: 10, enqueuedAt: "2026-08-14T12:00:00.000Z" },
  assignments: [],
  deviceArtifacts: [],
  dispatchAttempts: [],
  printRuns: [],
  manualOperations: [],
  audit: [{ at: "2026-08-14T12:00:00.000Z", action: "executable_enqueued", actor: "operator" }]
};

test("карточка задания показывает всю цепочку, включая непройденные звенья", () => {
  const html = taskModalHtml(CHAIN, {
    taskId: "tsk_1",
    state: "ready",
    summary: "Можно запустить на «Bambu Lab A1»",
    canLaunch: true,
    primaryProblem: null
  });

  for (const step of ["Файл", "Анализ", "Слайсинг", "Очередь", "Назначение", "Доставка файла", "Попытки запуска", "Печать"]) {
    assert.match(html, new RegExp(step), `звено «${step}» видно`);
  }
  // Непройденные звенья говорят именно это, а не молчат: «доставки не было» —
  // такой же ответ на «почему не печатает», как и любой другой.
  assert.match(html, /файл на принтер не передавался/);
  assert.match(html, /запуск не отправлялся/);
  assert.match(html, /не требовался — файл уже исполнимый/);
  assert.match(html, /Можно запустить/);
  assert.match(html, /data-task-launch/);
});

test("карточка задания показывает причину отказа и не предлагает запуск", () => {
  const html = taskModalHtml(CHAIN, {
    taskId: "tsk_1",
    state: "blocked",
    summary: "Файл собран для другого принтера (Creality K2)",
    canLaunch: false,
    primaryProblem: {
      code: "TARGET_PRINTER_MISMATCH",
      title: "Файл собран для другого принтера",
      action: "Выберите тот принтер, для которого файл нарезан."
    }
  });
  assert.match(html, /Файл собран для другого принтера/);
  assert.match(html, /Выберите тот принтер/, "и что с этим делать");
  assert.doesNotMatch(html, /data-task-launch/, "запуск, который заведомо откажет, не предлагается");
});
