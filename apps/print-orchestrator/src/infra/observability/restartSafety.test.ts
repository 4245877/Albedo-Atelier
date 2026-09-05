import assert from "node:assert/strict";
import { test } from "node:test";

import type { RestartSafetyAssessment } from "../../app/restartSafety";
import { getRestartSafety } from "./restartSafety";

/*
 * The endpoint deploy.sh reads before deciding whether it may recreate the
 * orchestrator. Its only input is the restart window the caller expects to
 * cause, and the one behaviour that matters here is that a junk value degrades
 * to the module default instead of erroring: a deploy that gets a 400 back has
 * no way to tell "the farm is busy" from "I sent a bad query", and would have
 * to fail closed on a question that was never actually asked.
 */

function source(): {
  farm: { assessRestartSafety(o: { restartWindowSeconds?: number }): RestartSafetyAssessment };
  seen: { restartWindowSeconds?: number }[];
} {
  const seen: { restartWindowSeconds?: number }[] = [];
  const assessment: RestartSafetyAssessment = {
    generatedAt: "2026-09-05T12:00:00.000Z",
    restartWindowSeconds: 180,
    activePrints: 0,
    recoverable: 0,
    atRisk: 0,
    safeToRestart: true,
    printers: []
  };
  return {
    seen,
    farm: {
      assessRestartSafety(options) {
        seen.push(options);
        return assessment;
      }
    }
  };
}

test("no query leaves the restart window at the module default", () => {
  const { farm, seen } = source();
  getRestartSafety(farm, undefined);
  assert.deepEqual(seen, [{ restartWindowSeconds: undefined }]);
});

test("?window=<seconds> is passed through", () => {
  const { farm, seen } = source();
  getRestartSafety(farm, { window: "600" });
  assert.deepEqual(seen, [{ restartWindowSeconds: 600 }]);
});

test("zero is a legitimate window (ask only about durability)", () => {
  const { farm, seen } = source();
  getRestartSafety(farm, { window: "0" });
  assert.deepEqual(seen, [{ restartWindowSeconds: 0 }]);
});

test("a malformed, empty or negative window degrades to the default, never a 400", () => {
  // "" matters on its own: Number("") is 0, and a zero window would silently
  // DISABLE the finishing-soon check rather than mean "unspecified".
  for (const window of ["abc", "-5", "", "  ", null, {}]) {
    const { farm, seen } = source();
    const result = getRestartSafety(farm, { window });
    assert.deepEqual(seen, [{ restartWindowSeconds: undefined }], `window=${String(window)}`);
    assert.equal(result.safeToRestart, true);
  }
});
