import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createLaunchController } from "../features/launch/controller.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const preview = (title) => ({
  taskId: "t", displayTitle: title, state: "ready", recommendedPrinterId: "a",
  candidates: ["a", "b"].map((id) => ({ printerId: id, printerName: id, eligible: true, online: true,
    status: "idle", blockers: [], reviews: [], warnings: [], problems: [] })), confirmations: []
});
function harness() {
  const requests = [];
  // Намеренно игнорируем abort: latest-only должен защищать даже от позднего
  // ответа транспорта, который уже не удалось отменить.
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    requests.push({ url, opts, resolve: (p) => resolve({ ok: true, json: async () => ({ preview: p }) }), reject });
  });
  const content = { innerHTML: "" };
  const controller = createLaunchController({ getContent: () => content, refresh: async () => {}, close() {} });
  const pick = (value) => controller.handleChange({ target: { closest: (s) => s === "[data-launch-pick]" ? { value } : null } });
  return { requests, content, controller, pick };
}

test("reopening the same task ignores the previous session's response", async () => {
  const h = harness();
  const first = h.controller.open("t");
  const second = h.controller.open("t");
  h.requests[1].resolve(preview("fresh preview"));
  await second;
  h.requests[0].resolve(preview("obsolete preview"));
  await first;
  assert.match(h.content.innerHTML, /fresh preview/);
  assert.doesNotMatch(h.content.innerHTML, /obsolete preview/);
});

test("a late error from a closed session cannot replace a new task's modal", async () => {
  const h = harness();
  const first = h.controller.open("old");
  h.controller.reset();
  const second = h.controller.open("new");
  h.requests[1].resolve(preview("new task"));
  await second;
  h.requests[0].reject(new Error("old network error"));
  await first;
  assert.match(h.content.innerHTML, /new task/);
  assert.doesNotMatch(h.content.innerHTML, /old network error/);
});

test("printer selection is latest-only and launch stays disabled until its preview arrives", async () => {
  const h = harness();
  const opening = h.controller.open("t");
  h.requests[0].resolve(preview("initial"));
  await opening;
  h.pick("b");
  assert.match(h.content.innerHTML, /data-launch-go\s+disabled/);
  h.pick("a");
  h.requests[2].resolve(preview("fresh printer"));
  await flush();
  h.requests[1].resolve(preview("stale printer"));
  await flush();
  assert.match(h.content.innerHTML, /fresh printer/);
  assert.doesNotMatch(h.content.innerHTML, /stale printer/);
  assert.doesNotMatch(h.content.innerHTML, /data-launch-go\s+disabled/);
});

test("a failed printer preview stays disabled and can be explicitly rechecked", async () => {
  const h = harness();
  const opening = h.controller.open("t");
  h.requests[0].resolve(preview("initial"));
  await opening;
  h.pick("b");
  h.requests[1].reject(new Error("offline"));
  await flush();
  assert.match(h.content.innerHTML, /data-launch-go\s+disabled/);
  assert.match(h.content.innerHTML, /data-launch-recheck/);
  h.controller.handleClick({ target: { closest: (s) => s === "[data-launch-recheck]" ? {} : null } });
  h.requests[2].resolve(preview("recovered"));
  await flush();
  assert.match(h.content.innerHTML, /recovered/);
  assert.doesNotMatch(h.content.innerHTML, /data-launch-go\s+disabled/);
});
