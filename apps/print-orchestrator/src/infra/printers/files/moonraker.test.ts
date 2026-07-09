import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMoonrakerDirectory } from "./moonraker";

/*
 * Parsing of Moonraker's `/server/files/directory?extended=true` result into
 * normalized entries. Pure — no HTTP. Shapes follow the real Moonraker
 * response: `dirs[].dirname`, `files[].filename`, unix-seconds `modified`,
 * and slicer metadata merged into extended file entries.
 */

test("maps dirs and files with paths relative to the gcodes root", () => {
  const entries = parseMoonrakerDirectory("", {
    dirs: [{ dirname: "orders", modified: 1751000000, size: 4096 }],
    files: [{ filename: "chalice.gcode", modified: 1751000100.5, size: 123456 }]
  });

  assert.deepEqual(
    entries.map((e) => ({ name: e.name, path: e.path, type: e.type, printable: e.printable })),
    [
      { name: "orders", path: "orders", type: "directory", printable: false },
      { name: "chalice.gcode", path: "chalice.gcode", type: "file", printable: true }
    ]
  );
  assert.equal(entries[1].size, 123456);
  assert.equal(entries[1].modifiedAt, new Date(1751000100.5 * 1000).toISOString());
});

test("prefixes entry paths with the listed subdirectory", () => {
  const entries = parseMoonrakerDirectory("orders/june", {
    dirs: [{ dirname: "prototypes" }],
    files: [{ filename: "lid.gcode" }]
  });
  assert.equal(entries[0].path, "orders/june/prototypes");
  assert.equal(entries[1].path, "orders/june/lid.gcode");
});

test("marks non-G-code files as not printable but still lists them", () => {
  const entries = parseMoonrakerDirectory("", {
    files: [{ filename: "notes.txt" }, { filename: "part.GCO" }]
  });
  assert.deepEqual(
    entries.map((e) => [e.name, e.printable]),
    [
      ["notes.txt", false],
      ["part.GCO", true]
    ]
  );
});

test("hides dot entries the way Fluidd/Mainsail do", () => {
  const entries = parseMoonrakerDirectory("", {
    dirs: [{ dirname: ".thumbs" }, { dirname: "visible" }],
    files: [{ filename: ".hidden.gcode" }, { filename: "shown.gcode" }]
  });
  assert.deepEqual(entries.map((e) => e.name), ["visible", "shown.gcode"]);
});

test("sorts directories before files, each alphabetically", () => {
  const entries = parseMoonrakerDirectory("", {
    dirs: [{ dirname: "b-dir" }, { dirname: "a-dir" }],
    files: [{ filename: "z.gcode" }, { filename: "a.gcode" }]
  });
  assert.deepEqual(entries.map((e) => e.name), ["a-dir", "b-dir", "a.gcode", "z.gcode"]);
});

test("forwards a trimmed slicer-metadata subset from extended entries", () => {
  const entries = parseMoonrakerDirectory("", {
    files: [
      {
        filename: "chalice.gcode",
        estimated_time: 7920,
        filament_type: "PETG",
        slicer: "OrcaSlicer",
        thumbnails: [{ data: "…huge base64…" }],
        gcode_start_byte: 12345
      }
    ]
  });
  assert.deepEqual(entries[0].metadata, {
    slicer: "OrcaSlicer",
    estimated_time: 7920,
    filament_type: "PETG"
  });
});

test("omits metadata entirely when the entry carries none", () => {
  const entries = parseMoonrakerDirectory("", { files: [{ filename: "plain.gcode" }] });
  assert.equal("metadata" in entries[0], false);
});

test("tolerates malformed payloads without throwing (never invents entries)", () => {
  assert.deepEqual(parseMoonrakerDirectory("", null), []);
  assert.deepEqual(parseMoonrakerDirectory("", "nope"), []);
  assert.deepEqual(parseMoonrakerDirectory("", {}), []);
  assert.deepEqual(
    parseMoonrakerDirectory("", { dirs: [null, 42, { size: 1 }], files: [{ filename: "" }, "x"] }),
    []
  );
});
