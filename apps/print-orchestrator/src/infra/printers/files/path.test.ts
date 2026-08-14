import assert from "node:assert/strict";
import { test } from "node:test";

import { ValidationError } from "../../../core/errors";
import type { PrinterConfig } from "../config";
import {
  isPrintableFile,
  MAX_DEVICE_SEGMENT_LENGTH,
  normalizePrinterPath,
  normalizeStartablePath,
  startableExtensionsFor
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

/*
 * Printer-aware startability — the regression that made a fully prepared Bambu
 * job unlaunchable from both buttons in the UI.
 *
 * `.gcode.3mf` is a Bambu plate package: the farm slices it, uploads it over
 * FTPS and verifies it on the device. The file *listing* asked this module with
 * the printer in hand and answered `printable: true`; every *start* path asked
 * without one, silently got the Klipper default set, and refused the same file
 * with "можно запустить только .gcode, .gco, .g". The listing and the start must
 * answer identically for the same (file, printer).
 */

const bambu = { id: "a1", name: "Bambu Lab A1", protocol: "bambu" } as unknown as PrinterConfig;
const klipper = { id: "k2", name: "K2", protocol: "moonraker" } as unknown as PrinterConfig;

test("a Bambu plate package is startable on Bambu and refused on Moonraker", () => {
  const pkg = "3U-default-28ab3676.gcode.3mf";
  assert.equal(normalizeStartablePath(pkg, bambu), pkg);
  assert.equal(isPrintableFile(pkg, bambu), true);

  // Moonraker genuinely cannot execute a 3MF container — this refusal is correct
  // and must survive the fix that made Bambu accept it.
  assert.equal(isPrintableFile(pkg, klipper), false);
  assert.throws(() => normalizeStartablePath(pkg, klipper), ValidationError);
});

test("plain G-code stays startable on Moonraker, and Bambu accepts it too", () => {
  assert.equal(normalizeStartablePath("part.gcode", klipper), "part.gcode");
  assert.equal(normalizeStartablePath("part.gcode", bambu), "part.gcode");
  assert.throws(() => normalizeStartablePath("part.gco", bambu), ValidationError);
});

test("the double extension is matched whole, not split at .3mf", () => {
  // `.gcode.3mf` precedes `.3mf` in the capability list; both are startable on
  // Bambu, but the longest match must win so the package keeps its full name.
  assert.equal(isPrintableFile("model.gcode.3mf", bambu), true);
  assert.equal(isPrintableFile("model.3mf", bambu), true);
  assert.equal(isPrintableFile("model.gcode.3mf.bak", bambu), false);
});

test("the printer-less default stays fail-closed at the Klipper set", () => {
  // Nothing about the fix may loosen the historical default: a caller that
  // forgets the printer must still be refused rather than silently permissive.
  assert.throws(() => normalizeStartablePath("model.gcode.3mf"), ValidationError);
  assert.equal(isPrintableFile("model.gcode.3mf"), false);
});

test('scope "any" admits what some adapter could start, and nothing else', () => {
  // Used when queueing a job whose target printer is not chosen yet: refusing a
  // Bambu package there would reject a file that is perfectly valid for the
  // printer it is about to be assigned to.
  assert.equal(normalizeStartablePath("model.gcode.3mf", "any"), "model.gcode.3mf");
  assert.equal(normalizeStartablePath("model.gcode", "any"), "model.gcode");
  assert.equal(normalizeStartablePath("model.g", "any"), "model.g");
  assert.throws(() => normalizeStartablePath("notes.txt", "any"), ValidationError);
  assert.throws(() => normalizeStartablePath("photo.jpg", "any"), ValidationError);

  // Still a path check, not a bypass.
  assert.throws(() => normalizeStartablePath("../model.gcode.3mf", "any"), ValidationError);
});

test("startableExtensionsFor reports each scope's real answer", () => {
  assert.deepEqual([...startableExtensionsFor(klipper)], [".gcode", ".gco", ".g"]);
  assert.ok(startableExtensionsFor(bambu).includes(".gcode.3mf"));
  assert.ok(startableExtensionsFor("any").includes(".gcode.3mf"));
  assert.ok(startableExtensionsFor("any").includes(".gco"));
  // Longest-first, so `.gcode.3mf` can never be shadowed by `.3mf`.
  const any = startableExtensionsFor("any");
  assert.ok(any.indexOf(".gcode.3mf") < any.indexOf(".3mf"));
});
