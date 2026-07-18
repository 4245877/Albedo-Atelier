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

test("imports the real catalog: 3 active filaments, the rest quarantined on missing vendor parents", async () => {
  const store = openPrintQueueStore(":memory:");
  try {
    const service = new PresetImportService(store, new OrcaCatalogSource(REAL_CATALOG));
    const result = await service.import();

    assert.equal(result.totalProfiles, 25);
    assert.equal(result.counts.invalid, 0);
    assert.equal(result.counts.active, 3);
    assert.equal(result.counts.quarantined, 22);
    assert.equal(result.inserted, 25);

    // Source archives hash to what the catalog recorded (immutability).
    assert.equal(result.sourceIntegrity.ok, true);

    // The three self-rooted Creality filaments resolve and go active.
    const active = result.profiles.filter((p) => p.status === "active").map((p) => p.name).sort();
    assert.deepEqual(active, ["Creality", "Creality PLA", "ENYONE PLA"]);

    // All seven OrcaSlicer system parents are reported missing. The K2 machine now
    // inherits the 0.4 nozzle base (the 0.4/0.2 contradiction was corrected in the
    // catalog), so the missing K2 machine parent is "…0.4 nozzle".
    assert.deepEqual(result.missingParents, [
      "0.08mm SuperDetail @Creality K2 0.2 nozzle",
      "0.20mm Standard @BBL A1",
      "0.20mm Strength @BBL A1",
      "Bambu Lab A1 0.4 nozzle",
      "Bambu PLA Basic @BBL A1",
      "Creality Generic PLA @K2-all",
      "Creality K2 0.4 nozzle"
    ]);

    // The K2 machine is still quarantined — but now ONLY for its missing parent; the
    // former 0.4-vs-0.2 nozzle contradiction is fixed (variant + inherits are 0.4).
    const k2 = result.profiles.find((p) => p.name === "Creality K2 PETG 0.4 FAST");
    assert.ok(k2);
    assert.equal(k2.status, "quarantined");
    const codes = k2.blockers.map((b) => b.code);
    assert.ok(codes.includes("missing_parent"));
    assert.ok(!codes.includes("nozzle_variant_mismatch"));
    assert.ok(!codes.includes("nozzle_parent_mismatch"));
  } finally {
    store.close();
  }
});

test("re-importing the real catalog is idempotent (no new revisions, nothing changes)", async () => {
  const store = openPrintQueueStore(":memory:");
  try {
    const service = new PresetImportService(store, new OrcaCatalogSource(REAL_CATALOG));
    await service.import();
    const second = await service.import();
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.unchanged, 25);
    // Still exactly 25 revisions in the table.
    assert.equal(store.repositories.profileRevisions.list().length, 25);
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
