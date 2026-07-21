import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";

import Fastify from "fastify";

import { loggerConfig } from "./logger";

/*
 * Behavioural check: build a real Pino instance from `loggerConfig` (via
 * Fastify, exactly as the app does) and assert the credential headers are
 * censored in the emitted record — not merely present in the config array.
 */
function captureLogs() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    }
  });
  const records = () =>
    chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  return { stream, records };
}

test("credential-bearing headers are redacted; ordinary headers pass through", async () => {
  const capture = captureLogs();
  const app = Fastify({ logger: { ...loggerConfig, level: "info", stream: capture.stream } });

  app.log.info(
    {
      headers: {
        authorization: "Bearer super-secret-token",
        cookie: "session=super-secret-token",
        "x-api-token": "super-secret-token",
        "x-service-token": "super-secret-token",
        "content-type": "application/json"
      }
    },
    "inbound"
  );
  await app.close();

  const record = capture.records().find((r) => r.msg === "inbound");
  assert.ok(record, "the log line was captured");
  assert.equal(record.headers.authorization, "[redacted]");
  assert.equal(record.headers.cookie, "[redacted]");
  assert.equal(record.headers["x-api-token"], "[redacted]");
  assert.equal(record.headers["x-service-token"], "[redacted]");
  assert.equal(
    record.headers["content-type"],
    "application/json",
    "a non-secret header is left untouched"
  );

  const everything = capture.records().map((r) => JSON.stringify(r)).join("\n");
  assert.equal(
    everything.includes("super-secret-token"),
    false,
    "no secret value survives anywhere in the emitted logs"
  );
});
