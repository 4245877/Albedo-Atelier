import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

// loadPrintersConfig reads these live; keep FarmLifecycle.start() from touching a
// real config/printers.json (empty config → fast, deterministic).
process.env.PRINTERS_CONFIG_PATH = path.join(os.tmpdir(), "farm-decomp-no-such-file.json");
process.env.PRINTERS_CONFIG_JSON = "[]";

import type { FarmRuntime } from "../bootstrap/createRuntime";
import { createRuntime } from "../bootstrap/createRuntime";
import { ArtifactService } from "./artifacts/artifactService";
import { DashboardReadModel } from "./dashboardReadModel";
import { FarmCommands } from "./FarmCommands";
import { FarmLifecycle } from "./FarmLifecycle";
import { PrintQueueService } from "./printQueue/printQueueService";
import { registerQueueRoutes } from "../modules/queue/routes";

/*
 * The FarmStore decomposition. Proves the seams the refactor introduced:
 *   - the composition root (createRuntime) creates the services + repositories,
 *     lazily (constructing it opens no database);
 *   - FarmLifecycle recovers durable state BEFORE starting background processes,
 *     and on shutdown stops the workers/poller and closes the DB last;
 *   - FarmCommands only delegates to the specialised services;
 *   - routes run purely through explicitly-passed deps — no global FarmStore.
 */

// ── 1. Composition root creates the services + repositories (lazily) ──────────

test("createRuntime wires the services + repositories, opening the DB only on first use", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "farm-runtime-"));
  const runtime = createRuntime({ stateFilePath: path.join(dir, "state.json") });

  // Merely constructing the runtime opens no database file. (Asserted on a
  // throwaway local so the assertion does not narrow the getter's later reads.)
  const storeBeforeUse = runtime.printQueueStore;
  assert.equal(storeBeforeUse, null, "no DB until first access");
  assert.ok(runtime.reads instanceof DashboardReadModel, "read model is built eagerly");

  // First access opens the SQLite store + repositories and builds the services.
  assert.ok(runtime.printQueue instanceof PrintQueueService);
  const store = runtime.printQueueStore;
  assert.ok(store, "store opened lazily");
  assert.ok(store.repositories.tasks, "task repository present");
  assert.ok(store.repositories.printRuns, "run repository present");
  assert.ok(runtime.artifacts instanceof ArtifactService);
  assert.ok(runtime.slicing.presets && runtime.slicing.profiles && runtime.slicing.slices);
  assert.ok(runtime.scheduler, "the scheduler service is built per access over the live store");

  runtime.disposeQueue();
  const storeAfterDispose = runtime.printQueueStore;
  assert.equal(storeAfterDispose, null, "disposeQueue closes the store and drops refs");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 2 & 3. Lifecycle ordering, tested against a recording fake runtime ────────

interface OrderedRuntime {
  runtime: FarmRuntime;
  order: string[];
}

/** A minimal fake runtime that records the lifecycle calls FarmLifecycle makes. */
function orderedRuntime(): OrderedRuntime {
  const order: string[] = [];
  const runtime = {
    state: {
      useLogger: () => {},
      loadWarning: null,
      save: () => order.push("state.save"),
      flush: async () => {
        order.push("state.flush");
      }
    },
    ensureQueue: () => order.push("ensureQueue"),
    printQueueStore: {
      repositories: {
        startGuards: { list: () => [] },
        artifactAnalyses: { listUnfinished: () => [] }
      }
    },
    runLifecycle: {
      recover: () => {
        order.push("recover");
        return { held: 0, unwound: 0, running: 0 };
      }
    },
    // null → the slice-runtime probe and catalog import are skipped in start().
    sliceRunner: null,
    presetImportService: null,
    profileService: null,
    setConfig: () => order.push("setConfig"),
    inventory: { enabled: false, hasServiceToken: false },
    deviceCommands: { useLogger: () => {} },
    poller: {
      start: async () => {
        order.push("poller.start");
      },
      stop: async () => {
        order.push("poller.stop");
      }
    },
    artifactService: {
      close: () => order.push("artifact.close"),
      whenIdle: async () => {}
    },
    sliceService: {
      close: () => order.push("slice.close"),
      whenIdle: async () => {}
    },
    disposeQueue: () => order.push("disposeQueue")
  } as unknown as FarmRuntime;
  return { runtime, order };
}

