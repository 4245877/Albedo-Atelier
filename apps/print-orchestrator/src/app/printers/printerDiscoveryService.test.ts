import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { openPrintQueueStore } from "../../infra/db/store";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { PrinterRecord } from "../../domain/printers/config";
import { NO_AUTOMATIC_CONTINUATION, DEFAULT_LIGHT_SETTINGS } from "../../domain/printers/config";
import type { PrinterConfig } from "../../infra/printers/config";
import type { DiscoveryResult } from "../../infra/printers/discovery";
import { PrinterDiscoveryService } from "./printerDiscoveryService";

/*
 * The three rules that keep a background probe from being a nuisance: a failure
 * never erases what was learned, an unchanged probe never writes, and the
 * interval is honoured. All three are exercised against a real SQLite store,
 * because the write-skipping is the part that only matters at the storage seam.
 */

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function openStore(): PrintQueueStore {
  const dir = mkdtempSync(join(tmpdir(), "discovery-"));
  dirs.push(dir);
  return openPrintQueueStore(join(dir, "queue.db"));
}

function printerRecord(): PrinterRecord {
  return {
    id: "bambu-a1",
    name: "Bambu A1",
    model: "",
    type: "FDM",
    printerClass: "",
    protocol: "bambu",
    host: "192.168.0.187",
    port: 8883,
    material: "",
    nozzleDiameterMm: null,
    nozzleType: "",
    buildVolume: null,
    swatch: "",
    snapshotUrl: "",
    streamUrl: "",
    interfaceUrl: "",
    enabled: true,
    apiKey: "",
    serial: "0309CA470100001",
    accessCode: "12345678",
    allowInsecureTls: true,
    automaticContinuation: { ...NO_AUTOMATIC_CONTINUATION },
    light: { ...DEFAULT_LIGHT_SETTINGS },
    position: 10,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 1,
    metadata: {}
  };
}

const CONFIG = { id: "bambu-a1", protocol: "bambu" } as PrinterConfig;

const NOZZLE_FACTS: DiscoveryResult = {
  succeeded: true,
  facts: {
    nozzleType: { value: "hardened_steel", source: "printer", via: "MQTT print.nozzle_type" },
    nozzleDiameterMm: { value: 0.4, source: "printer", via: "MQTT print.nozzle_diameter" }
  },
  error: null
};

function seeded(): { store: PrintQueueStore; now: { value: number } } {
  const store = openStore();
  store.repositories.printers.insert(printerRecord());
  return { store, now: { value: Date.parse("2026-08-07T10:00:00.000Z") } };
}

test("a first probe stores what the device reported", async () => {
  const { store, now } = seeded();
  const service = new PrinterDiscoveryService(store, {
    now: () => new Date(now.value),
    probe: async () => NOZZLE_FACTS
  });

  await service.refresh(CONFIG);

  const stored = service.get("bambu-a1");
  assert.equal(stored?.succeeded, true);
  assert.equal(stored?.facts.nozzleType?.value, "hardened_steel");
  assert.equal(stored?.facts.nozzleType?.via, "MQTT print.nozzle_type");
  assert.equal(stored?.probedAt, "2026-08-07T10:00:00.000Z");
});

test("an unchanged probe writes nothing — no version bump, no disk churn", async () => {
  const { store, now } = seeded();
  const service = new PrinterDiscoveryService(store, {
    now: () => new Date(now.value),
    probe: async () => NOZZLE_FACTS
  });

  await service.refresh(CONFIG);
  const first = service.get("bambu-a1");

  now.value += 600_000;
  await service.refresh(CONFIG);
  const second = service.get("bambu-a1");

  assert.equal(second?.version, first?.version, "an identical fact set must not bump the version");
  assert.equal(second?.probedAt, first?.probedAt, "nor rewrite the probe timestamp");
});

test("a changed fact is written and bumps the version", async () => {
  const { store, now } = seeded();
  let result = NOZZLE_FACTS;
  const service = new PrinterDiscoveryService(store, {
    now: () => new Date(now.value),
    probe: async () => result
  });

  await service.refresh(CONFIG);
  const before = service.get("bambu-a1");

  // The operator swapped the nozzle and updated the printer's own setting.
  result = {
    succeeded: true,
    facts: {
      ...NOZZLE_FACTS.facts,
      nozzleDiameterMm: { value: 0.6, source: "printer", via: "MQTT print.nozzle_diameter" }
    },
    error: null
  };
  now.value += 600_000;
  await service.refresh(CONFIG);

  const after = service.get("bambu-a1");
  assert.equal(after?.facts.nozzleDiameterMm?.value, 0.6);
  assert.equal(after?.version, (before?.version ?? 0) + 1);
});

