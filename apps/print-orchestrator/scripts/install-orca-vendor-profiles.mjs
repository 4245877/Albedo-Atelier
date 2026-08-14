#!/usr/bin/env node
// Installs the OrcaSlicer *system* (vendor) parent profiles the shipped catalog
// inherits from, so quarantined machine/process/filament revisions can resolve and
// a working profile set can be built. Those parents ship inside OrcaSlicer
// (`resources/profiles/<Vendor>/…`), not in an exported `.orca_printer` bundle.
//
// It is pure filesystem + JSON (no deps, no network) and models the same two rules
// the importer does — get either wrong and the installed parents are useless or,
// worse, silently wrong:
//
//   1. **the closure is transitive.** `Bambu Lab A1 0.4 PETG` inherits
//      `Bambu Lab A1 0.4 nozzle`, which inherits `fdm_bbl_3dp_001_common`, which
//      inherits `fdm_machine_common`. Installing only the parent the catalog names
//      leaves the profile quarantined on the *next* link, so this walks the whole
//      chain to its root;
//   2. **names are vendor-scoped.** The shipped tree has 46 files named
//      `fdm_machine_common` (41 with distinct content), two `fdm_bbl_3dp_001_common`
//      (BBL's and OrcaArena's), and so on. A first-match-by-name copy installs
//      another brand's base settings under a Bambu profile. So the walk locks onto
//      the vendor of the first system parent it resolves and stays in it, and files
//      are installed under `vendor/<Vendor>/<kind>/…` — never flattened into one
//      colliding namespace.
//
// It prints what it copied and what is still missing, and exits non-zero while any
// parent is unresolved — so it doubles as a release/readiness gate.
//
// Usage:
//   node scripts/install-orca-vendor-profiles.mjs --orca-resources <dir> [--catalog <dir>] [--dry-run]
//   node scripts/install-orca-vendor-profiles.mjs --check [--orca-resources <dir>]
//
// <dir> is an OrcaSlicer profiles tree, e.g. (Linux) the extracted AppImage's
//   resources/profiles or ~/.config/OrcaSlicer/system; (macOS)
//   OrcaSlicer.app/Contents/Resources/profiles.
//
// `--check` alone verifies what the LEAN image ships (vendor/ only). Adding
// --orca-resources also credits a mounted slicer runtime, matching a deployment
// that sets ORCA_SYSTEM_PROFILES_DIR.

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
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
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

function firstString(value) {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value.trim() || null : null;
}

const MANIFEST_KEYS = ["machine_model_list", "machine_list", "process_list", "filament_list"];

/** Directory-implied profile kind (`…/machine/x.json`). */
function typeOfDir(dir) {
  const d = dir.toLowerCase();
  if (d === "machine" || d === "printer") return "machine";
  if (d === "process" || d === "print") return "process";
  if (d === "filament") return "filament";
  return null;
}

/**
 * The three preset kinds only. A vendor manifest (`BBL.json`) or a `machine_model`
 * definition is NOT a preset and must never be installed as a parent.
 */
function profileType(obj, dirType) {
  if (MANIFEST_KEYS.some((k) => Array.isArray(obj[k]))) return null;
  const raw = firstString(obj.type);
  if (raw === "machine" || raw === "printer") return "machine";
  if (raw === "process" || raw === "print") return "process";
  if (raw === "filament") return "filament";
  if (raw) return null; // explicit but non-preset (machine_model, …)
  if (dirType) return dirType;
  if ("printer_model" in obj || "printable_area" in obj) return "machine";
  if ("filament_type" in obj || "filament_settings_id" in obj) return "filament";
  if ("layer_height" in obj || "print_settings_id" in obj) return "process";
  return null;
}

/**
 * Indexes a profile tree as `name → [{ name, type, vendor, file, inherits }]`.
 * `vendor` is the top folder under the root (`BBL`), or null for a file sitting
 * directly in it (an unscoped operator drop-in / a vendor manifest).
 */
function indexTree(root) {
  const byName = new Map();
  const abs = path.resolve(root);
  for (const file of jsonFilesUnder(abs)) {
    const obj = readJson(file);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const name = firstString(obj.name);
    if (!name) continue;
    const segments = path.relative(abs, file).split(path.sep);
    const vendor = segments.length >= 2 ? segments[0] : null;
    const dirType = segments.length >= 2 ? typeOfDir(segments[segments.length - 2]) : null;
    const type = profileType(obj, dirType);
    if (!type) continue;
    const entry = { name, type, vendor, file, inherits: firstString(obj.inherits) };
    const list = byName.get(name);
    if (list) list.push(entry);
    else byName.set(name, [entry]);
  }
  return byName;
}

/** Candidates for `name`/`type` in an index, honouring a locked vendor. */
function candidates(index, name, type, vendor) {
  const typed = (index.get(name) ?? []).filter((e) => e.type === type);
  if (!vendor) return typed;
  const sameVendor = typed.filter((e) => e.vendor === vendor);
  return sameVendor.length > 0 ? sameVendor : typed.filter((e) => !e.vendor);
}

/**
 * Walks the full inheritance closure of the catalog and reports, per required
 * parent, whether it is already satisfied (by the catalog itself or by `vendor/`),
 * resolvable from the slicer tree (→ `install`), ambiguous, or missing.
 */
