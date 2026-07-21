import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { fetchWithTimeout, isAbortError, isTimeoutError } from "./fetchWithTimeout";

/*
 * Deterministic against a local loopback server — never the real network. `/ok`
 * answers at once; `/slow` never answers within any test's deadline, so it
 * exercises the timeout and the external-abort paths.
 */
let server: Server;
let base: string;
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    // Hold the response open; a timer we can cancel avoids a dangling handle.
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (!res.writableEnded) res.end("late");
    }, 10_000);
    pendingTimers.add(timer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Force idle keep-alive sockets shut so close() actually completes.
    server.closeAllConnections?.();
  });
});

test("resolves for a request that completes within the deadline", async () => {
  const res = await fetchWithTimeout(`${base}/ok`, { timeoutMs: 1000 });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});

test("rejects with a TimeoutError (not an AbortError) when the deadline is exceeded", async () => {
  await assert.rejects(fetchWithTimeout(`${base}/slow`, { timeoutMs: 40 }), (err: unknown) => {
    assert.equal(isTimeoutError(err), true, "the deadline is classified as a timeout");
    assert.equal(isAbortError(err), false, "and NOT as a manual abort");
    return true;
  });
});

test("an already-aborted external signal aborts immediately — a manual abort, not a timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchWithTimeout(`${base}/ok`, { timeoutMs: 1000, signal: controller.signal }),
    (err: unknown) => {
      assert.equal(isAbortError(err), true, "the external abort is honoured, not dropped");
      assert.equal(isTimeoutError(err), false, "and not mislabelled a timeout");
      return true;
    }
  );
});

test("an external signal aborted mid-flight cancels the in-flight request", async () => {
  const controller = new AbortController();
  const promise = fetchWithTimeout(`${base}/slow`, { timeoutMs: 5000, signal: controller.signal });
  const kick = setTimeout(() => controller.abort(), 20);
  pendingTimers.add(kick);
  await assert.rejects(promise, (err: unknown) => {
    assert.equal(isAbortError(err), true);
    assert.equal(isTimeoutError(err), false);
    return true;
  });
  clearTimeout(kick);
  pendingTimers.delete(kick);
});

test("the deadline still fires when an idle external signal is also supplied", async () => {
  const controller = new AbortController(); // supplied but never aborted
  await assert.rejects(
    fetchWithTimeout(`${base}/slow`, { timeoutMs: 40, signal: controller.signal }),
    (err: unknown) => {
      assert.equal(isTimeoutError(err), true, "the timeout wins over the idle external signal");
      return true;
    }
  );
});
