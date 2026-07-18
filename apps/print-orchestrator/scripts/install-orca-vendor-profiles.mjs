#!/usr/bin/env node
// Installs the OrcaSlicer *system* (vendor) parent profiles the shipped catalog
// inherits from, so the quarantined machine/process/filament revisions can resolve
// and a working profile set can be built. Those parents ship inside OrcaSlicer
// (`resources/profiles/<Vendor>/…`), not in this repo — they are not redistributed
// here — so this is the deliberate, VERIFIABLE install step the deployment docs
// point at (see config/slicers/orca/vendor/README.md).
//
// It is pure filesystem + JSON (no deps, no network): it reads the catalog to learn
// exactly which parent *names* are missing, scans an OrcaSlicer resources directory
// for the profile JSONs carrying those names, and copies them into `vendor/`. It
// prints what it copied and what is still missing, and exits non-zero while any
// parent is unresolved — so it doubles as a release/readiness check.
//
// Usage:
//   node scripts/install-orca-vendor-profiles.mjs --orca-resources <dir> [--catalog <dir>] [--dry-run]
//   node scripts/install-orca-vendor-profiles.mjs --check            # verify only, copy nothing
//
// <dir> is an OrcaSlicer profiles tree, e.g. (Linux) ~/.config/OrcaSlicer/system
//   or the app's resources/profiles; (macOS) OrcaSlicer.app/Contents/Resources/profiles.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = { catalog: null, orcaResources: null, dryRun: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--orca-resources") args.orcaResources = argv[++i];
    else if (a === "--catalog") args.catalog = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--check") args.check = true;
    else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}

/** Every `.json` under `dir`, recursively (missing dir → []). */
function jsonFilesUnder(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonFilesUnder(abs));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) out.push(abs);
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** OrcaSlicer stores `name` as a string; some system files use a `.sub`/`from` shape — keep it simple. */
function profileName(obj) {
  return obj && typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : null;
}

/** A filesystem-safe file name for a copied parent, preserving readability. */
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "parent";
}

function requiredParents(catalogDir) {
  const catalog = readJson(path.join(catalogDir, "catalog.v1.json"));
  if (!catalog || !Array.isArray(catalog.profiles)) {
    throw new Error(`Не удалось прочитать ${path.join(catalogDir, "catalog.v1.json")}`);
  }
  const names = new Set(catalog.profiles.map((p) => p.name));
  // Parents already provided under vendor/ satisfy the requirement too.
  const vendorNames = new Set(
    jsonFilesUnder(path.join(catalogDir, "vendor"))
      .map((f) => profileName(readJson(f)))
      .filter(Boolean)
  );
  const missing = new Set();
  for (const p of catalog.profiles) {
    const parent = p.inherits;
    if (parent && !names.has(parent) && !vendorNames.has(parent)) missing.add(parent);
  }
  return [...missing].sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/install-orca-vendor-profiles.mjs --orca-resources <dir> [--catalog <dir>] [--dry-run|--check]"
    );
    process.exit(0);
  }
  const catalogDir = path.resolve(args.catalog ?? path.join(process.cwd(), "config", "slicers", "orca"));
  const vendorDir = path.join(catalogDir, "vendor");

  const missingBefore = requiredParents(catalogDir);
  if (missingBefore.length === 0) {
    console.log("✓ All inheritance parents are present — the catalog can form a working set.");
    process.exit(0);
  }

  if (args.check) {
    console.error(`✗ ${missingBefore.length} inheritance parent(s) still missing:`);
    for (const m of missingBefore) console.error(`   - ${m}`);
    console.error("\nRun with --orca-resources <OrcaSlicer profiles dir> to install them.");
    process.exit(1);
  }

  if (!args.orcaResources) {
    console.error("Missing --orca-resources <dir> (path to an OrcaSlicer profiles tree).");
    console.error(`Still missing (${missingBefore.length}):`);
    for (const m of missingBefore) console.error(`   - ${m}`);
    process.exit(2);
  }

  const wanted = new Set(missingBefore);
  const found = new Map(); // name → source file
  for (const file of jsonFilesUnder(path.resolve(args.orcaResources))) {
    const name = profileName(readJson(file));
    if (name && wanted.has(name) && !found.has(name)) found.set(name, file);
  }

  if (!args.dryRun) fs.mkdirSync(vendorDir, { recursive: true });
  for (const [name, src] of found) {
    const dest = path.join(vendorDir, `${slug(name)}.json`);
    if (args.dryRun) {
      console.log(`would copy  ${name}\n            ${src} → ${dest}`);
    } else {
      fs.copyFileSync(src, dest);
      console.log(`installed   ${name}  →  ${path.relative(catalogDir, dest)}`);
    }
  }

  const stillMissing = missingBefore.filter((m) => !found.has(m));
  console.log(
    `\n${found.size}/${missingBefore.length} parent(s) ${args.dryRun ? "found" : "installed"}; ${stillMissing.length} still missing.`
  );
  if (stillMissing.length > 0) {
    console.error("Still missing (not found under --orca-resources):");
    for (const m of stillMissing) console.error(`   - ${m}`);
    console.error(
      "\nUse the SAME OrcaSlicer release the bundles were pinned to (02.03.00.62 / 2.3.0),\nthen re-import: POST /api/print/slicing/presets/import"
    );
    process.exit(1);
  }
  console.log("\nNext: re-import the catalog (POST /api/print/slicing/presets/import) and verify");
  console.log("`missingParents` is empty at GET /api/print/slicing/runtime.");
}

main();
