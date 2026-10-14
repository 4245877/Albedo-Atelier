import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import type { PrintQueueStore } from "../../domain/print/repositories";
import type { ProfileRevision } from "../../domain/slicing/types";
import { openPrintQueueStore } from "../../infra/db/store";
import { OrcaCatalogSource } from "../../infra/slicing/catalogSource";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ArtifactService } from "../artifacts/artifactService";
import { PresetImportService } from "./presetImportService";
import { ProfileService, type SlicerPrinterRef } from "./profileService";
import { SliceService } from "./sliceService";
import { FakeOrcaRunner } from "./testkit/fakeOrcaRunner";

// HIGH-10: an approved revision's effective settings never change under its id.
//
// The importer used to key a revision by its raw bytes alone and re-derive the
// resolved (inheritance-merged) settings in place on every import. Editing a
// PARENT preset therefore rewrote what every child resolved to — under the child
// revision id an approved set pins. The set stayed approved and the next slice
// used settings nobody had approved. Now the same bytes resolving differently are
// a new revision; the old one keeps its settings and is marked superseded.

const PRINTERS: SlicerPrinterRef[] = [
  { id: "creality-k2", name: "Creality K2", model: "Creality K2", material: "PETG", protocol: "moonraker" }
];

const LIMITS = {
  zipMaxEntries: 1000,
  zipMaxEntryBytes: 64 * 1024 * 1024,
  zipMaxTotalBytes: 128 * 1024 * 1024,
  zipMaxRatio: 200,
  xmlMaxBytes: 16 * 1024 * 1024
};

let TMP: string;
let CATALOG: string;
let store: PrintQueueStore;
let importer: PresetImportService;
let profiles: ProfileService;
let artifacts: ArtifactService;
let runner: FakeOrcaRunner;
let slice: SliceService;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "profile-immutability-"));
  CATALOG = path.join(TMP, "catalog");
  for (const dir of ["profiles/machine", "profiles/process", "profiles/filament", "vendor", "sources"]) {
    fs.mkdirSync(path.join(CATALOG, dir), { recursive: true });
  }
  store = openPrintQueueStore(":memory:");
  importer = new PresetImportService(store, new OrcaCatalogSource(CATALOG));
  runner = new FakeOrcaRunner();
  profiles = new ProfileService(store, runner, () => PRINTERS);
  const storage = new ArtifactStorage({ root: path.join(TMP, "artifacts") });
  await storage.init();
  artifacts = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 8 * 1024 * 1024,
    timeoutMs: 10000,
    concurrency: 2
  });
  slice = new SliceService(store, storage, artifacts, runner, {
    tmpRoot: path.join(TMP, "work"),
    timeoutMs: 5000,
    concurrency: 1
  });
});

