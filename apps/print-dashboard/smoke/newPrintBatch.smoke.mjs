/* ── Browser smoke: «Новая печать» пакетом ───────────────────────
   В НАСТОЯЩЕМ браузере против mock-сервера: «Подготовить пакетом» → две
   модели флажками → принтер → рецепт (единственный — выбирается сам) →
   «Нарезать все» (один POST /slicing/batches) → результат по модели →
   «Поставить готовые в очередь» (один POST /slicing/batches/promote) → у
   каждой печати своя кнопка «Запустить», окно запуска — на выбранном принтере.

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
const ready = (verdict, over = {}) => ({ state: "ready", verdict, warnings: [], blockers: [], ...over });

function model(id, name) {
  return {
    artifact: { id, name, kind: "model", createdAt: ISO },
    task: { id: `task_${id}`, state: "DRAFT", title: name },
    analysis: ready("needs_preparation", { detectedFormat: "stl" }),
    status: { executable: false, next: { kind: "slice", explanation: "Это модель", taskId: `task_${id}` } }
  };
}

function output(id) {
  return {
    artifact: { id, name: `${id}.gcode`, kind: "gcode", createdAt: ISO },
    task: null,
    analysis: ready("schedulable", { detectedFormat: "gcode" }),
    status: { executable: true, next: { kind: "queued", explanation: "" } }
  };
}

function variant(id, source, out) {
  return {
    id,
    state: "ready",
    taskId: `task_${source}`,
    sourceArtifactId: source,
    profileSetId: "set_k2",
    targetPrinterId: "creality-k2",
    targetPrinterClass: null,
    outputArtifactId: out,
    orcaEtaS: 1800,
    filamentG: 8,
    warnings: [],
    blockers: [],
    createdAt: ISO
  };
}

const version = await probeCdp();

test("«Новая печать» пакетом: две модели → один рецепт → нарезка → очередь → запуск каждой", { skip: version ? false : `no CDP browser at ${CDP_URL}` }, async () => {
  const state = { sliced: false, promoted: null, batchBody: null };
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
        const models = [model("art_a", "a.stl"), model("art_b", "b.stl")];
        return { status: 200, body: { artifacts: state.sliced ? [...models, output("out_a"), output("out_b")] : models } };
      }
      if (req.method === "GET" && key === "/api/print/slicing/variants") {
        return {
          status: 200,
          body: { variants: state.sliced ? [variant("v_a", "art_a", "out_a"), variant("v_b", "art_b", "out_b")] : [] }
        };
      }
      if (req.method === "POST" && key === "/api/print/slicing/batches") {
        state.sliced = true;
        return {
          status: 200,
          body: {
            ok: true,
            batch: {
              batchId: "sbt_1",
              items: [
                { artifactId: "art_a", ok: true, variant: variant("v_a", "art_a", "out_a") },
                { artifactId: "art_b", ok: true, variant: variant("v_b", "art_b", "out_b") }
              ]
            }
          }
        };
      }
      if (req.method === "POST" && key === "/api/print/slicing/batches/promote") {
        state.promoted = true;
        return {
          status: 200,
          body: {
            ok: true,
            items: [
              { variantId: "v_a", ok: true, taskId: "task_qa", title: "a.stl" },
              { variantId: "v_b", ok: true, taskId: "task_qb", title: "b.stl" }
            ]
          }
        };
      }
      if (req.method === "GET" && key === "/api/print/launch/task_qb") {
        return { status: 200, body: { preview: { taskId: "task_qb", candidates: [], recommendedPrinterId: null, confirmations: [], material: null } } };
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
    await waitFor("Boolean(document.querySelector('[data-np-action=\"mode-batch\"]'))", "the batch switch");
    await click('[data-np-action="mode-batch"]');

    // 1 · models — ticked one by one.
    await waitFor("Boolean(document.querySelector('[data-np-batch-toggle=\"art_a\"]'))", "the model checklist");
    await click('[data-np-batch-toggle="art_a"]');
    await waitFor("document.querySelector('[data-np-batch-toggle=\"art_a\"]')?.checked === true", "model a ticked");
    await click('[data-np-batch-toggle="art_b"]');
    await waitFor("document.querySelector('[data-np-batch-toggle=\"art_b\"]')?.checked === true", "model b ticked");
    await waitFor("Boolean(document.querySelector('[data-np-action=\"batch-files-done\"]:not([disabled])'))", "the next button");
    await click('[data-np-action="batch-files-done"]');
    // 2 · printer → 3 · the only recipe chosen for the operator → 4 · slice all
    await waitFor("Boolean(document.querySelector('[data-np-action=\"pick-printer\"]'))", "the printer list");
    await click('[data-np-action="pick-printer"][data-id="creality-k2"]');
    await waitFor("Boolean(document.querySelector('[data-np-action=\"batch-slice\"]'))", "the slice-all button");
    await click('[data-np-action="batch-slice"]');
    // 5 · result → queue the ready ones
    await waitFor("Boolean(document.querySelector('[data-np-action=\"batch-promote\"]:not([disabled])'))", "the promote-all button");
    await click('[data-np-action="batch-promote"]');
    // 6 · one launch button per print
    await waitFor("document.querySelectorAll('[data-np-action=\"launch-task\"]').length === 2", "a launch button per print");
    await click('[data-np-action="launch-task"][data-id="task_qb"]');
    await waitFor("Boolean(document.querySelector('#modal-content'))", "the launch window");
    await new Promise((r) => setTimeout(r, 400));

    const batch = mock.requests.filter((r) => r.method === "POST" && r.path === "/api/print/slicing/batches");
    assert.equal(batch.length, 1, "one request for the whole batch");
    assert.ok(state.promoted, "the ready prints were queued together");
    assert.ok(!mock.requests.some((r) => r.path === "/api/print/slicing/slice"), "no per-model slice calls");
    const launch = mock.requests.find((r) => r.method === "GET" && r.path === "/api/print/launch/task_qb");
    assert.ok(launch, "each print is launched on its own");
    assert.match(launch.query, /printer=creality-k2/);
    assert.deepEqual(cdp.exceptions, [], "no uncaught page errors");
  } finally {
    cdp.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
    await mock.close();
  }
});
