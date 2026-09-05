/* ── Browser smoke: удаление файла в разделе «Загрузка и анализ» ──
   Проверяет в НАСТОЯЩЕМ браузере цепочку, которую чистые функции не покрывают:
   карточка файла → кнопка удаления → окно подтверждения → DELETE на backend →
   карточка исчезает из списка немедленно, без перезагрузки страницы.

   И обратную сторону: файл, который backend объявил занятым, кнопки не даёт
   вовсе — причина отказа читается в подсказке, а запроса не происходит.

   Как и остальные smoke-тесты, работает через CDP без Playwright/Puppeteer и
   SKIP-ается, когда браузера нет (CHROME_CDP_URL, по умолчанию :9222). */
import assert from "node:assert/strict";
import test from "node:test";

import { startMockServer } from "./mockServer.mjs";

const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";

async function probeCdp() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const exceptions = [];
  let seq = 0;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      exceptions.push(d?.exception?.description || d?.text || "uncaught exception");
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  return { send, exceptions, close: () => ws.close() };
}

/** Один готовый артефакт в форме, которую отдаёт GET /api/print/artifacts. */
const row = (id, name, deletionBlocker, deletionCascade = null) => ({
  artifact: { id, name, kind: "gcode", sizeBytes: 2048, sha256: `sha-${id}`, metadata: {} },
  task: { id: `task-${id}`, title: name, state: "DRAFT", reason: null },
  analysis: {
    id: `an-${id}`,
    state: "ready",
    detectedFormat: "gcode",
    verdict: "schedulable",
    warnings: [],
    blockers: [],
    material: "PLA",
    data: {}
  },
  deletionBlocker,
  deletionCascade
});

/* Занятость, которую сервер снять не может: печать идёт прямо сейчас. Именно
   такой отказ и оставляет кнопку погашенной — задание в очереди backend теперь
   предлагает отменить вместе с файлом (см. третий тест). */
const BLOCKER = "активная печать run_7 (RUNNING) использует файл";

/* А это — занятость, которую снимает каскад: держит только строка планировщика. */
const QUEUED_BLOCKER = "задание «Кронштейн» в состоянии QUEUED использует файл";
const QUEUED_CASCADE = [{ id: "task-art_q", title: "Кронштейн", state: "QUEUED" }];

const version = await probeCdp();

