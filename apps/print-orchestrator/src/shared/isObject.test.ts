import assert from "node:assert/strict";
import { test } from "node:test";

import { isObject } from "./isObject";

/*
 * Contract: any non-null value of type `object` that is not an array. The table
 * documents every boundary the callers care about — crucially that `null` and
 * arrays are rejected (the two cases the consumers special-case elsewhere).
 */
class Widget {
  constructor(public id = 1) {}
}

const cases: Array<[string, unknown, boolean]> = [
  ["null", null, false],
  ["undefined", undefined, false],
  ["a number", 42, false],
  ["zero", 0, false],
  ["a string", "hi", false],
  ["a boolean", true, false],
  ["a function", () => {}, false],
  ["an array", [1, 2, 3], false],
  ["an empty array", [], false],
  ["an empty object", {}, true],
  ["a populated object", { a: 1 }, true],
  // Non-JSON object types: not tightened out — they cannot arise from JSON.parse,
  // and the guard's contract is "non-null, non-array object".
  ["a Date", new Date(), true],
  ["a Map", new Map(), true],
  ["a RegExp", /x/, true],
  ["a null-prototype object", Object.create(null), true],
  ["a class instance", new Widget(), true]
];

for (const [label, value, expected] of cases) {
  test(`isObject(${label}) === ${expected}`, () => {
    assert.equal(isObject(value), expected);
  });
}

test("narrows the type so keyed access type-checks", () => {
  const value: unknown = { nested: { ok: true } };
  if (isObject(value)) {
    // Compiles because the guard narrows to Record<string, unknown>.
    assert.deepEqual(value.nested, { ok: true });
  } else {
    assert.fail("expected an object");
  }
});
