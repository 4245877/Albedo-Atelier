import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  LAUNCH_CLIENT_DEADLINE_MS,
  LAUNCH_CLIENT_MARGIN_MS,
  LAUNCH_WORST_CASE_MS
} from "./budget";
import {
  COMMAND_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS
} from "../../infra/printers/files/bambuFtps";
import { START_CONFIRM_TIMEOUT_MS } from "../../infra/printers/status/bambuStart";

/*
 * The launch timeout layers, as ONE number.
 *
 * `POST /api/print/launch` does the whole physical chain in one request, each
 * step bounded by its own constant in its own module — and the client's deadline
 * lived in a different application entirely. They drifted into an overlap: 240 s
 * on the dashboard against a 336 s server path, so for 96 seconds the operator
 * was told the launch had failed while the printer was still starting it.
 */

test("the worst case really is the sum of the steps a launch performs", () => {
  // Not a magic number: every part is a timeout that actually bounds a step.
  assert.ok(
    LAUNCH_WORST_CASE_MS > TRANSFER_TIMEOUT_MS + START_CONFIRM_TIMEOUT_MS,
    "the transfer and the start confirmation are both inside one request"
  );
  assert.ok(
    LAUNCH_WORST_CASE_MS > TRANSFER_TIMEOUT_MS + START_CONFIRM_TIMEOUT_MS + CONNECT_TIMEOUT_MS,
    "…and verifying the delivery opens a second FTPS session of its own"
  );
  assert.ok(COMMAND_TIMEOUT_MS > 0);
});

test("the client is always the last to give up", () => {
  assert.ok(
    LAUNCH_CLIENT_DEADLINE_MS > LAUNCH_WORST_CASE_MS,
    "a client that gives up first turns the server's verdict into a phantom failure"
  );
  assert.equal(LAUNCH_CLIENT_DEADLINE_MS - LAUNCH_WORST_CASE_MS, LAUNCH_CLIENT_MARGIN_MS);
});

test("the dashboard's launch deadline honours the server's budget", () => {
  // A cross-application invariant, checked by reading the other app's source:
  // the two constants live in different codebases and drifted 96 s apart, and
  // nothing but this test connects them.
  const controller = path.resolve(
    __dirname,
    "../../../../print-dashboard/features/launch/controller.js"
  );
  const source = fs.readFileSync(controller, "utf8");
  const match = source.match(/const LAUNCH_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(match, `LAUNCH_TIMEOUT_MS not found in ${controller}`);
  const clientMs = Number(match[1]);

  assert.ok(
    clientMs >= LAUNCH_CLIENT_DEADLINE_MS,
    `the dashboard waits ${clientMs} ms but the server can take ${LAUNCH_WORST_CASE_MS} ms — ` +
      `raise LAUNCH_TIMEOUT_MS to at least ${LAUNCH_CLIENT_DEADLINE_MS}`
  );
});
