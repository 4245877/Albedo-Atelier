import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/*
 * Structural guard for the go2rtc proxy hardening (P0-3). These are the controls
 * that keep the browser off the universal go2rtc API and off arbitrary src/dst
 * (SSRF / LAN scan / producer injection). A behavioural nginx run confirms they
 * WORK; this test keeps a future edit from silently dropping them. It reads the
 * committed template so it needs no running nginx (CI-safe).
 */

const conf = readFileSync(
  fileURLToPath(new URL("../nginx.conf", import.meta.url)),
  "utf8"
);

// Collapse comments/whitespace for robust matching.
const code = conf
  .split("\n")
  .map((l) => l.replace(/#.*$/, ""))
  .join("\n");

test("go2rtc stream ids are server-side allowlisted (no arbitrary src)", () => {
  assert.match(code, /map\s+\$arg_src\s+\$go2rtc_src_ok/, "a $arg_src → allowlist map exists");
  assert.match(code, /"k2"\s+1;/, "the known stream id is allowlisted");
  assert.match(code, /default\s+0;/, "unknown src ids default to blocked");
});

test("only the exact signaling WebSocket path is proxied; the rest of the API is 404", () => {
  assert.match(code, /location\s*=\s*\/go2rtc\/api\/ws\s*\{/, "exact-match ws location");
  assert.match(code, /location\s+\/go2rtc\/\s*\{[^}]*return\s+404;/s, "the broad go2rtc API is refused");
});

test("the ws location refuses unknown src and any dst, and rate/conn limits it", () => {
  const ws = code.match(/location\s*=\s*\/go2rtc\/api\/ws\s*\{([\s\S]*?)\n  \}/);
  assert.ok(ws, "found the ws location block");
  const block = ws[1];
  assert.match(block, /if\s*\(\$go2rtc_src_ok\s*=\s*0\)\s*\{\s*return\s+403;/, "unknown src → 403");
  assert.match(block, /if\s*\(\$arg_dst\)\s*\{\s*return\s+403;/, "any dst → 403 (no producer injection)");
  assert.match(block, /limit_req\s+zone=go2rtc_ws/, "per-IP request rate limit");
  assert.match(block, /limit_conn\s+go2rtc_conn/, "per-IP connection limit");
  assert.match(block, /set\s+\$args\s+src=\$arg_src;/, "only the vetted src is forwarded upstream");
});

test("the rate/connection limit zones are declared", () => {
  assert.match(code, /limit_req_zone\s+\$binary_remote_addr\s+zone=go2rtc_ws/);
  assert.match(code, /limit_conn_zone\s+\$binary_remote_addr\s+zone=go2rtc_conn/);
});