function planClosure({ catalogDir, orcaResources }) {
  const catalog = readJson(path.join(catalogDir, "catalog.v1.json"));
  if (!catalog || !Array.isArray(catalog.profiles)) {
    throw new Error(`Не удалось прочитать ${path.join(catalogDir, "catalog.v1.json")}`);
  }
  const catalogNames = new Set(catalog.profiles.map((p) => `${p.type}:${p.name}`));
  const vendorIndex = indexTree(path.join(catalogDir, "vendor"));
  const orcaIndex = orcaResources ? indexTree(orcaResources) : new Map();

  const install = []; // { name, type, vendor, file }
  const missing = []; // { name, type, vendor, reason }
  const satisfied = []; // { name, type, source }
  const seen = new Set();

  /** Queue of parents still to resolve, each carrying the vendor its chain locked to. */
  const queue = [];
  for (const p of catalog.profiles) {
    if (p.inherits) queue.push({ name: p.inherits, type: p.type, vendor: null, via: p.name });
  }

  while (queue.length > 0) {
    const item = queue.shift();
    const key = `${item.type}:${item.name}:${item.vendor ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // A parent that is itself a catalog profile needs nothing installed; the
    // importer resolves it in-bundle (and its own parents are already queued).
    if (catalogNames.has(`${item.type}:${item.name}`)) {
      satisfied.push({ ...item, source: "catalog" });
      continue;
    }

    const installed = candidates(vendorIndex, item.name, item.type, item.vendor);
    if (installed.length > 0) {
      const chosen = installed[0];
      satisfied.push({ ...item, source: `vendor/${path.relative(path.join(catalogDir, "vendor"), chosen.file)}` });
      if (chosen.inherits) {
        queue.push({
          name: chosen.inherits,
          type: item.type,
          vendor: item.vendor ?? chosen.vendor,
          via: item.name
        });
      }
      continue;
    }

    const found = candidates(orcaIndex, item.name, item.type, item.vendor);
    if (found.length === 0) {
      missing.push({ ...item, reason: item.vendor ? `нет у вендора ${item.vendor}` : "нет в дереве профилей" });
      continue;
    }
    const vendors = [...new Set(found.map((e) => e.vendor).filter(Boolean))];
    if (!item.vendor && vendors.length > 1) {
      missing.push({ ...item, reason: `есть у нескольких вендоров (${vendors.join(", ")}) — неоднозначно` });
      continue;
    }
    const chosen = found[0];
    install.push(chosen);
    if (chosen.inherits) {
      queue.push({
        name: chosen.inherits,
        type: item.type,
        vendor: item.vendor ?? chosen.vendor,
        via: item.name
      });
    }
  }
  return { install, missing, satisfied };
}

/** Where an installed parent lands: `vendor/<Vendor>/<kind>/<original name>.json`. */
function destinationFor(vendorDir, entry) {
  const vendor = entry.vendor ?? "_unscoped";
  return path.join(vendorDir, vendor, entry.type, `${entry.name}.json`);
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

  if (args.check) {
    // Verify only: what is resolvable from what is already installed (plus a slicer
    // tree if one was named), with nothing copied.
    const plan = planClosure({ catalogDir, orcaResources: args.orcaResources });
    const unresolved = [...plan.missing, ...plan.install];
    if (unresolved.length === 0) {
      console.log(
        `✓ Замыкание наследования полное: ${plan.satisfied.length} родител(я/ей) на месте — каталог может собрать рабочий набор.`
      );
      process.exit(0);
    }
    console.error(`✗ Не хватает ${unresolved.length} родительск(ого/их) профил(я/ей):`);
    for (const m of plan.missing) console.error(`   - ${m.name} (${m.type}) — ${m.reason}`);
    for (const i of plan.install) {
      console.error(`   - ${i.name} (${i.type}) — есть в дереве OrcaSlicer, но не установлен в vendor/`);
    }
    console.error("\nЗапустите с --orca-resources <дерево профилей OrcaSlicer>, чтобы установить их.");
    process.exit(1);
  }

  if (!args.orcaResources) {
    console.error("Не указан --orca-resources <dir> (путь к дереву профилей OrcaSlicer).");
    process.exit(2);
  }

  const plan = planClosure({ catalogDir, orcaResources: args.orcaResources });
  if (plan.install.length === 0 && plan.missing.length === 0) {
    console.log("✓ Все родительские профили уже на месте — устанавливать нечего.");
    process.exit(0);
  }

  for (const entry of plan.install) {
    const dest = destinationFor(vendorDir, entry);
    if (args.dryRun) {
      console.log(`would copy  ${entry.name} (${entry.type})\n            ${entry.file} → ${dest}`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(entry.file, dest);
    console.log(`installed   ${entry.name} (${entry.type})  →  ${path.relative(catalogDir, dest)}`);
  }

  console.log(
    `\n${plan.install.length} родител(я/ей) ${args.dryRun ? "найдено" : "установлено"}; ` +
      `${plan.satisfied.length} уже были на месте; ${plan.missing.length} не найдено.`
  );
  if (plan.missing.length > 0) {
    console.error("\nНе найдены в --orca-resources (профиль отсутствует в этой сборке OrcaSlicer):");
    for (const m of plan.missing) console.error(`   - ${m.name} (${m.type}) ← из «${m.via}» — ${m.reason}`);
    console.error(
      "\nТакие пресеты остаются в карантине осознанно: их родителя нет в закреплённой сборке.\n" +
        "Используйте ту же сборку OrcaSlicer, из которой экспортировались бандлы."
    );
    process.exit(1);
  }
  console.log("\nДалее: переимпортируйте каталог (POST /api/print/slicing/presets/import) и проверьте,");
  console.log("что `missingParents` в GET /api/print/slicing/runtime пуст.");
}

main();
