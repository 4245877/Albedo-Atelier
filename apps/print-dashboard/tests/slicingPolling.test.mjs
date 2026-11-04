import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setupSlicing } from "../features/slicing/controller.js";

test("slow slicing reads finish before the next polling cycle starts", async () => {
  const original = { document: globalThis.document, window: globalThis.window,
    fetch: globalThis.fetch, BroadcastChannel: globalThis.BroadcastChannel };
  const body = { innerHTML: "", querySelector: () => null, closest: () => null };
  const doc = new EventTarget();
  doc.querySelector = () => body;
  doc.getElementById = () => body;
  globalThis.document = doc;
  globalThis.window = new EventTarget();
  globalThis.BroadcastChannel = undefined;
  let calls = 0;
  globalThis.fetch = (_url, { signal }) => {
    calls++;
    // Первая ошибка включает быстрый опрос. Следующий цикл имитирует медленный
    // backend: даже через два интервала его никто не должен вытеснять таймером.
    if (calls <= 7) return Promise.reject(new Error("offline"));
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  };
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    setupSlicing();
    await flush();
    assert.equal(calls, 7);
    mock.timers.tick(4000);
    await flush();
    assert.equal(calls, 14);
    mock.timers.tick(8000);
    await flush();
    assert.equal(calls, 14, "no overlapping poll can starve the current result");
  } finally {
    globalThis.window.dispatchEvent(new Event("pagehide"));
    await flush();
    mock.timers.reset();
    Object.assign(globalThis, original);
  }
});