test("FarmLifecycle.start recovers durable state BEFORE starting the poll loop", async () => {
  const { runtime, order } = orderedRuntime();
  await new FarmLifecycle(runtime).start();

  assert.ok(order.includes("recover"), "recovery ran");
  assert.ok(order.includes("poller.start"), "the poll loop started");
  assert.ok(
    order.indexOf("ensureQueue") < order.indexOf("recover"),
    "the queue DB opens before recovery reconciles it"
  );
  assert.ok(
    order.indexOf("recover") < order.indexOf("poller.start"),
    "recovery completes before any background process runs"
  );
  assert.ok(
    order.indexOf("setConfig") < order.indexOf("poller.start"),
    "the printer config is installed before the poll loop starts"
  );
});

test("FarmLifecycle.stop stops the poll loop + workers and closes the DB LAST", async () => {
  const { runtime, order } = orderedRuntime();
  const lifecycle = new FarmLifecycle(runtime);
  await lifecycle.stop();

  const dispose = order.indexOf("disposeQueue");
  assert.ok(dispose >= 0, "the store is closed");
  for (const step of ["poller.stop", "artifact.close", "slice.close", "state.flush"]) {
    assert.ok(order.indexOf(step) >= 0 && order.indexOf(step) < dispose, `${step} happens before the DB closes`);
  }
});

test("FarmLifecycle.stop is idempotent — a second call awaits the same shutdown", async () => {
  const { runtime, order } = orderedRuntime();
  const lifecycle = new FarmLifecycle(runtime);
  await Promise.all([lifecycle.stop(), lifecycle.stop()]);
  await lifecycle.stop();
  assert.equal(
    order.filter((s) => s === "disposeQueue").length,
    1,
    "the shutdown sequence ran exactly once"
  );
});

// ── 4. FarmCommands only delegates to the specialised services ────────────────

test("FarmCommands forwards each operation to the matching specialised service", () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return { name, args };
    };
  const runtime = {
    deviceCommands: {
      pause: rec("pause"),
      resume: rec("resume"),
      setLight: rec("setLight"),
      snapshot: rec("snapshot"),
      clearStartGuard: rec("clearStartGuard")
    },
    automations: { toggle: rec("toggle") },
    monitoring: { renew: () => ({ ttlMs: 60_000, expiresAt: new Date(60_000) }) },
    filament: {
      metrics: () => {
        calls.push(["metrics"]);
        return { pending: 3, dropped: { overflow: 0, expired: 1, rejected: 0 } };
      }
    }
  } as unknown as FarmRuntime;
  const commands = new FarmCommands(runtime);

  commands.pausePrinter("k2");
  commands.resumePrinter("k2");
  commands.setLight("k2", true);
  commands.snapshotPrinter("k2");
  commands.clearStartGuard("k2");
  commands.toggleAutomation("night-queue", false);

  assert.deepEqual(calls, [
    ["pause", "k2"],
    ["resume", "k2"],
    ["setLight", "k2", true],
    ["snapshot", "k2"],
    ["clearStartGuard", "k2"],
    ["toggle", "night-queue", false]
  ]);

  const lease = commands.renewMonitoringLease();
  assert.deepEqual(lease, { ok: true, ttlSeconds: 60, expiresAt: new Date(60_000).toISOString() });

  assert.deepEqual(commands.filamentQueueStats(), {
    pending: 3,
    dropped: { overflow: 0, expired: 1, rejected: 0 }
  });
});

// ── 6 & 7. Routes run through explicit deps, with no global FarmStore ─────────

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify();
});

afterEach(async () => {
  await app.close();
});

test("queue routes operate purely on the injected reads + commands (no farm singleton)", async () => {
  const calls: string[] = [];
  const fakeQueue = [{ id: "t1", title: "Chalice", status: "ready" }];
  const reads = {
    getQueue: () => fakeQueue,
    getNight: () => ({ window: "x", windowStart: null, windowEnd: null, candidates: [], pick: 0 })
  };
  const commands = {
    addQueueJob: () => {
      calls.push("addQueueJob");
      return fakeQueue[0];
    },
    advanceNightPick: () => {
      calls.push("advanceNightPick");
      return { window: "x", windowStart: null, windowEnd: null, candidates: [], pick: 1 };
    }
  };
  // Note: no FarmStore, no createRuntime — the route only ever sees these two
  // plain objects, proving it depends on nothing global.
  await app.register(registerQueueRoutes, {
    prefix: "/api/queue",
    reads: reads as never,
    commands: commands as never
  });

  const list = await app.inject({ method: "GET", url: "/api/queue" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), fakeQueue, "GET / returns exactly what the injected read model produced");

  const pick = await app.inject({ method: "POST", url: "/api/queue/night/pick" });
  assert.equal(pick.statusCode, 200);
  assert.deepEqual(calls, ["advanceNightPick"], "the mutation delegated to the injected command");
});
