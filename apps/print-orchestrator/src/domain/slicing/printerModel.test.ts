import assert from "node:assert/strict";
import { test } from "node:test";

import {
  modelTokens,
  normalizePrinterModel,
  printerModelsMatch,
  printerModelsMatchStrict
} from "./printerModel";

test("a Combo is the same machine as the bare printer (A1 Combo = A1 + AMS Lite)", () => {
  // OrcaSlicer has no "A1 Combo" machine: the Combo is an A1 sold with an AMS Lite.
  // The farm printer is configured as "Bambu Lab A1 Combo"; its machine profile
  // declares printer_model "Bambu Lab A1" — these must be the same printer.
  assert.equal(printerModelsMatch("Bambu Lab A1", "Bambu Lab A1 Combo"), true);
  assert.equal(printerModelsMatch("Bambu Lab A1 Combo", "Bambu Lab A1"), true);
  assert.equal(normalizePrinterModel("Bambu Lab A1 Combo"), "a1");
});

test("sibling machines are NOT interchangeable (the substring-match bug)", () => {
  // "Bambu Lab A1" is a substring of "Bambu Lab A1 mini" and "Creality K2" of
  // "Creality K2 Plus" — different beds, different limits, different G-code.
  assert.equal(printerModelsMatch("Bambu Lab A1", "Bambu Lab A1 mini"), false);
  assert.equal(printerModelsMatch("Bambu Lab A1 mini", "Bambu Lab A1"), false);
  assert.equal(printerModelsMatch("Creality K2", "Creality K2 Plus"), false);
  assert.equal(printerModelsMatch("Bambu Lab X1", "Bambu Lab X1 Carbon"), false);
});

test("vendor prefixes and punctuation do not affect identity", () => {
  assert.equal(printerModelsMatch("Ender-3 V3 KE", "Creality Ender 3 V3 KE"), true);
  assert.equal(printerModelsMatch("A1", "Bambu Lab A1"), true);
  assert.deepEqual(modelTokens("Bambu Lab A1 mini"), ["a1", "mini"]);
});

test("an unknown model does not hard-block, but does not count as coverage either", () => {
  // The gate must not refuse work over a comparison it cannot make…
  assert.equal(printerModelsMatch(null, "Bambu Lab A1"), true);
  assert.equal(printerModelsMatch("", "Bambu Lab A1"), true);
  // …while the coverage report must not claim a nameless profile covers a printer.
  assert.equal(printerModelsMatchStrict(null, "Bambu Lab A1"), false);
  assert.equal(printerModelsMatchStrict("Bambu Lab A1", "Bambu Lab A1 Combo"), true);
  assert.equal(printerModelsMatchStrict("Bambu Lab A1 mini", "Bambu Lab A1 Combo"), false);
});
