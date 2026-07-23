/* ── Browser smoke test (P3.4) ─────────────────────────────────
   One end-to-end check that the built dashboard actually boots in a real
   browser: the app loads, the main board renders live data, and the frontend
   talks to (the mocked) backend over the same-origin API. It drives Chrome
   through the CDP HTTP/WebSocket protocol directly — no Playwright/Puppeteer
   dependency — against a headless Chrome the CI provides at CHROME_CDP_URL
   (default http://127.0.0.1:9222). When no browser is reachable the test SKIPS
   (so the pure-Node unit suite still runs everywhere); CI runs it for real by
   starting chromedp/headless-shell. */
import assert from "node:assert/strict";
import test from "node:test";

import { startMockServer } from "./mockServer.mjs";

const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";

/** Is a CDP endpoint reachable? Returns its /json/version, or null. */
async function probeCdp() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Tiny CDP client over one target's WebSocket; collects thrown exceptions. */
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

const version = await probeCdp();

test("dashboard boots in a real browser and renders the board from the API", { skip: version ? false : `no CDP browser at ${CDP_URL}` }, async () => {
  const mock = await startMockServer();
  // Open a fresh target for this page and talk to it directly.
  const target = await (await fetch(`${CDP_URL}/json/new?${encodeURIComponent(mock.url)}`, { method: "PUT" })).json();
  const cdp = await connect(target.webSocketDebuggerUrl);

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: mock.url });

    // ── App loaded: the document title is the dashboard's, hero present ──
    const evalValue = async (expression) => {
      const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return result.value;
    };

    // Poll until the board rendered its printer cards (data-driven from /api/dashboard).
    let cards = 0;
    for (let i = 0; i < 80; i++) {
      cards = await evalValue("document.querySelectorAll('.printer-card').length");
      if (cards >= 2) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const title = await evalValue("document.title");
    assert.match(title, /Albedo/i, "document title should name the dashboard");

    const heroPresent = await evalValue("Boolean(document.querySelector('#hero-stats') && document.querySelector('#hero-stats').children.length)");
    assert.equal(heroPresent, true, "hero stat tiles should render");

    // ── Main screen: both mock printers became cards, with their names ──
    assert.equal(cards, 2, "both mock printers should render as cards");
    const names = await evalValue("[...document.querySelectorAll('.printer-name')].map(n => n.textContent).join('|')");
    assert.match(names, /Creality K2/, "the printing printer should be on the board");
    assert.match(names, /Bambu A1/, "the idle printer should be on the board");

    // A live-data detail proves the board bound the payload, not a static shell.
    const jobText = await evalValue("document.querySelector('.printer-job')?.textContent || ''");
    assert.match(jobText, /bracket\.gcode/, "the K2 card should show its live job name");

    // ── Basic API interaction: the frontend fetched the board over the proxy ──
    const dashboardCalls = mock.requests.filter((r) => r.path === "/api/dashboard");
    assert.ok(dashboardCalls.length >= 1, "the app should GET /api/dashboard on load");

    // No uncaught page errors while booting.
    assert.deepEqual(cdp.exceptions, [], "there should be no uncaught page errors");
  } finally {
    cdp.close();
    await fetch(`${CDP_URL}/json/close/${target.id}`).catch(() => {});
    await mock.close();
  }
});
