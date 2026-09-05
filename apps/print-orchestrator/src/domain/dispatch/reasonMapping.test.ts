import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PREFLIGHT_REASON,
  type PreflightReasonCode
} from "../scheduling/compatibility";
import { NON_OVERRIDABLE, REASON, type ReasonCode } from "./reasons";
import { mapPreflightCode } from "./eligibility";
import { explainReason, TRANSLATED_CODES } from "../../app/launch/problems";

/*
 * Exhaustive dictionary invariants.
 *
 * The bug these exist for: `PREFLIGHT_CODE_MAP` was `Record<string, ReasonCode>`
 * read through `?? REASON.MAINTENANCE_BLOCKED`, and three codes were never added
 * — `printer_fault`, `printer_media_missing`, `launch_unconfirmed`. Each reached
 * the operator as "принтер на обслуживании" *and* inherited that code's override
 * policy, so a printer with a start-blocking fault, a printer with no SD card,
 * and a printer still holding an unconfirmed launch could all be waved through.
 *
 * These tests iterate the vocabulary itself, so a code added tomorrow without a
 * decision fails here rather than degrading silently in production.
 */

const ALL_PREFLIGHT: PreflightReasonCode[] = Object.values(PREFLIGHT_REASON);
const ALL_REASONS: ReasonCode[] = Object.values(REASON);

test("every preflight reason maps to a real, specific dispatch code", () => {
  assert.ok(ALL_PREFLIGHT.length > 0);
  for (const code of ALL_PREFLIGHT) {
    const mapped = mapPreflightCode(code);
    assert.ok(
      ALL_REASONS.includes(mapped),
      `«${code}» maps to «${mapped}», which is not in the REASON contract`
    );
    assert.notEqual(
      mapped,
      REASON.PREFLIGHT_REASON_UNMAPPED,
      `«${code}» has no mapping — add one rather than letting it fall through`
    );
  }
});

test("the codes that had none: each now maps to its own reason, and cannot be overridden", () => {
  const previouslySwallowed: [PreflightReasonCode, ReasonCode][] = [
    [PREFLIGHT_REASON.PRINTER_FAULT, REASON.PRINTER_FAULT],
    [PREFLIGHT_REASON.PRINTER_MEDIA_MISSING, REASON.PRINTER_MEDIA_MISSING],
    [PREFLIGHT_REASON.LAUNCH_UNCONFIRMED, REASON.LAUNCH_UNCONFIRMED]
  ];
  for (const [preflight, expected] of previouslySwallowed) {
    assert.equal(mapPreflightCode(preflight), expected, preflight);
    assert.notEqual(
      mapPreflightCode(preflight),
      REASON.MAINTENANCE_BLOCKED,
      `«${preflight}» must not be reported as maintenance`
    );
    assert.ok(
      NON_OVERRIDABLE.has(expected),
      `«${expected}» must never be overridable — it is the device refusing, or the double-print guard`
    );
  }
});

test("an unknown code falls through to a non-overridable unknown, never to a plausible one", () => {
  const mapped = mapPreflightCode("a_code_from_the_future" as PreflightReasonCode);
  assert.equal(mapped, REASON.PREFLIGHT_REASON_UNMAPPED);
  assert.ok(
    NON_OVERRIDABLE.has(mapped),
    "a refusal nobody has taught this layer to read is an unknown critical"
  );
});

test("every preflight reason has operator language written for it", () => {
  for (const code of ALL_PREFLIGHT) {
    assert.ok(
      TRANSLATED_CODES.has(code),
      `«${code}» has no entry in the launch screen's translations — the operator would ` +
        "see the engine's own wording instead of what to do about it"
    );
    const problem = explainReason({ code, message: `сообщение для ${code}` }, "blocker");
    assert.equal(problem.code, code);
    assert.ok(problem.title.length > 0, `«${code}» has no title`);
    // `action` may fall back to the message for codes whose message carries the
    // device's own remedy (a fault code), but it is never empty.
    assert.ok(problem.action.length > 0, `«${code}» has no action`);
    assert.ok(problem.technical.startsWith(`${code}: `), `«${code}» loses its technical form`);
  }
});

