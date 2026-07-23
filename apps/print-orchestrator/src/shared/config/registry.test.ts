import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Importing env composes every thematic builder (and the externals inventory),
// which registers the complete variable set as a side effect.
import "../env";
import { listRegisteredEnvVars } from "./registry";

/*
 * The registry ↔ .env.example correspondence check.
 *
 * The typed registry (shared/config) is the single inventory of every
 * environment variable this service or its deployment consumes. `.env.example`
 * is the operator-facing documentation of the same set. The two must not
 * drift: a variable read by code but undocumented is invisible to operators; a
 * variable documented but read by nothing is a broken promise.
 */

const ENV_EXAMPLE_PATH = path.resolve(__dirname, "../../../../../.env.example");

/** Variable names mentioned in .env.example (active `VAR=` lines and commented `# VAR=` examples). */
function readDocumentedVars(): Set<string> {
  const text = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

test("every registered env var is documented in .env.example", () => {
  const documented = readDocumentedVars();
  const missing = listRegisteredEnvVars()
    .map((v) => v.name)
    .filter((name) => !documented.has(name));
  assert.deepEqual(
    missing,
    [],
    `Variables consumed by the service but missing from .env.example:\n  ${missing.join("\n  ")}`
  );
});

test("every .env.example variable is declared in the registry", () => {
  const registered = new Set(listRegisteredEnvVars().map((v) => v.name));
  const undeclared = [...readDocumentedVars()].filter((name) => !registered.has(name)).sort();
  assert.deepEqual(
    undeclared,
    [],
    `Variables documented in .env.example but not declared in shared/config (add an envVar or externalVar):\n  ${undeclared.join("\n  ")}`
  );
});