afterEach(() => {
  slice.close();
  artifacts.close();
  store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── Catalog fixture ──────────────────────────────────────────────────────────

interface Preset {
  type: "machine" | "process" | "filament";
  name: string;
  inherits?: string;
  settings: Record<string, unknown>;
}

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** The operator's own base machine preset; children inherit it. */
function k2Base(printableHeight: string): Preset {
  return {
    type: "machine",
    name: "K2 Base",
    settings: {
      printer_model: "Creality K2",
      nozzle_diameter: ["0.4"],
      printer_variant: "0.4",
      gcode_flavor: "klipper",
      printable_area: ["0x0", "260x0", "260x260", "0x260"],
      printable_height: printableHeight,
      max_layer_height: ["0.3"],
      min_layer_height: ["0.08"]
    }
  };
}

const K2_PETG: Preset = { type: "machine", name: "K2 PETG 0.4", inherits: "K2 Base", settings: { printer_settings_id: "K2 PETG 0.4" } };
const PROCESS: Preset = {
  type: "process",
  name: "K2 Standard 0.2",
  settings: { layer_height: "0.2", initial_layer_print_height: "0.2" }
};
const FILAMENT: Preset = {
  type: "filament",
  name: "PETG @K2",
  settings: { filament_type: ["PETG"], nozzle_temperature: ["245"], nozzle_temperature_initial_layer: ["245"] }
};

/** Stages a catalog (fresh files, correct hashes) — as re-exporting from Orca does. */
function stage(presets: Preset[]): void {
  fs.rmSync(path.join(CATALOG, "profiles"), { recursive: true, force: true });
  for (const dir of ["profiles/machine", "profiles/process", "profiles/filament"]) {
    fs.mkdirSync(path.join(CATALOG, dir), { recursive: true });
  }
  const archive = Buffer.from("bundle-bytes");
  fs.writeFileSync(path.join(CATALOG, "sources/bundle.zip"), archive);
  const entries = presets.map((p, i) => {
    const rel = `profiles/${p.type}/p${i}.json`;
    const body = JSON.stringify({ name: p.name, type: p.type, inherits: p.inherits ?? "", ...p.settings });
    fs.writeFileSync(path.join(CATALOG, rel), body);
    return {
      logicalId: `${p.type}:${p.name}`,
      type: p.type,
      name: p.name,
      file: rel,
      sha256: sha(body),
      sizeBytes: Buffer.byteLength(body),
      inherits: p.inherits ?? null,
      from: "User",
      sources: ["bundle"]
    };
  });
  fs.writeFileSync(
    path.join(CATALOG, "catalog.v1.json"),
    JSON.stringify({
      catalogVersion: 1,
      slicer: "OrcaSlicer",
      sources: [
        {
          id: "bundle",
          file: "sources/bundle.zip",
          originalName: "bundle.zip",
          sha256: sha(archive),
          sizeBytes: archive.length,
          bundleType: "printer config bundle",
          orcaVersion: "02.03.00.62"
        }
      ],
      profiles: entries
    })
  );
}

function revisionsNamed(name: string): ProfileRevision[] {
  return store.repositories.profileRevisions.list().filter((r) => r.name === name);
}

function only(name: string): ProfileRevision {
  const all = revisionsNamed(name);
  assert.equal(all.length, 1, `exactly one revision of «${name}»`);
  return all[0];
}

/** Import, then build and approve the K2 set on what the catalog resolves to now. */
async function approvedK2Set(): Promise<{ setId: string; machine: ProfileRevision }> {
  stage([k2Base("260"), K2_PETG, PROCESS, FILAMENT]);
  const first = await importer.import();
  assert.equal(first.counts.active, 4, JSON.stringify(first.profiles.map((p) => [p.name, p.blockers])));
  const machine = only("K2 PETG 0.4");
  const set = profiles.createSet({
    name: "K2 · PETG",
    machineRevisionId: machine.id,
    processRevisionId: only("K2 Standard 0.2").id,
    filamentRevisionId: only("PETG @K2").id,
    printerId: "creality-k2"
  });
  profiles.approveSet(set.id);
  return { setId: set.id, machine };
}

function binaryStl(): Buffer {
  const header = Buffer.alloc(84);
  header.writeUInt32LE(1, 80);
  const tri = Buffer.alloc(50);
  let o = 12;
  for (const v of [[0, 0, 0], [10, 0, 0], [10, 10, 5]]) {
    for (const c of v) {
      tri.writeFloatLE(c, o);
      o += 4;
    }
  }
  return Buffer.concat([header, tri]);
}

/** Slices a fresh model with the set; returns the machine settings OrcaSlicer was handed. */
async function machineSettingsSlicedWith(setId: string): Promise<Record<string, unknown>> {
  const up = await artifacts.ingest({ source: Readable.from(binaryStl()), fileName: "cube.stl" });
  await artifacts.whenIdle();
  let handed: Record<string, unknown> | null = null;
  runner.onSlice = (req) => {
    handed = JSON.parse(fs.readFileSync(req.machineJsonPath, "utf8")) as Record<string, unknown>;
  };
  const variant = await slice.createSlice({ artifactId: up.artifact.id, profileSetId: setId, force: true });
  await slice.whenIdle();
  assert.equal(slice.getVariant(variant.id).state, "ready", JSON.stringify(slice.getVariant(variant.id).blockers));
  assert.ok(handed, "the slicer was run");
  return handed;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("HIGH-10: editing a parent preset never rewrites the approved child revision's settings", async () => {
  const { setId, machine } = await approvedK2Set();
  assert.equal(JSON.parse(machine.resolvedJson ?? "{}").printable_height, "260");

  // The operator edits the PARENT in Orca and re-exports. The child's own bytes
  // are identical; only what it resolves to has changed.
  stage([k2Base("250"), K2_PETG, PROCESS, FILAMENT]);
  const second = await importer.import();

  const revs = revisionsNamed("K2 PETG 0.4");
  assert.equal(revs.length, 2, "a new revision for the new resolution");
  const old = store.repositories.profileRevisions.getById(machine.id);
  const fresh = revs.find((r) => r.id !== machine.id);
  assert.ok(old && fresh);

  // The approved revision is exactly what was approved: same bytes, same
  // effective settings, same provenance.
  assert.equal(old.rawSha256, machine.rawSha256);
  assert.equal(old.resolvedJson, machine.resolvedJson);
  assert.equal(old.resolvedSha256, machine.resolvedSha256);
  assert.deepEqual(old.metadata.inheritanceChain, machine.metadata.inheritanceChain);
  assert.equal(old.status, "active");
  // … and says what replaced it.
  assert.equal(old.metadata.supersededBy, fresh.id);
  assert.ok(old.warnings.some((w) => w.code === "profile_superseded"));

  // The new revision carries the new settings, under its own id.
  assert.equal(fresh.rawSha256, machine.rawSha256);
  assert.notEqual(fresh.resolvedSha256, machine.resolvedSha256);
  assert.equal(JSON.parse(fresh.resolvedJson ?? "{}").printable_height, "250");
  assert.equal(fresh.metadata.supersededBy, undefined);
  const outcome = second.profiles.find((p) => p.name === "K2 PETG 0.4");
  assert.equal(outcome?.change, "inserted");
  assert.deepEqual(outcome?.superseded, [machine.id]);
  const audit = store.repositories.audit.listByEntity("profile_revision", fresh.id).map((e) => e.action);
  assert.ok(audit.includes("profile_resolution_changed"), JSON.stringify(audit));

  // The approved set keeps its approval — nothing about it changed — and says
  // that newer settings exist.
  assert.equal(profiles.revalidateSets(), 1, "re-validated (warning), not revoked");
  const set = profiles.getSet(setId);
  assert.equal(set.approved, true);
  assert.equal(set.machineRevisionId, machine.id);
  assert.equal(set.validation, "warnings");
  assert.ok(set.warnings.some((w) => w.code === "profile_superseded"));

  // And it slices with exactly the settings that were approved.
  const handed = await machineSettingsSlicedWith(setId);
  assert.equal(handed.printable_height, "260");
});

test("HIGH-10: superseded settings are not offered for new sets or new approvals; a successor set adopts the new ones", async () => {
  const { setId, machine } = await approvedK2Set();
  // A set built on the same revisions but not yet approved when the parent changes.
  const pending = profiles.createSet({
    name: "K2 · PETG (черновик)",
    machineRevisionId: machine.id,
    processRevisionId: only("K2 Standard 0.2").id,
    filamentRevisionId: only("PETG @K2").id,
    printerId: "creality-k2"
  });

  stage([k2Base("250"), K2_PETG, PROCESS, FILAMENT]);
  await importer.import();
  const fresh = revisionsNamed("K2 PETG 0.4").find((r) => r.id !== machine.id);
  assert.ok(fresh);

  // No new set on the superseded revision…
  assert.throws(
    () =>
      profiles.createSet({
        name: "ещё один",
        machineRevisionId: machine.id,
        processRevisionId: only("K2 Standard 0.2").id,
        filamentRevisionId: only("PETG @K2").id,
        printerId: "creality-k2"
      }),
    /заменён ревизией/
  );
  // … and no approving the old settings anew.
  assert.throws(() => profiles.approveSet(pending.id), /разрешаются каталогом иначе/);
  assert.equal(profiles.getSet(pending.id).approved, false);

  // The successor: same target, the members' current revisions, unapproved.
  const successor = profiles.createSuccessorSet(setId);
  assert.notEqual(successor.id, setId);
  assert.equal(successor.machineRevisionId, fresh.id);
  assert.equal(successor.processRevisionId, only("K2 Standard 0.2").id);
  assert.equal(successor.printerId, "creality-k2");
  assert.equal(successor.approved, false);
  assert.equal(successor.metadata.successorOf, setId);
  assert.equal(successor.name, "K2 · PETG · обновлён");
  profiles.approveSet(successor.id);

  // The original set is untouched — approved, on the revision it was approved on.
  const original = profiles.getSet(setId);
  assert.equal(original.approved, true);
  assert.equal(original.machineRevisionId, machine.id);

  // The successor slices with the new settings, the original with the old.
  assert.equal((await machineSettingsSlicedWith(successor.id)).printable_height, "250");
  assert.equal((await machineSettingsSlicedWith(setId)).printable_height, "260");

  // A set whose members are current has nothing to adopt.
  assert.throws(() => profiles.createSuccessorSet(successor.id), /актуальны/);
});

test("HIGH-10: a resolution that comes back makes its own revision current again — no third revision", async () => {
  const { machine } = await approvedK2Set();
  stage([k2Base("250"), K2_PETG, PROCESS, FILAMENT]);
  await importer.import();
  const fresh = revisionsNamed("K2 PETG 0.4").find((r) => r.id !== machine.id);
  assert.ok(fresh);

  // The edit is reverted: the child resolves to the original settings again.
  stage([k2Base("260"), K2_PETG, PROCESS, FILAMENT]);
  await importer.import();

  assert.equal(revisionsNamed("K2 PETG 0.4").length, 2);
  const original = store.repositories.profileRevisions.getById(machine.id);
  const replaced = store.repositories.profileRevisions.getById(fresh.id);
  assert.equal(original?.metadata.supersededBy, undefined, "current again");
  assert.ok(!original?.warnings.some((w) => w.code === "profile_superseded"));
  assert.equal(original?.resolvedJson, machine.resolvedJson);
  assert.equal(replaced?.metadata.supersededBy, machine.id);
  assert.equal(JSON.parse(replaced?.resolvedJson ?? "{}").printable_height, "250", "its settings kept too");

  // Counts and coverage count bytes once, not once per resolution: every stored
  // row (the edited «K2 Base» stays, as its own bytes) except the superseded one.
  const report = await profiles.runtimeReport();
  const rows = store.repositories.profileRevisions.list();
  assert.equal(rows.filter((r) => r.metadata.supersededBy).length, 1);
  assert.equal(report.profileCounts.total, rows.length - 1, JSON.stringify(report.profileCounts));
});

test("HIGH-10: a parent that disappears quarantines the revision but keeps its recorded settings", async () => {
  const { setId, machine } = await approvedK2Set();

  // The parent is gone from the catalog: the child cannot be resolved now.
  stage([K2_PETG, PROCESS, FILAMENT]);
  await importer.import();

  const revs = revisionsNamed("K2 PETG 0.4");
  assert.equal(revs.length, 1, "no new revision: there are no new settings");
  const after = revs[0];
  assert.equal(after.id, machine.id);
  assert.equal(after.status, "quarantined");
  assert.equal(after.resolvedJson, machine.resolvedJson, "the record of what was approved survives");
  assert.equal(after.resolvedSha256, machine.resolvedSha256);
  assert.deepEqual(after.metadata, machine.metadata);

  // A quarantined member still revokes the approval (the existing rule) …
  profiles.revalidateSets();
  assert.equal(profiles.getSet(setId).approved, false);

  // … and when the parent returns unchanged, the same revision is active again.
  stage([k2Base("260"), K2_PETG, PROCESS, FILAMENT]);
  await importer.import();
  const back = only("K2 PETG 0.4");
  assert.equal(back.id, machine.id);
  assert.equal(back.status, "active");
});
