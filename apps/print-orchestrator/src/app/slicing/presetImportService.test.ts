import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import type { PrintQueueStore } from "../../domain/print/repositories";
import { openPrintQueueStore } from "../../infra/db/store";
import { OrcaCatalogSource } from "../../infra/slicing/catalogSource";
import { PresetImportService } from "./presetImportService";

const REAL_CATALOG = path.resolve(__dirname, "../../../config/slicers/orca");

// ── Against the real vendored catalog (config/slicers/orca) ───────────────────

test("imports the real catalog: the installed vendor closure resolves 20 of 21 profiles", async () => {
  const store = openPrintQueueStore(":memory:");
  try {
    const service = new PresetImportService(store, new OrcaCatalogSource(REAL_CATALOG));
    const result = await service.import();

    assert.equal(result.totalProfiles, 21);
    assert.equal(result.counts.invalid, 0);
    assert.equal(result.counts.active, 20);
    assert.equal(result.counts.quarantined, 1);
    assert.equal(result.inserted, 21);

    // Source archives hash to what the catalog recorded (immutability).
    assert.equal(result.sourceIntegrity.ok, true);

    // Everything Bambu A1 (machine + processes + filaments) and every Creality
    // filament resolves through the vendor/ system parents.
    const active = result.profiles.filter((p) => p.status === "active").map((p) => p.name).sort();
    assert.deepEqual(active, [
      "0.08mm SuperDetail @Creality K2 0.2 nozzle - Copy",
      "@BBL A1 0.4 PLA",
      "Bambu Lab A1 0.4 PETG",
      "Creality",
      "Creality K2 0.4",
      "Creality K2 0.4 Balance",
      "Creality K2 0.4 FAST",
      "Creality K2 0.4 FAST1",
      "Creality PLA",
      "ENYONE PLA",
      "PETG 0.4mm @BBL A1",
      "PETG 0.4mm Quality @BBL A1",
      "PETG 0.6mm @BBL A1",
      "PETG 0.8mm @BBL A1",
      "PETG @K2",
      "PETG @K2 Balance",
      "PETG @K2 FAST1",
      "VVM PETG 0.4@BBL A1",
      "VVM PETG 0.6@BBL A1",
      "VVM PETG 0.8@BBL A1"
    ]);

    // Every parent resolves. The plain `Creality K2` family (never shipped by 2.3.0,
    // which only carries `Creality K2 Plus`) was added upstream in v2.3.2 — the exact
    // release these presets declare (`version: 2.3.2.74`) — and its closure is now
    // installed under vendor/Creality, so nothing is left dangling.
    assert.deepEqual(result.missingParents, []);

    // The replacement bundle is imported byte-for-byte. Its parent now resolves, but
    // the profile keeps the contradiction the operator exported into it — 0.4 mm of
    // declared nozzle against a "0.2" printer_variant — so it stays quarantined on
    // that alone. Installing a parent must never paper over a self-contradiction.
    const k2 = result.profiles.find((p) => p.name === "Creality K2 PETG 0.4 FAST");
    assert.ok(k2);
    assert.equal(k2.status, "quarantined");
    const codes = k2.blockers.map((b) => b.code);
    assert.ok(!codes.includes("missing_parent"));
    assert.deepEqual(codes, ["nozzle_variant_mismatch"]);
    assert.ok(!codes.includes("nozzle_parent_mismatch"));
  } finally {
    store.close();
  }
});

