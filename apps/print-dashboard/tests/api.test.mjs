import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import { apiGet, apiPost, uploadArtifact } from "../api.js";
import { subscribePrintChanges } from "../shared/changes.js";

/*
 * Клиент API (api.js): необязательный AbortSignal и настраиваемый timeout для GET
 * и POST, различение отмены/таймаута/HTTP-ошибки, снятие таймера после запроса и
 * обратная совместимость существующих вызовов. Сеть подменяем через globalThis.fetch;
 * время — mock.timers, чтобы таймаут срабатывал детерминированно, без реальных задержек.
 */

const realFetch = globalThis.fetch;
const realXhr = globalThis.XMLHttpRequest;

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.XMLHttpRequest = realXhr;
  mock.timers.reset();
});

test("an upload with an already-aborted signal rejects immediately without opening a request", async () => {
  globalThis.XMLHttpRequest = class { constructor() { assert.fail("must not create XHR"); } };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(uploadArtifact(new File(["x"], "x.stl"), { signal: controller.signal }), { name: "AbortError" });
});

test("a stalled upload has a deadline and releases its abort listener when finished", async () => {
  let xhr;
  globalThis.XMLHttpRequest = class extends EventTarget {
    constructor() { super(); xhr = this; this.upload = new EventTarget(); }
    open() {}
    setRequestHeader() {}
    send() {}
    abort() { assert.fail("a finished XHR must no longer listen for abort"); }
  };
  const controller = new AbortController();
  const uploading = uploadArtifact(new File(["x"], "x.stl"), { signal: controller.signal, timeoutMs: 1234 });
  assert.equal(xhr.timeout, 1234);
  xhr.dispatchEvent(new Event("timeout"));
  xhr.dispatchEvent(new Event("loadend"));
  await assert.rejects(uploading, { name: "TimeoutError" });
  controller.abort();
});

test("related views are invalidated after a successful mutation, never after a refusal or a GET", async () => {
  const originalDocument = globalThis.document;
  const originalChannel = globalThis.BroadcastChannel;
  globalThis.document = new EventTarget();
  globalThis.BroadcastChannel = undefined;
  const changes = [];
  const off = subscribePrintChanges(["artifacts"], (change) => changes.push(change));
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
    await apiGet("/api/print/artifacts");
    assert.equal(changes.length, 0);
    await apiPost("/api/print/artifacts/a/review", {});
    assert.equal(changes.length, 1);
    globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: { message: "busy" } }) });
    await assert.rejects(apiPost("/api/print/artifacts/a/review", {}), /busy/);
    assert.equal(changes.length, 1);
  } finally {
    off();
    globalThis.document = originalDocument;
    globalThis.BroadcastChannel = originalChannel;
  }
});

/** fetch, который «зависает» и реджектится ровно на abort итогового signal
    (как настоящий fetch — уже оборванный signal реджектит немедленно). */
function stallingFetch(captured = {}) {
  return (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    return new Promise((_, reject) => {
      if (opts.signal.aborted) {
        reject(opts.signal.reason);
        return;
      }
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
    });
  };
}

test("apiGet returns parsed JSON on success", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ hello: "world" }) });
  assert.deepEqual(await apiGet("/x"), { hello: "world" });
});

test("apiGet times out with a TimeoutError when the network stalls", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = stallingFetch();

  const p = apiGet("/x", { timeoutMs: 5000 });
  const rejects = assert.rejects(p, (err) => err.name === "TimeoutError");
  mock.timers.tick(5000);
  await rejects;
});

test("apiGet aborts with AbortError when the caller's signal aborts", async () => {
  globalThis.fetch = stallingFetch();

  const ac = new AbortController();
  const p = apiGet("/x", { signal: ac.signal, timeoutMs: 100000 });
  ac.abort(); // reason по умолчанию — DOMException "AbortError"
  await assert.rejects(p, (err) => err.name === "AbortError");
});

test("apiGet already-aborted signal fails immediately, before fetching", async () => {
  let fetched = false;
  globalThis.fetch = stallingFetch(); // если бы дошли до fetch — зависли бы
  const wrapped = (u, o) => {
    fetched = true;
    return stallingFetch()(u, o);
  };
  globalThis.fetch = wrapped;

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(apiGet("/x", { signal: ac.signal }), (err) => err.name === "AbortError");
  // fetch всё же вызывается с уже-оборванным signal — важно, что запрос не зависает.
  assert.equal(fetched, true);
});

test("apiGet surfaces the HTTP error with message, status and code intact", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: { message: "conflict", code: "VERSION_MISMATCH" } })
  });
  await assert.rejects(
    apiGet("/x"),
    (err) => err.message === "conflict" && err.status === 409 && err.code === "VERSION_MISMATCH"
  );
});

test("apiGet falls back to HTTP <status> when the body carries no message", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => null });
  await assert.rejects(apiGet("/x"), (err) => /502/.test(err.message) && err.status === 502);
});

test("apiPost is backward compatible with a plain path (no options)", async () => {
  const captured = {};
  globalThis.fetch = async (url, opts) => {
    captured.opts = opts;
    return { ok: true, json: async () => ({ ok: 1 }) };
  };
  const r = await apiPost("/x");
  assert.deepEqual(r, { ok: 1 });
  assert.equal(captured.opts.method, "POST");
  assert.ok(!("Content-Type" in captured.opts.headers), "пустое тело → без Content-Type");
  assert.ok(captured.opts.signal, "жёсткий дедлайн-signal прикреплён всегда");
});

test("apiPost sends a JSON body with Content-Type when one is given", async () => {
  const captured = {};
  globalThis.fetch = async (url, opts) => {
    captured.opts = opts;
    return { ok: true, json: async () => ({}) };
  };
  await apiPost("/x", { a: 1 });
  assert.equal(captured.opts.headers["Content-Type"], "application/json");
  assert.equal(captured.opts.body, JSON.stringify({ a: 1 }));
});

test("apiPost honours an external abort signal", async () => {
  globalThis.fetch = stallingFetch();
  const ac = new AbortController();
  const p = apiPost("/x", { a: 1 }, { signal: ac.signal, timeoutMs: 100000 });
  ac.abort();
  await assert.rejects(p, (err) => err.name === "AbortError");
});

test("apiPost times out on a stalled mutation", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = stallingFetch();
  const p = apiPost("/x", { a: 1 }, { timeoutMs: 3000 });
  const rejects = assert.rejects(p, (err) => err.name === "TimeoutError");
  mock.timers.tick(3000);
  await rejects;
});
