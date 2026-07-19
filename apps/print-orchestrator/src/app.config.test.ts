import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApp } from "./app";
import { env } from "./shared/env";

test("Fastify startup hooks use the real-device startup budget", () => {
  const app = buildApp();
  assert.equal(app.initialConfig.pluginTimeout, env.startupTimeoutMs);
  assert.ok(
    app.initialConfig.pluginTimeout > 10_000,
    "the budget must exceed Fastify's 10 s default for the first device poll"
  );
});

test("an explicit Fastify plugin timeout still overrides the deployment default", () => {
  const app = buildApp({ pluginTimeout: 12_345 });
  assert.equal(app.initialConfig.pluginTimeout, 12_345);
});