test("the Bambu Lab A1 0.4 machine resolves its whole BBL chain to real A1 hardware", async () => {
  const store = openPrintQueueStore(":memory:");
  try {
    await new PresetImportService(store, new OrcaCatalogSource(REAL_CATALOG)).import();
    const machine = store.repositories.profileRevisions
      .list("machine")
      .find((r) => r.name === "Bambu Lab A1 0.4 PETG");
    assert.ok(machine);
    assert.equal(machine.status, "active");
    assert.equal(machine.inherits, "Bambu Lab A1 0.4 nozzle");
    assert.deepEqual(machine.blockers, []);

    // Every link, in the BBL vendor and no other (46 files share the root's name).
    assert.equal(machine.metadata.vendor, "BBL");
    assert.deepEqual(machine.metadata.inheritanceChain, [
      "fdm_machine_common",
      "fdm_bbl_3dp_001_common",
      "Bambu Lab A1 0.4 nozzle",
      "Bambu Lab A1 0.4 PETG"
    ]);
    assert.equal(machine.metadata.inheritanceLevels, 3);

    // The resolved settings are what OrcaSlicer is actually fed: a 256³ A1 with a
    // 0.4 nozzle, and layer limits inherited from the BBL parents.
    const resolved = JSON.parse(machine.resolvedJson ?? "{}");
    assert.deepEqual(resolved.nozzle_diameter, ["0.4"]);
    assert.equal(resolved.printer_variant, "0.4");
    assert.equal(resolved.printer_model, "Bambu Lab A1");
    assert.equal(resolved.printable_height, "256");
    assert.deepEqual(resolved.printable_area, ["0x0", "256x0", "256x256", "0x256"]);
    assert.deepEqual(resolved.max_layer_height, ["0.28"]);
    assert.deepEqual(resolved.min_layer_height, ["0.08"]);
  } finally {
    store.close();
  }
});

test("A1 PETG filament and both A1 process families resolve through their BBL parents", async () => {
  const store = openPrintQueueStore(":memory:");
  try {
    await new PresetImportService(store, new OrcaCatalogSource(REAL_CATALOG)).import();
    const repos = store.repositories;

    // PETG filament: inherits the system Bambu PLA Basic @BBL A1 chain, but its own
    // PETG values must win the merge (this is what the slicer receives).
    const petg = repos.profileRevisions.list("filament").find((r) => r.name === "VVM PETG 0.4@BBL A1");
    assert.ok(petg);
    assert.equal(petg.status, "active");
    assert.equal(petg.metadata.vendor, "BBL");
    assert.deepEqual(petg.metadata.inheritanceChain, [
      "fdm_filament_common",
      "fdm_filament_pla",
      "Bambu PLA Basic @base",
      "Bambu PLA Basic @BBL A1",
      "VVM PETG 0.4@BBL A1"
    ]);
    const petgResolved = JSON.parse(petg.resolvedJson ?? "{}");
    assert.deepEqual(petgResolved.filament_type, ["PETG"]);

    // PLA process (0.20mm Strength @BBL A1) and PETG process (0.20mm Standard @BBL A1)
    // both resolve — the operator can pick either material's process for the A1.
    const pla = repos.profileRevisions.list("process").find((r) => r.name === "@BBL A1 0.4 PLA");
    assert.ok(pla);
    assert.equal(pla.status, "active");
    assert.equal(pla.metadata.vendor, "BBL");
    assert.ok((pla.metadata.inheritanceChain as string[]).includes("0.20mm Strength @BBL A1"));

    const petgProcess = repos.profileRevisions.list("process").find((r) => r.name === "PETG 0.4mm @BBL A1");
    assert.ok(petgProcess);
    assert.equal(petgProcess.status, "active");
    assert.ok((petgProcess.metadata.inheritanceChain as string[]).includes("0.20mm Standard @BBL A1"));
    // A thin user diff (20 keys) inherits a full process definition (100+ keys) —
    // the layer height itself comes from the system `0.20mm Standard @BBL A1`.
    const processResolved = JSON.parse(petgProcess.resolvedJson ?? "{}");
    assert.ok(Object.keys(processResolved).length > 100);
    assert.equal(processResolved.layer_height, "0.2");
    assert.equal(processResolved.print_settings_id, "PETG 0.4mm @BBL A1");
  } finally {
    store.close();
  }
});

