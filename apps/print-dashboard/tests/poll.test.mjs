import assert from "node:assert/strict";
import { test } from "node:test";

import { createLatestOnly } from "../poll.js";

/*
 * The dashboard polling race guard (P0-4). createLatestOnly must apply ONLY the
 * newest run's result: a slower earlier request that resolves after a newer one
 * is dropped, and the previous request is aborted. This is the exact mechanism
 * app.js uses so a stale GET can never revert the board to old state.
 */

/** A controllable async task: resolves/rejects on demand, and observes its abort signal. */
function deferredRunner() {
  const calls = [];
  const run = (signal) =>
    new Promise((resolve, reject) => {
      const call = { signal, resolve, reject, aborted: false };
      signal.addEventListener("abort", () => {
        call.aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
      calls.push(call);
    });
  return { calls, run };
}

test("a slower earlier poll never overwrites a newer one", async () => {
  const applied = [];
  const { calls, run } = deferredRunner();
  const trigger = createLatestOnly({ run, apply: (r) => applied.push(r) });

  const first = trigger(); // A — starts
  const second = trigger(); // B — supersedes A (aborts it)

  // Respond out of order: B first, then A. A must be dropped despite resolving.
  calls[1].resolve("B");
  calls[0].resolve("A");

  await Promise.all([first, second]);

  assert.deepEqual(applied, ["B"], "only the newest result was applied");
  assert.equal(calls[0].aborted, true, "the superseded request was aborted");
});

test("aborting the previous request is not surfaced as an error", async () => {
  const applied = [];
  const errors = [];
  const { calls, run } = deferredRunner();
  const trigger = createLatestOnly({
    run,
    apply: (r) => applied.push(r),
    onError: (e) => errors.push(e)
  });

  const first = trigger();
  const second = trigger(); // aborts the first → first rejects AbortError

  calls[1].resolve("latest");

  await Promise.all([first, second]);

  assert.deepEqual(applied, ["latest"]);
  assert.deepEqual(errors, [], "the abort of the superseded poll was swallowed, not shown");
});

test("a genuine error from the latest run is reported", async () => {
  const errors = [];
  const { calls, run } = deferredRunner();
  const trigger = createLatestOnly({ run, apply: () => {}, onError: (e) => errors.push(e) });

  const only = trigger();
  calls[0].reject(Object.assign(new Error("HTTP 502"), { name: "TypeError" }));
  await only;

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /502/);
});
