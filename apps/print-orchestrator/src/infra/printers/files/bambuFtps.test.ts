import assert from "node:assert/strict";
import { test } from "node:test";

import { PrinterCommandError } from "../status/types";
import { parseListResponse, parsePasv } from "./bambuFtps";

/**
 * The two parsers that decide where a data connection goes and what the device
 * claims to hold. Both feed conclusions a dispatch acts on, so both fail closed:
 * an address we cannot parse is an error, and a listing line we cannot parse is
 * dropped rather than turned into a file record that would read as proof of
 * delivery.
 */

// ── PASV ─────────────────────────────────────────────────────────────────────

test("the data port is computed from the high/low byte pair", () => {
  const { port } = parsePasv("Entering Passive Mode (192,168,0,188,7,232)", "192.168.0.188");
  assert.equal(port, 7 * 256 + 232);
});

test("the control host wins over the address the server advertises", () => {
  // A printer behind NAT (or one answering 0,0,0,0) would otherwise send the
  // data connection to an unroutable address.
  const { host, port } = parsePasv("227 Entering Passive Mode (0,0,0,0,7,232)", "192.168.0.188");
  assert.equal(host, "192.168.0.188");
  assert.equal(port, 2024);
});

test("an unparseable PASV reply is an error, never a default port", () => {
  assert.throws(() => parsePasv("227 Entering Passive Mode", "10.0.0.1"), PrinterCommandError);
  assert.throws(() => parsePasv("500 Not understood", "10.0.0.1"), PrinterCommandError);
});

test("an out-of-range port is refused", () => {
  assert.throws(() => parsePasv("227 (1,2,3,4,999,999)", "10.0.0.1"), PrinterCommandError);
});

// ── LIST ─────────────────────────────────────────────────────────────────────

/** A real listing from a Bambu A1's SD-card root. */
const LISTING = [
  "drwxrwxrwx   2 root root     4096 Jan  1  2024 cache",
  "-rwxrwxrwx   1 root root   560492 Aug 13 21:14 OrcaCube_v2.gcode.3mf",
  "-rwxrwxrwx   1 root root  2346870 Aug 14 09:02 Cube.gcode.3mf",
  "lrwxrwxrwx   1 root root        7 Jan  1  2024 link -> /target",
  "-rwxrwxrwx   1 root root        0 Aug 14 09:02 empty.gcode.3mf"
].join("\r\n");

test("files are parsed with their byte sizes — the evidence a delivery is verified by", () => {
  const entries = parseListResponse(LISTING);
  const cube = entries.find((e) => e.name === "OrcaCube_v2.gcode.3mf");

  assert.ok(cube);
  assert.equal(cube.type, "file");
  assert.equal(cube.size, 560492);
});

test("directories are marked as such and carry no size", () => {
  const cache = parseListResponse(LISTING).find((e) => e.name === "cache");
  assert.ok(cache);
  assert.equal(cache.type, "directory");
  assert.equal(cache.size, undefined);
});

test("a zero-byte file is reported honestly rather than dropped", () => {
  // It must reach the caller so verification can call it INVALID; silently
  // omitting it would read as «not there yet» and invite a blind re-upload.
  const empty = parseListResponse(LISTING).find((e) => e.name === "empty.gcode.3mf");
  assert.ok(empty);
  assert.equal(empty.size, 0);
});

test("symlinks and dot entries are skipped — neither is a file we can verify", () => {
  const names = parseListResponse(
    `${LISTING}\r\ndrwxr-xr-x 2 root root 4096 Jan  1  2024 .\r\ndrwxr-xr-x 2 root root 4096 Jan  1  2024 ..`
  ).map((e) => e.name);

  assert.ok(!names.includes("link"));
  assert.ok(!names.includes("."));
  assert.ok(!names.includes(".."));
});

test("names containing spaces survive intact", () => {
  const entry = parseListResponse(
    "-rwxrwxrwx   1 root root   1234 Aug 14 09:02 my part v2.gcode.3mf"
  )[0];
  assert.equal(entry.name, "my part v2.gcode.3mf");
  assert.equal(entry.size, 1234);
});

test("unrecognised lines are dropped, not guessed into file records", () => {
  const entries = parseListResponse(
    "total 12\r\nsome unexpected banner\r\n-rwxrwxrwx 1 root root 5 Aug 14 09:02 ok.gcode"
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "ok.gcode");
});

test("an empty listing is an empty result, not an error", () => {
  assert.deepEqual(parseListResponse(""), []);
  assert.deepEqual(parseListResponse("\r\n"), []);
});
