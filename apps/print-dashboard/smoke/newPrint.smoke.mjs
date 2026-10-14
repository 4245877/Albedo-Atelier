/* ── Browser smoke: «Новая печать» от файла до окна запуска ──────
   Проходит весь путь мастера в НАСТОЯЩЕМ браузере против mock-сервера:
   файл → принтер → рецепт (единственный — выбирается сам) → нарезка →
   «Это и печатаем» → окно запуска, открытое сразу на выбранном принтере.

   Проверяется то, чего не видит чистая функция: контроллер действительно
   ходит в те маршруты, что и остальные разделы, переходы шагов срабатывают от
   ответов сервера, а окно запуска получает выбранный принтер (`?printer=`).

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

const ISO = "2026-10-14T10:00:00.000Z";
const ready = (verdict, over = {}) => ({ state: "ready", verdict, warnings: [], blockers: [], ...over });

/** The farm as the wizard sees it: one STL, one K2 with one approved recipe. */
function farm() {
  const stl = {
    artifact: { id: "art_stl", name: "cube.stl", kind: "model", createdAt: ISO },
    task: { id: "task_stl", state: "DRAFT", title: "cube.stl" },
    analysis: ready("needs_preparation", { detectedFormat: "stl" }),
    status: { executable: false, next: { kind: "slice", label: "Нарезать", explanation: "Это модель", actionable: true, taskId: "task_stl" } }
  };
  const output = {
    artifact: { id: "art_out", name: "cube.gcode", kind: "gcode", createdAt: ISO },
    task: null,
    analysis: ready("schedulable", { detectedFormat: "gcode" }),
    status: { executable: true, next: { kind: "queued", explanation: "", taskId: null } }
  };
  const variant = {
    id: "slc_1",
    state: "ready",
    taskId: "task_stl",
    sourceArtifactId: "art_stl",
    profileSetId: "set_k2",
    targetPrinterId: "creality-k2",
    targetPrinterClass: null,
    outputArtifactId: "art_out",
    orcaEtaS: 3600,
    filamentG: 12.5,
    dimensions: { size: [20, 20, 20] },
    warnings: [],
    blockers: [],
    createdAt: ISO
  };
  return { stl, output, variant, sliced: false, promoted: false };
}

const version = await probeCdp();

test("«Новая печать»: файл → принтер → рецепт → нарезка → результат → окно запуска", { skip: version ? false : `no CDP browser at ${CDP_URL}` }, async () => {
  const f = farm();
  const mock = await startMockServer({
    api: {
      "/api/print/slicing/runtime": {
        runtime: { available: true },
        profileCounts: { active: 3, quarantined: 0, invalid: 0, total: 3 },
        missingParents: [],
        coverage: [{ printerId: "creality-k2", printerName: "Creality K2", model: "Creality K2", printerClass: null, hasAnyProfile: true, hasActiveProfile: true, activeProfileName: "K2" }]
      },
      "/api/print/slicing/profile-sets": {
        sets: [{ id: "set_k2", name: "K2 · PETG", approved: true, validation: "valid", printerId: "creality-k2", printerClass: null, warnings: [], blockers: [] }]
      }
    },
    handle: (req, key) => {
      if (req.method === "GET" && key === "/api/print/artifacts") {
        return { status: 200, body: { artifacts: f.sliced ? [f.output, f.stl] : [f.stl] } };
      }
      if (req.method === "GET" && key === "/api/print/slicing/variants") {
        return { status: 200, body: { variants: f.sliced ? [f.variant] : [] } };
      }
      if (req.method === "POST" && key === "/api/print/slicing/slice") {
        f.sliced = true;
        return { status: 200, body: { ok: true, variant: f.variant } };
      }
      if (req.method === "POST" && key === "/api/print/slicing/variants/slc_1/promote") {
        f.promoted = true;
        return { status: 200, body: { ok: true, task: { task: { id: "task_stl", state: "QUEUED" } } } };
      }
      if (req.method === "GET" && key === "/api/print/launch/task_stl") {
        return {
          status: 200,
          body: { preview: { taskId: "task_stl", candidates: [], recommendedPrinterId: null, confirmations: [], material: null } }
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
  const waitFor = async (expression, what) => {
    for (let i = 0; i < 120; i++) {
      if (await evalValue(expression)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  const click = (selector) => evalValue(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return Boolean(el); })()`);

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: mock.url });
    await waitFor("document.readyState === 'complete' && Boolean(document.querySelector('.mode-tab[data-mode=\"works\"]'))", "the mode switch");

    // «Работы» open on the new-print path, not on a settings section.
    await click('.mode-tab[data-mode="works"]');
    await waitFor("Boolean(document.querySelector('#newprint-body .np-steps'))", "the wizard steps");
    assert.equal(await evalValue("document.getElementById('newprint').hidden"), false);
    assert.equal(await evalValue("document.getElementById('uploads').hidden"), true);

    // 1 · file
    await waitFor("Boolean(document.querySelector('[data-np-action=\"pick-file\"]'))", "the file list");
    await click('[data-np-action="pick-file"][data-id="art_stl"]');
    // 2 · printer
    await waitFor("Boolean(document.querySelector('[data-np-action=\"pick-printer\"]'))", "the printer list");
    await click('[data-np-action="pick-printer"][data-id="creality-k2"]');
    // 3 · the only recipe is chosen for the operator → 4 · slice
    await waitFor("Boolean(document.querySelector('[data-np-action=\"slice\"]'))", "the slice button");
    await click('[data-np-action="slice"]');
    // 5 · result
    await waitFor("Boolean(document.querySelector('[data-np-action=\"promote\"]:not([disabled])'))", "the promote button");
    await click('[data-np-action="promote"]');
    // 6 · launch, with the printer chosen on step 2
    await waitFor("Boolean(document.querySelector('[data-np-action=\"launch\"]'))", "the launch step");
    await click('[data-np-action="launch"]');
    await waitFor("Boolean(document.querySelector('#modal-content'))", "the launch window");
    await new Promise((r) => setTimeout(r, 500));

    const slice = mock.requests.find((r) => r.method === "POST" && r.path === "/api/print/slicing/slice");
    assert.ok(slice, "the wizard sliced through the same API the slicing section uses");
    assert.ok(f.promoted, "and queued the verified result");
    const launch = mock.requests.find((r) => r.method === "GET" && r.path === "/api/print/launch/task_stl");
    assert.ok(launch, "the launch window loaded the task");
    assert.match(launch.query, /printer=creality-k2/, "with the printer chosen on the way");
    // No plan was built or confirmed for a manual print.
    assert.ok(!mock.requests.some((r) => r.path.startsWith("/api/print/scheduler/plans")), "no plan was involved");
    assert.deepEqual(cdp.exceptions, [], "no uncaught page errors");
  } finally {
    cdp.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
    await mock.close();
  }
});
