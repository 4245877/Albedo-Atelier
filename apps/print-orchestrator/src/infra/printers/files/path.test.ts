import assert from "node:assert/strict";
import { test } from "node:test";

import { ValidationError } from "../../../core/errors";
import {
  isPrintableFile,
  MAX_DEVICE_SEGMENT_LENGTH,
  normalizePrinterPath,
  normalizeStartablePath
} from "./path";

/*
 * Path normalization is the security boundary of the file API: everything the
 * dashboard sends reaches Moonraker only through these functions.
 */

test("accepts plain and nested relative paths, trimming whitespace and trailing slashes", () => {
  assert.equal(normalizePrinterPath("model.gcode"), "model.gcode");
  assert.equal(normalizePrinterPath("folder/sub/model.gcode"), "folder/sub/model.gcode");
  assert.equal(normalizePrinterPath("  folder/  "), "folder");
  assert.equal(normalizePrinterPath("folder///"), "folder");
});

test("allows the empty root path only when explicitly permitted (listing, not start)", () => {
  assert.equal(normalizePrinterPath("", { allowEmpty: true }), "");
  assert.equal(normalizePrinterPath("   ", { allowEmpty: true }), "");
  assert.throws(() => normalizePrinterPath(""), ValidationError);
  assert.throws(() => normalizePrinterPath("   "), ValidationError);
});

test("rejects path traversal in any position", () => {
  for (const path of ["..", "../secret", "folder/../../etc", "folder/..", "./x", "folder/./x"]) {
    assert.throws(() => normalizePrinterPath(path), ValidationError, path);
  }
});

test("rejects absolute paths, backslashes, empty segments and control characters", () => {
  for (const path of ["/etc/passwd", "//x", "a//b", "a\\b", "a\u0000b", "a\nb"]) {
    assert.throws(() => normalizePrinterPath(path), ValidationError, JSON.stringify(path));
  }
});

test("keeps legal filenames with spaces and unicode intact", () => {
  assert.equal(normalizePrinterPath("Кубок Владыки v2.gcode"), "Кубок Владыки v2.gcode");
});

test("rejects non-string input instead of coercing it", () => {
  assert.throws(() => normalizePrinterPath(null), ValidationError);
  assert.throws(() => normalizePrinterPath(42 as never), ValidationError);
  assert.throws(() => normalizePrinterPath(["a.gcode"] as never), ValidationError);
});

test("recognizes printable G-code extensions case-insensitively", () => {
  assert.equal(isPrintableFile("model.gcode"), true);
  assert.equal(isPrintableFile("MODEL.GCODE"), true);
  assert.equal(isPrintableFile("part.gco"), true);
  assert.equal(isPrintableFile("part.g"), true);
  assert.equal(isPrintableFile("photo.jpg"), false);
  assert.equal(isPrintableFile("archive.gcode.zip"), false);
  assert.equal(isPrintableFile("folder"), false);
});

test("normalizeStartablePath refuses directories and non-printable files", () => {
  assert.equal(normalizeStartablePath("folder/model.gcode"), "folder/model.gcode");
  assert.throws(() => normalizeStartablePath("folder"), ValidationError);
  assert.throws(() => normalizeStartablePath("notes.txt"), ValidationError);
  assert.throws(() => normalizeStartablePath(""), ValidationError);
  assert.throws(() => normalizeStartablePath("../model.gcode"), ValidationError);
});

test("rejects an over-long segment or path instead of letting the device truncate it", () => {
  const longName = `${"x".repeat(MAX_DEVICE_SEGMENT_LENGTH + 1)}.gcode`;
  assert.throws(() => normalizePrinterPath(longName), ValidationError);

  // Each segment fits, but the whole path does not.
  const deep = Array.from({ length: 10 }, () => "x".repeat(50)).join("/");
  assert.throws(() => normalizePrinterPath(`${deep}/part.gcode`), ValidationError);

  // Multi-byte names are measured in BYTES, which is what the filesystem limits.
  assert.throws(
    () => normalizePrinterPath(`${"д".repeat(MAX_DEVICE_SEGMENT_LENGTH)}.gcode`),
    ValidationError
  );
});

test("rejects a Windows drive prefix — absolute on the device without a leading slash", () => {
  assert.throws(() => normalizePrinterPath("C:part.gcode"), ValidationError);
  assert.throws(() => normalizePrinterPath("dir/C:part.gcode"), ValidationError);
});
