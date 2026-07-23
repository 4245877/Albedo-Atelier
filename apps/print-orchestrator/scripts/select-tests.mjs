#!/usr/bin/env node
/**
 * Splits the test suite into fast unit tests and integration tests, by
 * CONTENT, not by a hand-maintained list: a test file is "integration" when it
 * opens the real SQLite store, boots the Fastify app / HTTP routes, or imports
 * the real vendored catalog — everything else is a unit test. New test files
 * therefore classify themselves.
 *
 * Usage:
 *   node scripts/select-tests.mjs unit         # print unit test files
 *   node scripts/select-tests.mjs integration  # print integration test files
 *   node scripts/select-tests.mjs --explain    # table of file → class
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src");

const INTEGRATION_MARKERS = [
  /openPrintQueueStore/, // real SQLite store (in-memory or file)
  /from "..\/..\/app"|from "..\/app"|buildApp|\.inject\(/, // Fastify app / routes
  /OrcaCatalogSource/, // real vendored catalog I/O
  /createRuntime|FarmRuntime/, // full composition root
  /testkit\/fixtures/ // artifact fixtures writing real blobs
];

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".test.ts")) files.push(p);
  }
})(SRC);
files.sort();

const classify = (file) => {
  const text = fs.readFileSync(file, "utf8");
  return INTEGRATION_MARKERS.some((m) => m.test(text)) ? "integration" : "unit";
};

const mode = process.argv[2];
if (mode === "--explain") {
  for (const f of files) console.log(`${classify(f).padEnd(11)} ${path.relative(process.cwd(), f)}`);
  const counts = files.reduce((acc, f) => ((acc[classify(f)] = (acc[classify(f)] || 0) + 1), acc), {});
  console.error(`unit: ${counts.unit ?? 0}, integration: ${counts.integration ?? 0}`);
} else if (mode === "unit" || mode === "integration") {
  for (const f of files) {
    if (classify(f) === mode) console.log(path.relative(process.cwd(), f));
  }
} else {
  console.error("usage: select-tests.mjs unit|integration|--explain");
  process.exit(2);
}