test("удаление файла: подтверждение, запрос на backend, карточка исчезает", { skip: version ? false : `no CDP browser at ${CDP_URL}` }, async () => {
  // Состояние живёт в моке: после успешного DELETE список отдаёт уже без файла,
  // как настоящий backend — интерфейс не должен зависеть от повторного чтения,
  // но и расходиться с сервером тоже не должен.
  let artifacts = [row("art_free", "free.gcode", null), row("art_busy", "busy.gcode", BLOCKER)];
  const mock = await startMockServer({
    handle: (req, key) => {
      if (key === "/api/print/artifacts" && req.method === "GET") {
        return { status: 200, body: { artifacts } };
      }
      if (req.method === "DELETE" && key === "/api/print/artifacts/art_free") {
        artifacts = artifacts.filter((r) => r.artifact.id !== "art_free");
        return {
          status: 200,
          body: { ok: true, artifactId: "art_free", blobKey: "sha256/ab/cd", blobRemoved: true, removedSliceVariants: [] }
        };
      }
      return null;
    }
  });

  const target = await (await fetch(`${CDP_URL}/json/new?${encodeURIComponent(mock.url)}`, { method: "PUT" })).json();
  const cdp = await connect(target.webSocketDebuggerUrl);

  const evalValue = async (expression) => {
    const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.value;
  };
  const until = async (expression, what) => {
    for (let i = 0; i < 80; i++) {
      if (await evalValue(expression)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: mock.url });

    // Раздел «Загрузка» поднимается лениво, при первом открытии «Работ». Ждём не
    // появления кнопки в статической разметке, а того, что её обработчик уже
    // висит: вкладки Работ рисует сам скрипт, так что их наличие и есть признак
    // «приложение стартовало» — клик по кнопке из ещё не оживлённой страницы
    // молча ничего бы не сделал.
    await until('document.querySelectorAll("#worknav .work-tab").length > 0', "the app to boot");
    await evalValue('document.querySelector(\'.mode-tab[data-mode="works"]\').click(), 1');
    await until('document.getElementById("mode-works") && !document.getElementById("mode-works").hidden', "the works mode");
    await until("document.querySelectorAll('#upload-list .upload-item').length === 2", "both file cards");

    // ── Занятый файл кнопки не даёт, а причину показывает ──
    const busyBtn = await evalValue(
      `(() => {
         const li = document.querySelector('[data-upload="art_busy"]');
         const btn = li && li.querySelector('.upload-head-side button');
         return btn ? { disabled: btn.disabled, title: btn.title, deletes: btn.hasAttribute('data-delete-artifact') } : null;
       })()`
    );
    assert.ok(busyBtn, "the busy file should still render its (disabled) control");
    assert.equal(busyBtn.disabled, true, "a file in use must not offer deletion");
    assert.equal(busyBtn.deletes, false, "and must carry no delete handle at all");
    assert.match(busyBtn.title, /run_7/, "the refusal reason belongs in the tooltip");

    // ── Свободный файл: клик открывает подтверждение, называющее файл ──
    await evalValue("document.querySelector('[data-delete-artifact=\"art_free\"]').click(), 1");
    await until("Boolean(document.querySelector('.modal-confirm'))", "the confirmation dialog");
    const dialogText = await evalValue("document.querySelector('.modal-confirm').textContent");
    assert.match(dialogText, /free\.gcode/, "the dialog must name the file being deleted");
    assert.match(dialogText, /необратимо/i, "and say the action cannot be undone");

    // Пока оператор не подтвердил — на backend не ушло ничего.
    assert.equal(
      mock.requests.filter((r) => r.method === "DELETE").length,
      0,
      "opening the dialog must not delete anything"
    );

    await evalValue("document.querySelector('[data-confirm-yes]').click(), 1");

    // ── Карточка уходит из списка сразу после успешного ответа ──
    await until('!document.querySelector(\'[data-upload="art_free"]\')', "the card to disappear");
    const remaining = await evalValue("document.querySelectorAll('#upload-list .upload-item').length");
    assert.equal(remaining, 1, "only the busy file is left");
    const stillBusy = await evalValue('Boolean(document.querySelector(\'[data-upload="art_busy"]\'))');
    assert.equal(stillBusy, true, "the other file is untouched");

    const deletes = mock.requests.filter((r) => r.method === "DELETE");
    assert.deepEqual(
      deletes.map((r) => r.path),
      ["/api/print/artifacts/art_free"],
      "exactly one DELETE, for exactly the file the operator confirmed"
    );

    assert.deepEqual(cdp.exceptions, [], "there should be no uncaught page errors");
  } finally {
    cdp.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
    await mock.close();
  }
});

/*
 * Состояние, которое сервер видит, а вкладка — ещё нет.
 *
 * Список файлов (и вместе с ним причина отказа) читается один раз при открытии
 * страницы: поллер работает только пока идёт анализ. Без сверки освободившийся
 * файл навсегда оставался бы с погашенной кнопкой, а файл, удалённый в соседней
 * вкладке, — в списке до перезагрузки. Оба случая проверяются здесь на живой
 * странице: возврат вкладки на передний план обязан сверить список с сервером,
 * а DELETE, отвечающий 404, — убрать карточку, а не показать ошибку.
 */
