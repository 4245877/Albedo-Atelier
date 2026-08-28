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

/*
 * The exhaustive printer matrix.
 *
 * Every pair of the models this farm's vocabulary can name is checked in both
 * directions, so a sibling machine can never be quietly accepted. The rule the
 * matrix encodes: two names are the same machine only when they reduce to the
 * same significant tokens — vendor spelling and kit bundles are noise, and
 * everything else is identity.
 */

/** Distinct machines. Each row's spellings are one printer; different rows are not. */
const MACHINES: { machine: string; spellings: string[] }[] = [
  { machine: "A1", spellings: ["A1", "Bambu Lab A1", "bambulab a1", "Bambu Lab A1 Combo", "BAMBU LAB A1"] },
  { machine: "A1 mini", spellings: ["A1 mini", "Bambu Lab A1 mini", "a1-mini", "Bambu Lab A1 mini Combo"] },
  { machine: "P1P", spellings: ["P1P", "Bambu Lab P1P", "p1p"] },
  { machine: "P1S", spellings: ["P1S", "Bambu Lab P1S", "P1S Combo"] },
  { machine: "X1", spellings: ["X1", "Bambu Lab X1"] },
  // "X1C" and "X1 Carbon" name the same physical machine, but no rule here can
  // know that an abbreviation expands to those words. They are kept as separate
  // rows because that is what the matcher does — and the direction is the safe
  // one: the file is refused for review rather than accepted onto a guess.
  { machine: "X1C", spellings: ["X1C", "x1c"] },
  { machine: "X1 Carbon", spellings: ["Bambu Lab X1 Carbon", "X1 Carbon", "x1-carbon"] },
  { machine: "X1E", spellings: ["X1E", "Bambu Lab X1E"] },
  { machine: "K2", spellings: ["K2", "Creality K2", "creality  k2"] },
  { machine: "K2 Plus", spellings: ["K2 Plus", "Creality K2 Plus", "k2-plus", "K2 Plus CFS"] },
  { machine: "Ender 3 V3 KE", spellings: ["Ender-3 V3 KE", "Creality Ender 3 V3 KE", "ender3v3ke"] }
];

test("printer model matrix: same machine matches in every spelling, siblings never do", () => {
  for (const a of MACHINES) {
    for (const spellingA of a.spellings) {
      for (const b of MACHINES) {
        for (const spellingB of b.spellings) {
          const same = a.machine === b.machine;
          assert.equal(
            printerModelsMatchStrict(spellingA, spellingB),
            same,
            same
              ? `«${spellingA}» and «${spellingB}» are the same ${a.machine}`
              : `«${spellingA}» (${a.machine}) must NOT match «${spellingB}» (${b.machine})`
          );
        }
      }
    }
  }
});

/** The substring test the dispatch gate used to run, kept to prove what it did. */
const oldSubstringMatch = (a: string, b: string): boolean => {
  const na = a.toLowerCase().replace(/[\s_-]+/g, "");
  const nb = b.toLowerCase().replace(/[\s_-]+/g, "");
  return Boolean(na) && Boolean(nb) && (na === nb || na.includes(nb) || nb.includes(na));
};

test("the sibling pairs the substring test used to accept are now refused", () => {
  // Each of these is a real pair of machines where one name contains the other:
  // different beds, different nozzle limits, different G-code. The old gate said
  // "same printer" for every one.
  const substringTraps: [string, string][] = [
    ["Bambu Lab A1", "Bambu Lab A1 mini"],
    ["A1", "A1 mini"],
    ["Creality K2", "Creality K2 Plus"],
    ["K2", "K2 Plus"],
    ["X1", "X1C"],
    ["X1", "X1 Carbon"],
    ["X1C", "X1 Carbon"],
    ["Ender 3", "Ender 3 V3 KE"],
    ["P1", "P1P"]
  ];
  for (const [a, b] of substringTraps) {
    assert.ok(oldSubstringMatch(a, b), `«${a}»/«${b}» is a substring pair — this is what used to pass`);
    assert.equal(printerModelsMatchStrict(a, b), false, `${a} ≠ ${b}`);
    assert.equal(printerModelsMatchStrict(b, a), false, `${b} ≠ ${a}`);
  }
});

test("plainly different machines stay different", () => {
  const distinct: [string, string][] = [
    ["P1P", "P1S"],
    ["X1C", "X1E"],
    ["Bambu Lab A1", "Creality K2"],
    ["Ender 3 V3 KE", "K2 Plus"]
  ];
  for (const [a, b] of distinct) {
    assert.equal(printerModelsMatchStrict(a, b), false, `${a} ≠ ${b}`);
    assert.equal(printerModelsMatchStrict(b, a), false, `${b} ≠ ${a}`);
  }
});

test("matching is reflexive, symmetric, and stable under whitespace and case", () => {
  for (const { spellings } of MACHINES) {
    for (const spelling of spellings) {
      assert.equal(printerModelsMatchStrict(spelling, spelling), true, `${spelling} = itself`);
      assert.equal(
        printerModelsMatchStrict(spelling, `  ${spelling.toUpperCase()}  `),
        true,
        `${spelling} survives case and padding`
      );
    }
  }
});
