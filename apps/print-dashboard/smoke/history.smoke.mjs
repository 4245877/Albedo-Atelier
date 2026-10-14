/* ── Browser smoke: «История печати» ─────────────────────────────
   В НАСТОЯЩЕМ браузере против mock-сервера: вкладка «История» → запись
   завершённой печати с её настройками → «Напечатать ещё раз» (POST reprint с
   requestId) → окно запуска новой печати сразу на прежнем принтере; фильтр
   «Не удалось» уходит на сервер; «Подготовить заново» открывает мастер с
   моделью, принтером и рецептом той печати.

   Работает через CDP без Playwright/Puppeteer и SKIP-ается, когда браузера
   нет (CHROME_CDP_URL, по умолчанию :9222). */
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

function historyEntry(over) {
  return {
    taskId: "task_done",
    title: "cube.stl",
    state: "COMPLETED",
    reason: null,
    createdAt: ISO,
    closedAt: ISO,
    material: "PETG",
    run: { id: "run_1", printerId: "creality-k2", printerName: "Creality K2", state: "SUCCEEDED", startedAt: ISO, endedAt: ISO, durationS: 3000, filamentUsedG: 12 },
    runCount: 1,
    file: { artifactId: "art_out", name: "cube.gcode", sha256: "a".repeat(64), sizeBytes: 1200 },
    source: { artifactId: "art_stl", name: "cube.stl" },
    recipe: {
      variantId: "slc_1",
      profileSetId: "set_k2",
      profileSetName: "K2 · PETG",
      profileSetUsable: true,
      machine: "K2",
      process: "0.2 @K2",
      filament: "PETG @K2",
      targetPrinterId: "creality-k2",
      targetPrinterClass: null,
      scaleFactor: 1,
      orcaVersion: "2.3.0",
      etaS: 3500,
      filamentG: 11
    },
    lineage: { reprintOf: null, previousTaskId: null, reprintedAs: [] },
    actions: {
      reprint: { allowed: true, code: null, reason: null, route: "variant" },
      retry: { allowed: false, code: "not_failed", reason: null },
      reprepare: { artifactId: "art_stl", printerId: "creality-k2", profileSetId: "set_k2" }
    },
    ...over
  };
}

const GONE = historyEntry({
  taskId: "task_gone",
  title: "old.stl",
  actions: {
    reprint: { allowed: false, code: "file_deleted", reason: "файл удалён из хранилища — подготовьте модель заново", route: null },
    retry: { allowed: false, code: "not_failed", reason: null },
    reprepare: { artifactId: "art_stl", printerId: "creality-k2", profileSetId: "set_k2" }
  }
});

const version = await probeCdp();

test("«История»: запись с настройками → «Напечатать ещё раз» → окно запуска; фильтр; «Подготовить заново»", { skip: version ? false : `no CDP browser at ${CDP_URL}` }, async () => {
  const reprints = [];
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
      },
      "/api/print/slicing/variants": { variants: [] },
      "/api/print/artifacts": {
        artifacts: [
          {
            artifact: { id: "art_stl", name: "cube.stl", kind: "model", createdAt: ISO },
            task: { id: "task_stl", state: "DRAFT", title: "cube.stl" },
            analysis: { state: "ready", verdict: "needs_preparation", detectedFormat: "stl", warnings: [], blockers: [] },
            status: { executable: false, next: { kind: "slice", explanation: "Это модель", taskId: "task_stl" } }
          }
        ]
      }
    },
    handle: (req, key) => {
      if (req.method === "GET" && key === "/api/print/history") {
        return { status: 200, body: { entries: [historyEntry({}), GONE], nextCursor: null } };
      }
      if (req.method === "POST" && key === "/api/print/tasks/task_done/reprint") {
        reprints.push(key);
        return { status: 200, body: { ok: true, route: "variant", deduplicated: false, task: { task: { id: "task_new", state: "QUEUED" } } } };
      }
      if (req.method === "GET" && key === "/api/print/launch/task_new") {
        return { status: 200, body: { preview: { taskId: "task_new", candidates: [], recommendedPrinterId: null, confirmations: [], material: null } } };
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
    await click('.mode-tab[data-mode="works"]');
    await waitFor("Boolean(document.querySelector('[data-work-tab=\"history\"]'))", "the history tab");
    await click('[data-work-tab="history"]');

    // The finished print, with where and what.
    await waitFor("Boolean(document.querySelector('#history-body [data-hist-entry=\"task_done\"]'))", "the history entry");
    assert.equal(await evalValue("document.getElementById('history').hidden"), false);
    const card = await evalValue("document.querySelector('[data-hist-entry=\"task_done\"]').textContent");
    assert.match(card, /Creality K2/);
    assert.match(card, /напечатано/);

    // Its settings, on demand.
    await click('[data-hist-action="toggle"][data-id="task_done"]');
    await waitFor("Boolean(document.querySelector('[data-hist-entry=\"task_done\"] .hist-details'))", "the details");
    assert.match(await evalValue("document.querySelector('[data-hist-entry=\"task_done\"] .hist-details').textContent"), /K2 · PETG/);

    // «Напечатать ещё раз» → the launch window of the NEW print, on the old printer.
    await click('[data-hist-action="reprint"][data-id="task_done"]');
    await waitFor("Boolean(document.querySelector('#modal-content'))", "the launch window");
    await new Promise((r) => setTimeout(r, 400));
    const post = mock.requests.find((r) => r.method === "POST" && r.path === "/api/print/tasks/task_done/reprint");
    assert.ok(post, "the reprint went to the server");
    const launch = mock.requests.find((r) => r.method === "GET" && r.path === "/api/print/launch/task_new");
    assert.ok(launch, "the launch window opened the new print");
    assert.match(launch.query, /printer=creality-k2/);
    assert.equal(reprints.length, 1, "one click, one print");

    // A print whose file is gone offers preparing the model again — in the wizard.
    await waitFor("Boolean(document.querySelector('[data-hist-action=\"reprepare\"][data-id=\"task_gone\"]'))", "the reprepare action");
    await click('[data-hist-action="reprepare"][data-id="task_gone"]');
    await waitFor("document.getElementById('newprint') && !document.getElementById('newprint').hidden", "the wizard");
    const selection = await evalValue("sessionStorage.getItem('albedo-newprint')");
    const parsed = JSON.parse(selection || "{}");
    assert.equal(parsed.artifactId, "art_stl");
    assert.equal(parsed.printerId, "creality-k2");
    assert.equal(parsed.setId, "set_k2");
    assert.equal(parsed.previousTaskId, "task_gone");
    await waitFor("Boolean(document.querySelector('[data-np-action=\"slice\"]'))", "the wizard at the slice step");

    // The filter is the server's.
    await click('[data-work-tab="history"]');
    await waitFor("Boolean(document.querySelector('[data-hist-filter=\"FAILED\"]'))", "the filters");
    await click('[data-hist-filter="FAILED"]');
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(
      mock.requests.some((r) => r.method === "GET" && r.path === "/api/print/history" && /state=FAILED/.test(r.query)),
      "the filter is a query, not client-side hiding"
    );
    assert.deepEqual(cdp.exceptions, [], "no uncaught page errors");
  } finally {
    cdp.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
    await mock.close();
  }
});