test("вкладка вернулась: список сверяется с сервером, а 404 при удалении — не ошибка", { skip: version ? false : `no CDP browser at ${CDP_URL}` }, async () => {
  // Начинаем с занятого файла и файла, которого на сервере уже нет к моменту
  // подтверждения (его удалили «в другой вкладке»).
  let artifacts = [row("art_a", "a.gcode", BLOCKER), row("art_b", "b.gcode", null)];
  const mock = await startMockServer({
    handle: (req, key) => {
      if (key === "/api/print/artifacts" && req.method === "GET") {
        return { status: 200, body: { artifacts } };
      }
      if (req.method === "DELETE" && key === "/api/print/artifacts/art_b") {
        // Файл уже удалён другой вкладкой — ровно то, что вернёт настоящий backend.
        return {
          status: 404,
          body: { error: { code: "NOT_FOUND", message: "Артефакт «art_b» not found", details: null } }
        };
      }
      return null;
    }
  });

  const target = await (await fetch(`${CDP_URL}/json/new?${encodeURIComponent(mock.url)}`, { method: "PUT" })).json();
  const cdp = await connect(target.webSocketDebuggerUrl);

  const evalValue = async (expression) => {
    const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.value;
  };
  const until = async (expression, what) => {
    for (let i = 0; i < 80; i++) {
      if (await evalValue(expression)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timeout waiting for ${what}`);
  };
  const deleteBtn = (id) =>
    `(() => {
       const li = document.querySelector('[data-upload="${id}"]');
       const btn = li && li.querySelector('.upload-head-side button');
       return btn ? { disabled: btn.disabled, deletes: btn.hasAttribute('data-delete-artifact') } : null;
     })()`;

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: mock.url });
    await until('document.querySelectorAll("#worknav .work-tab").length > 0', "the app to boot");
    await evalValue('document.querySelector(\'.mode-tab[data-mode="works"]\').click(), 1');
    await until('document.getElementById("mode-works") && !document.getElementById("mode-works").hidden', "the works mode");
    await until("document.querySelectorAll('#upload-list .upload-item').length === 2", "both file cards");

    assert.deepEqual(await evalValue(deleteBtn("art_a")), { disabled: true, deletes: false }, "the busy file starts blocked");

    // ── Печать закончилась: сервер отдаёт файл свободным ──
    artifacts = [row("art_a", "a.gcode", null), row("art_b", "b.gcode", null)];
    await evalValue('document.dispatchEvent(new Event("visibilitychange")), 1');
    await until(`(${deleteBtn("art_a")}).disabled === false`, "the freed file to regain its button");
    assert.deepEqual(
      await evalValue(deleteBtn("art_a")),
      { disabled: false, deletes: true },
      "a file the server now calls free must be deletable without a page reload"
    );

    // ── Файл удалён в другой вкладке: DELETE отвечает 404 ──
    artifacts = artifacts.filter((r) => r.artifact.id !== "art_b");
    await evalValue("document.querySelector('[data-delete-artifact=\"art_b\"]').click(), 1");
    await until("Boolean(document.querySelector('.modal-confirm'))", "the confirmation dialog");
    await evalValue("document.querySelector('[data-confirm-yes]').click(), 1");

    await until('!document.querySelector(\'[data-upload="art_b"]\')', "the card to disappear on a 404");
    const errorShown = await evalValue("Boolean(document.querySelector('.modal-confirm'))");
    assert.equal(errorShown, false, "a file that is already gone is not an error to show");

    assert.deepEqual(cdp.exceptions, [], "there should be no uncaught page errors");
  } finally {
    cdp.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
    await mock.close();
  }
});

/*
 * Каскад: файл, который держит только строка планировщика.
 *
 * Раньше это был тупик — backend отвечал 409 «его использует задание QUEUED», а
 * убрать само задание из раздела файлов было нечем: кнопка гасла, и оператор
 * оставался с файлом, который не удаляется. Теперь сервер присылает вместе со
 * списком (`deletionCascade`) те задания, которые готов отменить вместе с
 * файлом, и здесь проверяется вся цепочка на живой странице: кнопка активна,
 * окно называет задание ПОИМЁННО (согласие даётся на отмену печати, а не только
 * на удаление байтов), а на backend уходит ровно один DELETE — с флагом
 * каскада, а не два отдельных запроса, второй из которых мог бы не дойти.
 */
test("каскад: кнопка жива, окно называет задание, DELETE уходит с ?cascade=true", { skip: version ? false : `no CDP browser at ${CDP_URL}` }, async () => {
  let artifacts = [row("art_q", "3U-default.3mf", QUEUED_BLOCKER, QUEUED_CASCADE)];
  const mock = await startMockServer({
    handle: (req, key) => {
      if (key === "/api/print/artifacts" && req.method === "GET") {
        return { status: 200, body: { artifacts } };
      }
      if (req.method === "DELETE" && key === "/api/print/artifacts/art_q") {
        artifacts = [];
        return {
          status: 200,
          body: {
            ok: true,
            artifactId: "art_q",
            blobKey: "sha256/ab/cd",
            blobRemoved: true,
            removedSliceVariants: [],
            cancelledTasks: ["task-art_q"]
          }
        };
      }
      return null;
    }
  });

  const target = await (await fetch(`${CDP_URL}/json/new?${encodeURIComponent(mock.url)}`, { method: "PUT" })).json();
  const cdp = await connect(target.webSocketDebuggerUrl);

  const evalValue = async (expression) => {
    const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.value;
  };
  const until = async (expression, what) => {
    for (let i = 0; i < 80; i++) {
      if (await evalValue(expression)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: mock.url });
    await until('document.querySelectorAll("#worknav .work-tab").length > 0', "the app to boot");
    await evalValue('document.querySelector(\'.mode-tab[data-mode="works"]\').click(), 1');
    await until('document.getElementById("mode-works") && !document.getElementById("mode-works").hidden', "the works mode");
    await until("document.querySelectorAll('#upload-list .upload-item').length === 1", "the file card");

    // ── Занятый очередью файл кнопку ДАЁТ, и подсказка обещает отмену ──
    const btn = await evalValue(
      `(() => {
         const li = document.querySelector('[data-upload="art_q"]');
         const b = li && li.querySelector('.upload-head-side button');
         return b ? { disabled: b.disabled, title: b.title, deletes: b.hasAttribute('data-delete-artifact') } : null;
       })()`
    );
    assert.ok(btn, "the card must render its control");
    assert.equal(btn.disabled, false, "a file held only by the scheduler must stay deletable");
    assert.equal(btn.deletes, true, "and carry the delete handle");
    assert.match(btn.title, /отменить задание «Кронштейн»/, "the tooltip promises the cancellation");

    // ── Окно подтверждения называет задание, а не только файл ──
    await evalValue("document.querySelector('[data-delete-artifact=\"art_q\"]').click(), 1");
    await until("Boolean(document.querySelector('.modal-confirm'))", "the confirmation dialog");
    const dialogText = await evalValue("document.querySelector('.modal-confirm').textContent");
    assert.match(dialogText, /3U-default\.3mf/, "the dialog names the file");
    assert.match(dialogText, /Кронштейн/, "and the task it is about to cancel");
    assert.match(dialogText, /отменено/, "in the words of what will happen to it");

    assert.equal(
      mock.requests.filter((r) => r.method === "DELETE").length,
      0,
      "opening the dialog must not cancel anything"
    );

    await evalValue("document.querySelector('[data-confirm-yes]').click(), 1");
    await until('!document.querySelector(\'[data-upload="art_q"]\')', "the card to disappear");

    // Один запрос, с флагом — не «удалить файл», а потом «отменить задание».
    assert.deepEqual(
      mock.requests.filter((r) => r.method === "DELETE").map((r) => r.path + (r.query ? `?${r.query}` : "")),
      ["/api/print/artifacts/art_q?cascade=true"],
      "exactly one DELETE, carrying the cascade the operator agreed to"
    );

    assert.deepEqual(cdp.exceptions, [], "there should be no uncaught page errors");
  } finally {
    cdp.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
    await mock.close();
  }
});