test("the Creality K2 processes resolve through the installed v2.3.2 0.2-nozzle parent", async () => {
  const store = openPrintQueueStore(":memory:");
  try {
    const result = await new PresetImportService(store, new OrcaCatalogSource(REAL_CATALOG)).import();
    const quarantined = result.profiles.filter((p) => p.status === "quarantined").map((p) => p.name).sort();
    // Only the self-contradicting machine profile is left; every process resolved.
    assert.deepEqual(quarantined, ["Creality K2 PETG 0.4 FAST"]);

    const k2 = result.profiles.find((p) => p.name === "Creality K2 0.4");
    assert.equal(k2?.status, "active");
    assert.deepEqual(k2?.blockers, []);

    // It must resolve through the *Creality* chain — a same-named parent from
    // another vendor would silently merge the wrong base settings.
    const rev = store.repositories.profileRevisions
      .list("process")
      .find((r) => r.name === "Creality K2 0.4");
    assert.equal(rev?.metadata.vendor, "Creality");
    assert.deepEqual(rev?.metadata.inheritanceChain, [
      "fdm_process_common",
      "fdm_process_creality_common",
      "fdm_process_common_klipper",
      "0.08mm SuperDetail @Creality K2 0.2 nozzle",
      "Creality K2 0.4"
    ]);
  } finally {
    store.close();
  }
});

test("the shipped vendor/ closure alone resolves the catalog — no slicer runtime needed", async () => {
  // The production/lean-container case: the image carries config/ but no OrcaSlicer
  // mount, so `vendor/` MUST be self-sufficient. Re-run over a copy that has only
  // the committed vendor/ tree and no ORCA_SYSTEM_PROFILES_DIR.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orca-lean-"));
  const store = openPrintQueueStore(":memory:");
  try {
    fs.cpSync(REAL_CATALOG, tmp, { recursive: true });
    const result = await new PresetImportService(store, new OrcaCatalogSource(tmp, [])).import();
    assert.equal(result.counts.active, 20);
    assert.deepEqual(result.missingParents, []);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("re-importing the real catalog is idempotent (no new revisions, nothing changes)", async () => {
  // Also covers load order: the second pass re-resolves every chain from scratch and
  // must reach byte-identical resolved settings, whatever order files are visited in.
  const store = openPrintQueueStore(":memory:");
  try {
    const service = new PresetImportService(store, new OrcaCatalogSource(REAL_CATALOG));
    await service.import();
    const second = await service.import();
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.unchanged, 21);
    // Still exactly 21 revisions in the table.
    assert.equal(store.repositories.profileRevisions.list().length, 21);
  } finally {
    store.close();
  }
});

// ── Against a synthetic catalog we can mutate ─────────────────────────────────

let TMP: string;
let store: PrintQueueStore;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orca-import-"));
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, "profiles/machine"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "profiles/process"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "profiles/filament"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "vendor"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "sources"), { recursive: true });
});