test("every DISPATCH reason has operator language too — the preview now shows them", () => {
  // Before the preview ran the real eligibility, only preflight codes ever
  // reached a person, and only those needed wording. Now the launch screen
  // renders the dispatch vocabulary directly (`TARGET_PRINTER_MISMATCH`,
  // `REMOTE_START_UNSUPPORTED`, the bed rules, the delivery rules), so a code
  // without an entry would show the engine's own sentence — written for whoever
  // reads the ledger, not for whoever is standing at the printer.
  for (const code of ALL_REASONS) {
    assert.ok(
      TRANSLATED_CODES.has(code),
      `«${code}» has no entry in the launch screen's translations — an operator ` +
        "would read the engine's wording instead of what to do about it"
    );
    const problem = explainReason({ code, message: `сообщение для ${code}` }, "blocker");
    assert.ok(problem.title.length > 0, `«${code}» has no title`);
    assert.ok(problem.action.length > 0, `«${code}» has no action`);
  }
});

test("a lifted preflight reason is worded by its ORIGINAL code, not the dispatch one", () => {
  // `MATERIAL_UNKNOWN` is one dispatch code standing for two different preflight
  // facts — "the task states no material" and "the printer does not report its
  // spool" — and they need different sentences. The preflight code travels with
  // the reason precisely so the right one is chosen.
  const fromPrinter = explainReason(
    {
      code: REASON.MATERIAL_UNKNOWN,
      preflightCode: "printer_material_unknown",
      message: "…"
    },
    "confirmable"
  );
  const fromTask = explainReason(
    { code: REASON.MATERIAL_UNKNOWN, preflightCode: "task_material_unknown", message: "…" },
    "confirmable"
  );
  assert.notEqual(fromPrinter.title, fromTask.title, "one code, two facts, two sentences");
  assert.equal(fromPrinter.code, REASON.MATERIAL_UNKNOWN, "but the contract code is unchanged");
});

test("overridability travels with the reason instead of being re-derived", () => {
  // Re-deriving it here (by mapping the code a second time) is what made the
  // launch screen offer checkboxes the gate would then refuse — and, once the
  // codes became SCREAMING_SNAKE, would have made every one of them silently
  // non-overridable.
  const waivable = explainReason(
    { code: REASON.PROFILE_SET_NOT_APPROVED, message: "…", overridable: true },
    "confirmable"
  );
  const hard = explainReason(
    { code: REASON.BED_NOT_CLEAR, message: "…", overridable: false },
    "confirmable"
  );
  assert.equal(waivable.overridable, true);
  assert.equal(hard.overridable, false);
  // A blocker is never overridable, whatever the flag says.
  assert.equal(
    explainReason({ code: REASON.PROFILE_SET_NOT_APPROVED, message: "…", overridable: true }, "blocker")
      .overridable,
    false
  );
});

test("every dispatch reason code has an explicit override policy decision", () => {
  // Not "is in NON_OVERRIDABLE" — that would be trivially true. The invariant is
  // that the set only contains codes that exist, so a rename cannot leave a
  // safety rule silently pointing at nothing.
  for (const code of NON_OVERRIDABLE) {
    assert.ok(ALL_REASONS.includes(code), `NON_OVERRIDABLE holds «${code}», which is not a REASON`);
  }
  // And the codes whose whole purpose is to refuse are in it.
  for (const code of [
    REASON.BED_NOT_CLEAR,
    REASON.MANUAL_OPERATION_REQUIRED,
    REASON.PRINTER_FAULT,
    REASON.PRINTER_MEDIA_MISSING,
    REASON.LAUNCH_UNCONFIRMED,
    REASON.PREFLIGHT_REASON_UNMAPPED,
    REASON.DEVICE_FILE_STALE,
    REASON.ARTIFACT_HASH_MISMATCH
  ]) {
    assert.ok(NON_OVERRIDABLE.has(code), `«${code}» must not be overridable`);
  }
});

test("the REASON contract has no duplicate values", () => {
  assert.equal(new Set(ALL_REASONS).size, ALL_REASONS.length);
  assert.equal(new Set(ALL_PREFLIGHT).size, ALL_PREFLIGHT.length);
  // The key IS the value, so a copy-paste that repurposes a code is caught.
  for (const [key, value] of Object.entries(REASON)) assert.equal(key, value);
});
