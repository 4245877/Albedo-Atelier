/* ── Browser smoke: «Автоочередь» в разделе «Автоматизации» ───────
   В НАСТОЯЩЕМ браузере против mock-сервера: правило «Автоочередь» выключено и
   заблокировано (выключено при развёртывании) — переключатель неактивен и
   говорит почему; блок автоочереди показывает dry-run «что запустилось бы
   сейчас» и не предлагает «проход», который сервер не сделает.

   Работает через CDP без Playwright/Puppeteer и SKIP-ается, когда браузера
   нет (CHROME_CDP_URL, по умолчанию :9222). */
import assert from "node:assert/strict";
import test from "node:test";

import { MOCK_DASHBOARD, startMockServer } from "./mockServer.mjs";

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

const LOCK = "автоочередь выключена при развёртывании (AUTO_QUEUE_ENABLED=false)";

const version = await probeCdp();

test("«Автоочередь»: заблокированное правило, dry-run и никакого «прохода» при выключенной автоочереди", { skip: version ? false : `no CDP browser at ${CDP_URL}` }, async () => {
  const mock = await startMockServer({
    api: {
      "/api/dashboard": {
        ...MOCK_DASHBOARD,
        automations: [
          { id: "night-lights", name: "Подсветка по солнечному расписанию", desc: "…", on: true },
          { id: "auto-queue", name: "Автоочередь", desc: "Сама запускает следующее задание…", on: false, locked: LOCK }
        ]
      },
      "/api/automations/auto-queue": {
        status: {
          configured: false,
          armed: false,
          running: false,
          intervalMs: 60000,
          startupDelayMs: 120000,
          maxStartsPerTick: 1,
          retryCooldownMs: 900000,
          startedAt: null,
          lastTickAt: null,
          lastResult: null,
          recent: [],
          cooldowns: [],
          haltedReason: null
        },
        plan: [
          { at: "2026-10-14T12:00:00.000Z", taskId: "t1", title: "Кронштейн", outcome: "would_start", printerId: "k2", printerName: "Creality K2", message: "запустилось бы на «Creality K2»", code: null, runId: null },
          { at: "2026-10-14T12:00:00.000Z", taskId: "t2", title: "Крышка", outcome: "not_allowed", printerId: null, printerName: null, message: "нет разрешения печатать без оператора", code: "UNATTENDED_NOT_ALLOWED", runId: null }
        ]
      }
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
    await waitFor("Boolean(document.querySelector('[data-work-tab=\"automations\"]'))", "the automations tab");
    await click('[data-work-tab="automations"]');

    // The rule: drawn disabled, with the reason, not a toast after a click.
    await waitFor("Boolean(document.querySelector('[data-act=\"rule\"][data-id=\"auto-queue\"]'))", "the rule list");
    assert.equal(await evalValue("document.querySelector('[data-act=\"rule\"][data-id=\"auto-queue\"]').disabled"), true);
    assert.match(await evalValue("document.getElementById('auto-body').textContent"), /AUTO_QUEUE_ENABLED=false/);
    assert.equal(await evalValue("document.querySelector('[data-act=\"rule\"][data-id=\"night-lights\"]').disabled"), false);

    // The panel: off, says so, shows the dry run, offers no pass.
    await waitFor("Boolean(document.querySelector('#auto-queue-body .aq'))", "the auto-queue panel");
    const panel = await evalValue("document.getElementById('auto-queue-body').textContent");
    assert.match(panel, /выключена на сервере/);
    assert.match(panel, /Кронштейн[\s\S]*запустилось бы/);
    assert.match(panel, /Крышка[\s\S]*не для автоочереди/);
    assert.equal(await evalValue("Boolean(document.querySelector('[data-aq-action=\"tick\"]'))"), false);
    assert.ok(mock.requests.some((r) => r.method === "GET" && r.path === "/api/automations/auto-queue"));
    assert.ok(!mock.requests.some((r) => r.method === "POST" && r.path.startsWith("/api/automations")), "nothing was switched or run");
    assert.deepEqual(cdp.exceptions, [], "no uncaught page errors");
  } finally {
    cdp.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
    await mock.close();
  }
});
