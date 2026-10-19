import assert from "node:assert/strict";
import { test } from "node:test";
import { anycubicFilePath, parseAnycubicFilePage } from "./anycubic";

const page = (records: unknown[]) => ({ type: "file", action: "listLocal", code: 200, state: "done", data: { list_mode: 0, records } });

test("captured 2.0.2.2 records preserve literal filenames, byte sizes and millisecond dates", () => {
  const entries = parseAnycubicFilePage("local", page([
    { filename: "test_model", display_name: "Встроенные файлы", is_dir: true, size: 0, timestamp: 1790939712726 },
    { filename: "Sample+Part(01).gcode", is_dir: false, size: 8899666, timestamp: 1791057404877, fileKey: "not-a-content-hash" },
    { filename: "деталь.gcode.3mf", is_dir: false }
  ]));
  assert.equal(entries[0].path, "local/test_model");
  assert.equal(entries[1].name, "Sample+Part(01).gcode");
  assert.equal(entries[1].size, 8899666);
  assert.equal(entries[1].modifiedAt, new Date(1791057404877).toISOString());
  assert.equal(entries[1].printable, false);
  assert.equal(entries[2].size, undefined);
  assert.equal(JSON.stringify(entries).includes("fileKey"), false);
});

test("USB has a separate namespace; unsafe paths fail before device I/O", () => {
  assert.equal(anycubicFilePath(""), null);
  assert.deepEqual(anycubicFilePath("local"), { path: "local", storage: "local", directory: "/" });
  assert.deepEqual(anycubicFilePath("usb/folder"), { path: "usb/folder", storage: "usb", directory: "/folder" });
  for (const path of ["elsewhere", "local/../usb", "/local", "local/a\\b", "local/" + "x".repeat(201)]) {
    assert.throws(() => anycubicFilePath(path));
  }
});

test("an empty records list is empty; errors, malformed replies and unsafe entries are errors", () => {
  assert.deepEqual(parseAnycubicFilePage("usb", page([])), []);
  for (const reply of [{ code: 10112, data: null }, { code: 200, data: null }, { code: 200, data: {} },
    page([{ filename: "../other", is_dir: false }]), page([{ filename: "a/b", is_dir: false }]),
    page([{ filename: "a.gcode", is_dir: false }, { filename: "a.gcode", is_dir: false }]),
    page([{ filename: "x.gcode", is_dir: 1 }])]) {
    assert.throws(() => parseAnycubicFilePage("local", reply));
  }
});

test("list_mode=0 is a full snapshot even beyond the requested page size; unverified modes fail", () => {
  assert.equal(parseAnycubicFilePage("local", page(Array.from({ length: 205 }, (_, i) => ({ filename: `${i}.gcode`, is_dir: false })))).length, 205);
  assert.throws(() => parseAnycubicFilePage("local", { code: 200, data: { list_mode: 1, records: [] } }));
});