test("a failed probe records the failure but keeps the last known facts", async () => {
  const { store, now } = seeded();
  let result = NOZZLE_FACTS;
  const service = new PrinterDiscoveryService(store, {
    now: () => new Date(now.value),
    probe: async () => result
  });

  await service.refresh(CONFIG);

  result = { succeeded: false, facts: {}, error: "принтер не ответил" };
  now.value += 600_000;
  await service.refresh(CONFIG);

  const stored = service.get("bambu-a1");
  assert.equal(stored?.succeeded, false);
  assert.equal(stored?.error, "принтер не ответил");
  // A printer that is briefly offline has not changed its nozzle.
  assert.equal(stored?.facts.nozzleType?.value, "hardened_steel");
});

test("a successful probe drops facts the device has stopped reporting", async () => {
  const { store, now } = seeded();
  let result = NOZZLE_FACTS;
  const service = new PrinterDiscoveryService(store, {
    now: () => new Date(now.value),
    probe: async () => result
  });

  await service.refresh(CONFIG);

  // The AMS was unplugged: the device no longer reports it, so neither do we.
  result = {
    succeeded: true,
    facts: { nozzleType: NOZZLE_FACTS.facts.nozzleType },
    error: null
  };
  now.value += 600_000;
  await service.refresh(CONFIG);

  assert.equal(service.get("bambu-a1")?.facts.nozzleDiameterMm, undefined);
});

test("refreshDue honours the interval", async () => {
  const { store, now } = seeded();
  let probes = 0;
  const service = new PrinterDiscoveryService(store, {
    now: () => new Date(now.value),
    intervalMs: 300_000,
    probe: async () => {
      probes += 1;
      return NOZZLE_FACTS;
    }
  });

  await service.refreshDue([CONFIG]);
  assert.equal(probes, 1, "never probed before → due immediately");

  now.value += 60_000;
  await service.refreshDue([CONFIG]);
  assert.equal(probes, 1, "still fresh → not re-probed");

  now.value += 300_000;
  await service.refreshDue([CONFIG]);
  assert.equal(probes, 2, "past the interval → probed again");
});

test("refreshDue never rejects when a probe throws", async () => {
  const { store, now } = seeded();
  const service = new PrinterDiscoveryService(store, {
    now: () => new Date(now.value),
    probe: async () => {
      throw new Error("сеть недоступна");
    }
  });

  // The poll loop calls this fire-and-forget; a rejection would surface as an
  // unhandled rejection and take telemetry down with it.
  await service.refreshDue([CONFIG]);
  assert.equal(service.get("bambu-a1"), null);
});

test("a concurrent refresh does not probe the same printer twice", async () => {
  const { store, now } = seeded();
  let probes = 0;
  // Held on an object so the assignment inside the executor is not narrowed away.
  const gate: { release: () => void } = { release: () => {} };
  const service = new PrinterDiscoveryService(store, {
    now: () => new Date(now.value),
    probe: async () => {
      probes += 1;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return NOZZLE_FACTS;
    }
  });

  const first = service.refresh(CONFIG);
  const second = service.refresh(CONFIG);
  await Promise.resolve();
  gate.release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(probes, 1);
  // The second caller JOINS the running probe rather than being handed whatever
  // was on disk beforehand — which for a first probe would have been nothing.
  assert.ok(a, "the joined caller must get the probe's result");
  assert.deepEqual(b, a);
});

test("removing a printer takes its discovery row with it", async () => {
  const { store, now } = seeded();
  const service = new PrinterDiscoveryService(store, {
    now: () => new Date(now.value),
    probe: async () => NOZZLE_FACTS
  });

  await service.refresh(CONFIG);
  assert.ok(service.get("bambu-a1"));

  // The FK cascade is what keeps a re-created id from inheriting a stale profile.
  store.repositories.printers.delete("bambu-a1");
  assert.equal(service.get("bambu-a1"), null);
});
