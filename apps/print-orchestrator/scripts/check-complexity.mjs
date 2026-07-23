#!/usr/bin/env node
/**
 * Warn-only complexity & file-size guard (P3.5).
 *
 * Reports source files that exceed soft budgets — total lines, and a rough
 * per-function length heuristic (a crude cyclomatic-ish proxy: lines between a
 * function/method header and its matching closing brace at the same column).
 * It NEVER fails the build: it prints findings and always exits 0, so it lands
 * as guidance first. Flip `--strict` (or CI wiring) later to enforce.
 *
 * Deliberately dependency-free (no eslint/ts-morph): a regex+brace scan is good
 * enough to flag the outliers a decomposition pass should look at, and it runs
 * anywhere `node` does.
 *
 * Usage:
 *   node scripts/check-complexity.mjs            # warn-only, exit 0
 *   node scripts/check-complexity.mjs --strict   # exit 1 if anything exceeds
 *   node scripts/check-complexity.mjs --json      # machine-readable
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src");
const FILE_LINE_BUDGET = 600;
const FUNC_LINE_BUDGET = 120;

const strict = process.argv.includes("--strict");
const asJson = process.argv.includes("--json");

/** Source files (not tests), recursively. */
function collect(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/**
 * Rough longest-function estimate: for each line that looks like a function or
 * method header, find the matching close of the block it opens and measure the
 * span. Approximate by design — it only needs to surface the long ones.
 */
function longestFunction(lines) {
  const headerRe = /(function\b|=>\s*\{|\)\s*\{|\)\s*:\s*[\w<>[\]., |&]+\s*\{)/;
  let worst = { lines: 0, at: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!headerRe.test(line) || line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    // Only count blocks that actually open on this line.
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    let depth = opens - closes;
    if (depth <= 0) continue;
    let j = i;
    for (j = i + 1; j < lines.length && depth > 0; j++) {
      depth += (lines[j].match(/\{/g) || []).length;
      depth -= (lines[j].match(/\}/g) || []).length;
    }
    const span = j - i;
    if (span > worst.lines) worst = { lines: span, at: i + 1 };
  }
  return worst;
}

const findings = [];
for (const file of collect(ROOT)) {
  const rel = path.relative(process.cwd(), file);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const fileLines = lines.length;
  const worst = longestFunction(lines);
  const flags = [];
  if (fileLines > FILE_LINE_BUDGET) flags.push({ kind: "file-length", value: fileLines, budget: FILE_LINE_BUDGET });
  if (worst.lines > FUNC_LINE_BUDGET) {
    flags.push({ kind: "function-length", value: worst.lines, budget: FUNC_LINE_BUDGET, at: worst.at });
  }
  if (flags.length) findings.push({ file: rel, fileLines, flags });
}

findings.sort((a, b) => b.fileLines - a.fileLines);

if (asJson) {
  console.log(JSON.stringify({ fileBudget: FILE_LINE_BUDGET, funcBudget: FUNC_LINE_BUDGET, findings }, null, 2));
} else if (findings.length === 0) {
  console.log(`✓ complexity: no file over ${FILE_LINE_BUDGET} lines, no function over ${FUNC_LINE_BUDGET} lines`);
} else {
  console.log(`⚠ complexity (warn-only): ${findings.length} file(s) over budget ` +
    `(file ${FILE_LINE_BUDGET} lines / function ${FUNC_LINE_BUDGET} lines)\n`);
  for (const f of findings) {
    for (const flag of f.flags) {
      if (flag.kind === "file-length") {
        console.log(`  ${f.file}: ${flag.value} lines (> ${flag.budget})`);
      } else {
        console.log(`  ${f.file}:${flag.at}: function ~${flag.value} lines (> ${flag.budget})`);
      }
    }
  }
}

process.exit(strict && findings.length ? 1 : 0);