function sha(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface SynProfile {
  type: "machine" | "process" | "filament";
  name: string;
  inherits?: string | null;
  settings: Record<string, unknown>;
}

/** Writes a synthetic catalog (sources + profiles) with correct SHA-256s. */
function writeCatalog(profiles: SynProfile[]): void {
  const archive = Buffer.from("fake-archive-bytes");
  fs.writeFileSync(path.join(TMP, "sources/bundle.zip"), archive);
  const profileEntries = profiles.map((p, i) => {
    const rel = `profiles/${p.type}/${slug(p.name)}-${i}.json`;
    const body = JSON.stringify({ name: p.name, type: p.type, inherits: p.inherits ?? "", ...p.settings });
    fs.writeFileSync(path.join(TMP, rel), body);
    return {
      logicalId: `${p.type}:${p.name}`,
      type: p.type,
      name: p.name,
      file: rel,
      sha256: sha(Buffer.from(body)),
      sizeBytes: Buffer.byteLength(body),
      inherits: p.inherits ?? null,
      from: "User",
      sources: ["bundle"]
    };
  });
  const catalog = {
    catalogVersion: 1,
    slicer: "OrcaSlicer",
    sources: [
      { id: "bundle", file: "sources/bundle.zip", originalName: "bundle.zip", sha256: sha(archive), sizeBytes: archive.length, bundleType: "printer config bundle", orcaVersion: "02.03.00.62" }
    ],
    profiles: profileEntries
  };
  fs.writeFileSync(path.join(TMP, "catalog.v1.json"), JSON.stringify(catalog, null, 2));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function newStore(): PrintQueueStore {
  return openPrintQueueStore(":memory:");
}

test("a valid root filament and its child both import as active", async () => {
  writeCatalog([
    { type: "filament", name: "Base", inherits: "", settings: { filament_type: ["PLA"], nozzle_temperature: ["210"] } },
    { type: "filament", name: "Child", inherits: "Base", settings: { nozzle_temperature: ["215"] } }
  ]);
  store = newStore();
  try {
    const result = await new PresetImportService(store, new OrcaCatalogSource(TMP)).import();
    assert.equal(result.counts.active, 2);
    assert.equal(result.counts.quarantined, 0);
  } finally {
    store.close();
  }
});

test("a machine with a missing parent quarantines, then a vendor parent un-quarantines it on re-import", async () => {
  writeCatalog([
    {
      type: "machine",
      name: "My Printer",
      inherits: "System Base",
      settings: { nozzle_diameter: ["0.4"], printer_variant: "0.4", gcode_flavor: "klipper", printable_area: ["0x0", "220x0", "220x220", "0x220"], printable_height: "250" }
    }
  ]);
  store = newStore();
  try {
    const service = new PresetImportService(store, new OrcaCatalogSource(TMP));
    const first = await service.import();
    assert.equal(first.counts.quarantined, 1);
    assert.deepEqual(first.missingParents, ["System Base"]);

    // Drop the system parent into vendor/ and re-import — it now resolves.
    fs.writeFileSync(
      path.join(TMP, "vendor/system-base.json"),
      JSON.stringify({ name: "System Base", type: "machine", max_layer_height: ["0.3"], min_layer_height: ["0.08"] })
    );
    const second = await service.import();
    assert.equal(second.counts.active, 1);
    assert.equal(second.counts.quarantined, 0);
    assert.equal(second.updated, 1);
  } finally {
    store.close();
  }
});

test("a profile whose bytes drifted from the catalog SHA-256 is quarantined (content_drift)", async () => {
  writeCatalog([
    { type: "filament", name: "Base", inherits: "", settings: { filament_type: ["PLA"], nozzle_temperature: ["210"] } }
  ]);
  // Tamper the file after the catalog recorded its hash.
  const file = fs.readdirSync(path.join(TMP, "profiles/filament"))[0];
  const abs = path.join(TMP, "profiles/filament", file);
  const body = JSON.parse(fs.readFileSync(abs, "utf8"));
  body.nozzle_temperature = ["999"];
  fs.writeFileSync(abs, JSON.stringify(body));

  store = newStore();
  try {
    const result = await new PresetImportService(store, new OrcaCatalogSource(TMP)).import();
    const p = result.profiles[0];
    assert.equal(p.status, "quarantined");
    assert.ok(p.blockers.some((b) => b.code === "content_drift"));
  } finally {
    store.close();
  }
});

test("verifySources flags a tampered source archive", async () => {
  writeCatalog([
    { type: "filament", name: "Base", inherits: "", settings: { filament_type: ["PLA"], nozzle_temperature: ["210"] } }
  ]);
  fs.writeFileSync(path.join(TMP, "sources/bundle.zip"), Buffer.from("tampered"));
  store = newStore();
  try {
    const result = await new PresetImportService(store, new OrcaCatalogSource(TMP)).import();
    assert.equal(result.sourceIntegrity.ok, false);
    assert.equal(result.sourceIntegrity.sources[0].ok, false);
  } finally {
    store.close();
  }
});

// ── Vendor-scoped system parents (synthetic trees) ───────────────────────────

/** Writes a system profile into `vendor/<vendor>/<type>/<name>.json`. */
function writeVendor(vendor: string | null, p: SynProfile): void {
  const rel = vendor ? path.join("vendor", vendor, p.type, `${p.name}.json`) : path.join("vendor", `${p.name}.json`);
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    JSON.stringify({ name: p.name, type: p.type, inherits: p.inherits ?? "", ...p.settings })
  );
}

test("a user preset resolves through the vendor its parent belongs to, not a namesake", async () => {
  // Two vendors ship `fdm_machine_common` with different content — the shipped
  // OrcaSlicer tree has 46 of them. Resolution must follow BBL, because that is
  // where the chain's first system parent lives.
  writeCatalog([
    {
      type: "machine",
      name: "Bambu Lab A1 0.4 PETG",
      inherits: "Bambu Lab A1 0.4 nozzle",
      settings: { nozzle_diameter: ["0.4"], printer_variant: "0.4", printer_model: "Bambu Lab A1" }
    }
  ]);
  writeVendor("BBL", {
    type: "machine",
    name: "Bambu Lab A1 0.4 nozzle",
    inherits: "fdm_machine_common",
    settings: { printable_area: ["0x0", "256x0", "256x256", "0x256"], printable_height: "256" }
  });
  writeVendor("BBL", { type: "machine", name: "fdm_machine_common", settings: { max_layer_height: ["0.28"] } });
  writeVendor("Anker", { type: "machine", name: "fdm_machine_common", settings: { max_layer_height: ["0.1"] } });

  store = newStore();
  try {
    const result = await new PresetImportService(store, new OrcaCatalogSource(TMP)).import();
    assert.equal(result.counts.active, 1);
    const rev = store.repositories.profileRevisions.list("machine")[0];
    assert.equal(rev.metadata.vendor, "BBL");
    // Anker's 0.1 mm ceiling must NOT have leaked into a Bambu profile.
    assert.deepEqual(JSON.parse(rev.resolvedJson ?? "{}").max_layer_height, ["0.28"]);
  } finally {
    store.close();
  }
});

test("a parent shipped by two vendors with no vendor context is quarantined as ambiguous", async () => {
  writeCatalog([
    { type: "filament", name: "My PLA", inherits: "fdm_filament_common", settings: { filament_type: ["PLA"] } }
  ]);
  writeVendor("BBL", { type: "filament", name: "fdm_filament_common", settings: { nozzle_temperature: ["220"] } });
  writeVendor("Creality", { type: "filament", name: "fdm_filament_common", settings: { nozzle_temperature: ["200"] } });

  store = newStore();
  try {
    const result = await new PresetImportService(store, new OrcaCatalogSource(TMP)).import();
    assert.equal(result.counts.quarantined, 1);
    const blocker = result.profiles[0].blockers[0];
    assert.equal(blocker.code, "ambiguous_parent");
    assert.match(blocker.message, /BBL, Creality/);
    // Reported to the operator alongside the genuinely missing ones.
    assert.deepEqual(result.missingParents, ["fdm_filament_common"]);
  } finally {
    store.close();
  }
});

test("installing the missing link of a deep chain un-quarantines it; removing it re-quarantines", async () => {
  // Load order in the large sense: a chain is only usable once EVERY link exists,
  // and the importer re-evaluates existing revisions on each pass in both directions.
  writeCatalog([
    {
      type: "machine",
      name: "My A1",
      inherits: "A1 nozzle",
      settings: { nozzle_diameter: ["0.4"], printer_variant: "0.4" }
    }
  ]);
  writeVendor("BBL", { type: "machine", name: "A1 nozzle", inherits: "bbl common", settings: {} });

  store = newStore();
  try {
    const service = new PresetImportService(store, new OrcaCatalogSource(TMP));
    // Only the first link is installed → still quarantined, now on the NEXT link.
    const first = await service.import();
    assert.equal(first.counts.quarantined, 1);
    assert.deepEqual(first.missingParents, ["bbl common"]);

    // Complete the closure → active, without rewriting the raw bytes.
    writeVendor("BBL", { type: "machine", name: "bbl common", settings: { max_layer_height: ["0.28"] } });
    const second = await service.import();
    assert.equal(second.counts.active, 1);
    assert.equal(second.updated, 1);
    assert.equal(store.repositories.profileRevisions.list().length, 1);

    // A third pass changes nothing (idempotent re-import).
    const third = await service.import();
    assert.equal(third.unchanged, 1);

    // And removing the parent again puts it straight back in quarantine.
    fs.rmSync(path.join(TMP, "vendor/BBL/machine/bbl common.json"));
    const fourth = await service.import();
    assert.equal(fourth.counts.quarantined, 1);
    assert.equal(fourth.counts.active, 0);
  } finally {
    store.close();
  }
});

test("a machine whose nozzle contradicts its inherited variant is quarantined even with the parent present", async () => {
  // Validation is not weakened by having the parents: a 0.4 nozzle declared on a
  // profile inheriting the 0.2-nozzle machine is a real contradiction.
  writeCatalog([
    {
      type: "machine",
      name: "K2 0.4 on 0.2 parent",
      inherits: "K2 0.2 nozzle",
      settings: { nozzle_diameter: ["0.4"], printer_variant: "0.2" }
    }
  ]);
  writeVendor("Creality", {
    type: "machine",
    name: "K2 0.2 nozzle",
    settings: { printable_area: ["0x0", "260x0", "260x260", "0x260"], printable_height: "260" }
  });

  store = newStore();
  try {
    const result = await new PresetImportService(store, new OrcaCatalogSource(TMP)).import();
    assert.equal(result.counts.quarantined, 1);
    const codes = result.profiles[0].blockers.map((b) => b.code);
    assert.deepEqual(codes, ["nozzle_variant_mismatch"]);
  } finally {
    store.close();
  }
});

test("a vendor manifest or machine_model file in vendor/ is never used as a parent", async () => {
  writeCatalog([
    { type: "machine", name: "My A1", inherits: "Bambu Lab A1", settings: { nozzle_diameter: ["0.4"] } }
  ]);
  // A `machine_model` definition carries the marketing name "Bambu Lab A1" — it is
  // NOT a preset and must not satisfy an `inherits`.
  fs.mkdirSync(path.join(TMP, "vendor/BBL/machine"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP, "vendor/BBL/machine/Bambu Lab A1.json"),
    JSON.stringify({ type: "machine_model", name: "Bambu Lab A1", nozzle_diameter: "0.2;0.4" })
  );
  fs.writeFileSync(
    path.join(TMP, "vendor/BBL.json"),
    JSON.stringify({ name: "Bambulab", machine_model_list: [], machine_list: [], process_list: [], filament_list: [] })
  );

  store = newStore();
  try {
    const result = await new PresetImportService(store, new OrcaCatalogSource(TMP)).import();
    assert.equal(result.counts.quarantined, 1);
    assert.equal(result.profiles[0].blockers[0].code, "missing_parent");
  } finally {
    store.close();
  }
});

test("an OrcaSlicer resources tree can supply the parents instead of vendor/", async () => {
  // The compose.orca.yml deployment: no files copied into vendor/, the mounted
  // slicer's own resources/profiles tree resolves the chain.
  writeCatalog([
    {
      type: "process",
      name: "PETG 0.4mm @BBL A1",
      inherits: "0.20mm Standard @BBL A1",
      settings: { layer_height: "0.2" }
    }
  ]);
  const tree = path.join(TMP, "orca-resources");
  fs.mkdirSync(path.join(tree, "BBL/process"), { recursive: true });
  fs.writeFileSync(
    path.join(tree, "BBL/process/0.20mm Standard @BBL A1.json"),
    JSON.stringify({ name: "0.20mm Standard @BBL A1", type: "process", initial_layer_print_height: "0.2" })
  );

  store = newStore();
  try {
    const result = await new PresetImportService(store, new OrcaCatalogSource(TMP, [tree])).import();
    assert.equal(result.counts.active, 1);
    const rev = store.repositories.profileRevisions.list("process")[0];
    assert.equal(rev.metadata.vendor, "BBL");
    assert.equal(JSON.parse(rev.resolvedJson ?? "{}").initial_layer_print_height, "0.2");
  } finally {
    store.close();
  }
});

test("vendor/ wins over the slicer tree for the same profile (operator override)", async () => {
  writeCatalog([
    { type: "filament", name: "Mine", inherits: "Base", settings: { filament_type: ["PETG"] } }
  ]);
  writeVendor("BBL", { type: "filament", name: "Base", settings: { nozzle_temperature: ["250"] } });
  const tree = path.join(TMP, "orca-resources");
  fs.mkdirSync(path.join(tree, "BBL/filament"), { recursive: true });
  fs.writeFileSync(
    path.join(tree, "BBL/filament/Base.json"),
    JSON.stringify({ name: "Base", type: "filament", nozzle_temperature: ["999"] })
  );

  store = newStore();
  try {
    await new PresetImportService(store, new OrcaCatalogSource(TMP, [tree])).import();
    const rev = store.repositories.profileRevisions.list("filament")[0];
    assert.deepEqual(JSON.parse(rev.resolvedJson ?? "{}").nozzle_temperature, ["250"]);
  } finally {
    store.close();
  }
});

test("a revision left over from an older catalog is re-evaluated, not frozen at its old verdict", async () => {
  // Production case: `Creality Hyper PLA @BBL A1 - Copy` was imported from a bundle
  // that a later re-staging dropped. It stayed quarantined on «Bambu PLA Basic @BBL A1»
  // long after that parent was installed, because the importer only ever looked at
  // profiles the CURRENT catalog lists.
  writeCatalog([
    { type: "filament", name: "Kept", inherits: "Bambu PLA Basic @BBL A1", settings: { filament_type: ["PETG"] } },
    { type: "filament", name: "Dropped Later", inherits: "Bambu PLA Basic @BBL A1", settings: { filament_type: ["PLA"] } }
  ]);
  store = newStore();
  try {
    const service = new PresetImportService(store, new OrcaCatalogSource(TMP));
    const first = await service.import();
    assert.equal(first.counts.quarantined, 2);

    // Re-stage the catalog WITHOUT the second profile, and install the parent.
    writeCatalog([
      { type: "filament", name: "Kept", inherits: "Bambu PLA Basic @BBL A1", settings: { filament_type: ["PETG"] } }
    ]);
    writeVendor("BBL", {
      type: "filament",
      name: "Bambu PLA Basic @BBL A1",
      settings: { nozzle_temperature: ["240"] }
    });

    const second = await service.import();
    // The catalog profile resolves…
    assert.equal(second.counts.active, 1);
    assert.equal(second.totalProfiles, 1);
    // …and so does the orphan, which is reported separately and flagged.
    assert.equal(second.orphans.length, 1);
    assert.equal(second.orphans[0].name, "Dropped Later");
    assert.equal(second.orphans[0].status, "active");
    assert.deepEqual(second.orphans[0].blockers, []);
    assert.ok(second.orphans[0].warnings.some((w) => w.code === "not_in_catalog"));
    assert.deepEqual(second.missingParents, []);

    // Both rows survive in the table with their own immutable bytes.
    assert.equal(store.repositories.profileRevisions.list().length, 2);
    const orphanRow = store.repositories.profileRevisions.list().find((r) => r.name === "Dropped Later");
    assert.equal(orphanRow?.status, "active");
    assert.deepEqual(JSON.parse(orphanRow?.resolvedJson ?? "{}").nozzle_temperature, ["240"]);
  } finally {
    store.close();
  }
});

test("an orphan whose parent is still missing stays quarantined and is still reported", async () => {
  writeCatalog([
    { type: "process", name: "Gone", inherits: "0.08mm SuperDetail @Creality K2 0.2 nozzle", settings: { layer_height: "0.08" } }
  ]);
  store = newStore();
  try {
    const service = new PresetImportService(store, new OrcaCatalogSource(TMP));
    await service.import();
    writeCatalog([{ type: "process", name: "Other", inherits: "", settings: { layer_height: "0.2" } }]);

    const second = await service.import();
    assert.equal(second.orphans.length, 1);
    assert.equal(second.orphans[0].status, "quarantined");
    assert.deepEqual(second.missingParents, ["0.08mm SuperDetail @Creality K2 0.2 nozzle"]);
  } finally {
    store.close();
  }
});
