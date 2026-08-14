import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { SystemProfileIndex, isVendorManifest, systemProfileType } from "./systemProfiles";

let TMP: string;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "orca-system-"));
});
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

function write(rel: string, body: unknown): void {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(body));
}

test("indexes profiles by name and tags each with its vendor folder", async () => {
  write("tree/BBL/machine/fdm_machine_common.json", { name: "fdm_machine_common", type: "machine", base: "bbl" });
  write("tree/Anker/machine/fdm_machine_common.json", { name: "fdm_machine_common", type: "machine", base: "anker" });

  const index = await SystemProfileIndex.build([path.join(TMP, "tree")]);
  const found = index.lookup("fdm_machine_common");
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.vendor).sort(), ["Anker", "BBL"]);
  assert.equal(found.find((f) => f.vendor === "BBL")?.settings.base, "bbl");
});

test("a file sitting directly in a root is unscoped (a flat vendor/ drop-in)", async () => {
  write("vendor/system-base.json", { name: "System Base", type: "machine" });
  const index = await SystemProfileIndex.build([path.join(TMP, "vendor")]);
  assert.equal(index.lookup("System Base")[0].vendor, null);
});

test("vendor manifests and machine_model definitions never enter the index", async () => {
  // `BBL.json` is a catalogue of profiles, and `Bambu Lab A1.json` is a printer
  // *model* definition — neither is a preset that anything may inherit from.
  write("tree/BBL.json", {
    name: "Bambulab",
    version: "01.10.00.35",
    machine_model_list: [{ name: "Bambu Lab A1", sub_path: "machine/Bambu Lab A1.json" }],
    filament_list: [],
    process_list: [],
    machine_list: []
  });
  write("tree/BBL/machine/Bambu Lab A1.json", {
    type: "machine_model",
    name: "Bambu Lab A1",
    nozzle_diameter: "0.2;0.4;0.6;0.8"
  });
  write("tree/BBL/machine/Bambu Lab A1 0.4 nozzle.json", {
    type: "machine",
    name: "Bambu Lab A1 0.4 nozzle",
    nozzle_diameter: ["0.4"]
  });

  const index = await SystemProfileIndex.build([path.join(TMP, "tree")]);
  assert.deepEqual(index.lookup("Bambulab"), []);
  assert.deepEqual(index.lookup("Bambu Lab A1"), []);
  assert.equal(index.lookup("Bambu Lab A1 0.4 nozzle").length, 1);
});

test("earlier roots win a (vendor, name) collision — vendor/ overrides the slicer tree", async () => {
  write("vendor/BBL/machine/x.json", { name: "X", type: "machine", who: "operator" });
  write("tree/BBL/machine/x.json", { name: "X", type: "machine", who: "slicer" });

  const index = await SystemProfileIndex.build([path.join(TMP, "vendor"), path.join(TMP, "tree")]);
  const found = index.lookup("X");
  assert.equal(found.length, 1);
  assert.equal(found[0].settings.who, "operator");
});

test("the same name from two different vendors is kept as two candidates across roots", async () => {
  write("vendor/BBL/filament/c.json", { name: "common", type: "filament", who: "bbl" });
  write("tree/Creality/filament/c.json", { name: "common", type: "filament", who: "creality" });

  const index = await SystemProfileIndex.build([path.join(TMP, "vendor"), path.join(TMP, "tree")]);
  assert.equal(index.lookup("common").length, 2);
});

test("a file whose basename differs from its profile name is still found by name", async () => {
  // 161 files in the shipped tree do this (e.g. Mellow's "0.40mm Extra Draft @M1.json"
  // is named "0.40mm Standard @M1"); the index keys on the real name, not the file.
  write("tree/Mellow/process/0.40mm Extra Draft @M1.json", {
    name: "0.40mm Standard @M1",
    type: "process",
    layer_height: "0.4"
  });
  const index = await SystemProfileIndex.build([path.join(TMP, "tree")]);
  assert.equal(index.lookup("0.40mm Standard @M1").length, 1);
  assert.deepEqual(index.lookup("0.40mm Extra Draft @M1"), []);
});

test("malformed and non-profile JSON is skipped, not fatal", async () => {
  fs.mkdirSync(path.join(TMP, "tree/BBL/machine"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "tree/BBL/machine/broken.json"), "{ not json");
  write("tree/BBL/machine/array.json", ["nope"]);
  write("tree/BBL/machine/nameless.json", { type: "machine" });
  write("tree/BBL/machine/ok.json", { name: "OK", type: "machine" });

  const index = await SystemProfileIndex.build([path.join(TMP, "tree")]);
  assert.equal(index.lookup("OK").length, 1);
});

test("a missing root contributes nothing instead of throwing", async () => {
  const index = await SystemProfileIndex.build([path.join(TMP, "does-not-exist")]);
  assert.equal(index.size, 0);
});

test("the profile kind comes from `type`, then the directory, then the payload", () => {
  assert.equal(systemProfileType({ type: "printer" }, null), "machine");
  assert.equal(systemProfileType({ type: "print" }, null), "process");
  assert.equal(systemProfileType({ type: "machine_model" }, "machine"), null);
  assert.equal(systemProfileType({}, "filament"), "filament");
  assert.equal(systemProfileType({ printable_area: ["0x0"] }, null), "machine");
  assert.equal(systemProfileType({ filament_type: ["PLA"] }, null), "filament");
  assert.equal(systemProfileType({ layer_height: "0.2" }, null), "process");
  assert.equal(systemProfileType({ some: "thing" }, null), null);
});

test("isVendorManifest recognises a vendor bundle index", () => {
  assert.equal(isVendorManifest({ name: "Bambulab", machine_model_list: [] }), true);
  assert.equal(isVendorManifest({ name: "Bambu Lab A1 0.4 nozzle", type: "machine" }), false);
});
