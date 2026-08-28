import assert from "node:assert/strict";
import { test } from "node:test";

import { anyNamesJob, jobIdentityKey, jobNameStem, sameJobFile } from "./jobIdentity";
import { buildDeviceFileName } from "./name";
import type { PrinterConfig } from "../config";

/*
 * The job-identity matrix. Every layer that asks "is the printer talking about
 * OUR print?" answers through this module, so the forms a real device reports
 * are enumerated here once and the answer is asserted for all of them.
 *
 * The regression these guard: a Bambu dispatch writes `cube-a1b2c3d4.gcode.3mf`
 * and the device reports `subtask_name: "cube-a1b2c3d4"`. Three private helpers
 * used to disagree about that pair, so the start confirmed and the next poll
 * declared the identity lost.
 */

const BAMBU = { protocol: "bambu" } as unknown as PrinterConfig;
const KLIPPER = { protocol: "moonraker" } as unknown as PrinterConfig;

/** Every shape the same job is written in, across protocols and firmwares. */
const SAME_JOB: { form: string; value: string }[] = [
  { form: "bare name", value: "cube-a1b2c3d4" },
  { form: "gcode", value: "cube-a1b2c3d4.gcode" },
  { form: "3mf", value: "cube-a1b2c3d4.3mf" },
  { form: "gcode.3mf plate package", value: "cube-a1b2c3d4.gcode.3mf" },
  { form: "uppercase extension", value: "cube-a1b2c3d4.GCODE.3MF" },
  { form: "mixed-case name", value: "Cube-A1B2C3D4.gcode.3mf" },
  { form: "device path", value: "/cube-a1b2c3d4.gcode.3mf" },
  { form: "nested device path", value: "model/cube-a1b2c3d4.gcode" },
  { form: "sdcard url path", value: "/mnt/sdcard/cube-a1b2c3d4.gcode.3mf" },
  { form: "windows separators", value: "cache\\cube-a1b2c3d4.3mf" },
  { form: "padded", value: "  cube-a1b2c3d4.gcode.3mf  " },
  { form: ".gco alias", value: "cube-a1b2c3d4.gco" },
  { form: ".g alias", value: "cube-a1b2c3d4.g" }
];

test("job identity: every reported form of one job compares equal to every other", () => {
  for (const a of SAME_JOB) {
    for (const b of SAME_JOB) {
      assert.ok(
        sameJobFile(a.value, b.value),
        `«${a.form}» (${a.value}) should name the same job as «${b.form}» (${b.value})`
      );
    }
  }
  for (const a of SAME_JOB) {
    assert.equal(jobIdentityKey(a.value), "cube-a1b2c3d4", `key of ${a.form}`);
  }
});

test("job identity: names that merely resemble each other are NOT the same job", () => {
  const distinct = [
    "cube-a1b2c3d4",
    "cube",
    "cube-a1b2c3d5",
    "cube-a1b2c3d4_repaired",
    "copy of cube-a1b2c3d4",
    "cube-a1b2c3d40",
    "plate_1"
  ];
  for (let i = 0; i < distinct.length; i += 1) {
    for (let j = 0; j < distinct.length; j += 1) {
      if (i === j) continue;
      assert.ok(
        !sameJobFile(distinct[i], distinct[j]),
        `«${distinct[i]}» must not be confused with «${distinct[j]}»`
      );
    }
  }
});

test("job identity: a missing name is never agreement", () => {
  for (const empty of [null, undefined, "", "   ", "/", 42 as unknown as string]) {
    assert.equal(jobIdentityKey(empty), "");
    assert.equal(sameJobFile(empty, "cube.gcode"), false);
    assert.equal(sameJobFile("cube.gcode", empty), false);
    assert.equal(sameJobFile(empty, empty), false);
  }
});

test("job identity: an unknown suffix is part of the name, not an extension", () => {
  // Dropping a suffix nobody can start would merge two genuinely different files.
  assert.ok(!sameJobFile("cube.stl", "cube.gcode"));
  assert.equal(jobIdentityKey("cube.stl"), "cube.stl");
  // A name that is *only* an extension keeps it — there is no stem to reduce to.
  assert.equal(jobIdentityKey(".gcode"), ".gcode");
});

test("job identity: the container extension is stripped whole, never split at .3mf", () => {
  assert.equal(jobIdentityKey("part.gcode.3mf"), "part");
  // Had `.3mf` won the match, the key would have been "part.gcode" and the
  // Bambu-reported "part" would not have matched it.
  assert.ok(sameJobFile("part.gcode.3mf", "part"));
});

test("jobNameStem preserves case for display; jobIdentityKey folds it for comparison", () => {
  assert.equal(jobNameStem("Cube-A1B2C3D4.gcode.3mf"), "Cube-A1B2C3D4");
  assert.equal(jobIdentityKey("Cube-A1B2C3D4.gcode.3mf"), "cube-a1b2c3d4");
});

test("anyNamesJob: agreement in any one reported field is agreement", () => {
  // A Bambu project print: the job is named in `subtask_name`, while
  // `gcode_file` points *inside* the container.
  const reported = ["cube-a1b2c3d4", "/data/Metadata/plate_1.gcode", "", ""];
  assert.ok(anyNamesJob(reported, "cube-a1b2c3d4.gcode.3mf"));
  assert.ok(!anyNamesJob(reported, "chalice-99887766.gcode.3mf"));
  // Not a single field, and not the empty string, may confirm.
  assert.ok(!anyNamesJob(["", "", ""], ""));
  assert.ok(!anyNamesJob([], "cube-a1b2c3d4"));
  assert.ok(!anyNamesJob([null, 7, {}], "cube-a1b2c3d4"));
});

test("the name we generate for a device and the identity we compare by agree", () => {
  const artifact = { name: "Cube.gcode", sha256: "a".repeat(64) };
  const onBambu = buildDeviceFileName(artifact, BAMBU);
  const onKlipper = buildDeviceFileName(artifact, KLIPPER);
  assert.equal(onBambu, "Cube-aaaaaaaa.gcode.3mf");
  assert.equal(onKlipper, "Cube-aaaaaaaa.gcode");
  // The same model prepared for two protocols is the same job identity, which is
  // what lets one run be reconciled against whichever device reports it.
  assert.ok(sameJobFile(onBambu, onKlipper));
  // And the bare stem a Bambu echoes back matches the file we uploaded.
  assert.ok(sameJobFile(onBambu, jobNameStem(onBambu)));
});
