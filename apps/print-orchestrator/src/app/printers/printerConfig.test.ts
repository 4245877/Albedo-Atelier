import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

import { openPrintQueueStore } from "../../infra/db/store";
import { importPrintersConfig, PRINTERS_IMPORT_MARKER } from "../../infra/db/printersImport";
import type { PrintQueueStore } from "../../domain/print/repositories";
import type { PrinterConfigSource } from "../../infra/printers/config";
import { normalizePrinterRecord } from "../../infra/printers/config";
import { PrinterConfigService } from "./printerConfigService";

/*
 * The printer inventory as an operator drives it: add a printer, correct its
 * settings, rotate a Bambu access code, disable it, remove it — all without
 * touching a file or restarting anything.
 *
 * Two properties get the most attention here, because they are the ones that
 * make the feature trustworthy rather than merely convenient:
 *
 *   1. a credential never travels outbound, and an update that does not mention
 *      one keeps it (so the edit form need not hold a secret to submit);
 *   2. a committed change re-materializes the live runtime config — that is what
 *      "no rebuild" actually means.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "printer-config-"));
let store: PrintQueueStore;
let service: PrinterConfigService;
/** Every printer id the service announced as changed, in order. */
let changes: (string | null)[];
/** Printers whose live device connection the service dropped, in order. */
let disconnected: string[];
let dbIndex = 0;

beforeEach(() => {
  store?.close();
  dbIndex += 1;
  store = openPrintQueueStore(path.join(TMP, `queue-${dbIndex}.db`));
  changes = [];
  disconnected = [];
  service = new PrinterConfigService(store, {
    onChanged: (id) => changes.push(id),
    disconnect: (id) => disconnected.push(id),
    // A probe that never touches a device: connection tests are about wiring
    // here, and a real one would need a printer on the LAN.
    probe: async (printer) => ({
      online: printer.accessCode === "12345678",
      status: printer.accessCode === "12345678" ? "idle" : "offline",
      error: printer.accessCode === "12345678" ? null : "Неверный код доступа"
    })
  });
});

after(() => {
  store?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const bambu = {
  id: "bambu-a1",
  name: "Bambu Lab A1",
  protocol: "bambu",
  host: "192.168.0.187",
  port: 8883,
  serial: "01P00A000000000",
  accessCode: "12345678",
  allowInsecureTls: true
};

// ── Adding a printer ─────────────────────────────────────────────────────────

test("a printer added from the UI becomes part of the live config immediately", () => {
  const view = service.create(bambu);

  assert.equal(view.id, "bambu-a1");
  assert.equal(view.protocol, "bambu");
  // The runtime was told exactly which printer changed, so it can drop that
  // printer's device connection and reinstall the config without a restart.
  assert.deepEqual(changes, ["bambu-a1"]);

  const live = service.materialize();
  assert.equal(live.length, 1);
  assert.equal(live[0].accessCode, "12345678");
  // Protocol-derived defaults are applied on materialization, not stored.
  assert.equal(live[0].light.bambuNode, "chamber_light");
  assert.equal(live[0].light.enabled, true);
});

test("credentials are never returned — only whether they are configured", () => {
  const view = service.create(bambu);

  assert.deepEqual(view.secrets.accessCode, {
    set: true,
    source: "literal",
    envVar: null,
    resolved: true
  });
  assert.deepEqual(view.secrets.apiKey, {
    set: false,
    source: "none",
    envVar: null,
    resolved: false
  });
  // Belt and braces: no secret value anywhere in the serialized view.
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes("12345678"), "the access code must not leave the service");
  assert.ok(!serialized.includes("01P00A000000000"), "the serial must not leave the service");
});

test("an id that could escape a path or a URL is refused", () => {
  assert.throws(
    () => service.create({ ...bambu, id: "../etc" }),
    /латиницу, цифры/
  );
  assert.throws(() => service.create({ ...bambu, id: "a b" }), /латиницу, цифры/);
});

test("a duplicate id is refused rather than shadowing the existing printer", () => {
  service.create(bambu);
  assert.throws(() => service.create({ ...bambu, name: "Другой" }), /уже настроен/);
});

test("an enabled Bambu printer without credentials is refused with a field-level reason", () => {
  assert.throws(
    () => service.create({ ...bambu, accessCode: undefined }),
    /код доступа/
  );
  // …but the same printer may be saved as a draft to be completed later.
  const draft = service.create({ ...bambu, accessCode: undefined, enabled: false });
  assert.equal(draft.enabled, false);
  assert.equal(draft.secrets.accessCode.set, false);
});

// ── Rotating a credential (the case the whole feature exists for) ────────────

test("rotating the access code replaces only it and takes effect at once", () => {
  service.create(bambu);
  changes = [];
  disconnected = [];

  const updated = service.update("bambu-a1", { accessCode: "87654321" });

  assert.equal(updated.secrets.accessCode.set, true);
  assert.deepEqual(changes, ["bambu-a1"]);
  // The MQTT client authenticated with the OLD code is dropped — otherwise it
  // would keep reporting a plausible status for credentials that no longer work.
  assert.deepEqual(disconnected, ["bambu-a1"]);
  const live = service.materialize();
  assert.equal(live[0].accessCode, "87654321");
  // Nothing else moved.
  assert.equal(live[0].host, "192.168.0.187");
  assert.equal(live[0].serial, "01P00A000000000");
});

test("moving a printer to a new address drops the connection to the old one", () => {
  service.create(bambu);
  disconnected = [];
  service.update("bambu-a1", { host: "192.168.0.190" });
  assert.deepEqual(disconnected, ["bambu-a1"]);
});

test("a settings-only edit keeps the working connection alive", () => {
  service.create(bambu);
  disconnected = [];
  service.update("bambu-a1", { material: "PETG", swatch: "#efe8d8" });
  assert.deepEqual(disconnected, [], "renaming a material must not interrupt telemetry");
});

test("an update that omits a credential keeps the stored one", () => {
  service.create(bambu);

  // Exactly what the edit form submits: every visible field, no secrets.
  service.update("bambu-a1", { name: "Bambu Lab A1 Combo", material: "PLA" });

  const live = service.materialize();
  assert.equal(live[0].name, "Bambu Lab A1 Combo");
  assert.equal(live[0].accessCode, "12345678", "the access code survived a settings-only edit");
  assert.equal(live[0].serial, "01P00A000000000");
});

test("an explicit null clears a credential — the only way to erase one", () => {
  service.create(bambu);
  service.update("bambu-a1", { accessCode: null, enabled: false });
  assert.equal(service.get("bambu-a1").secrets.accessCode.set, false);
  assert.equal(service.materialize()[0].accessCode, "");
});

test("the id is immutable — renaming would orphan snapshots and run history", () => {
  service.create(bambu);
  assert.throws(() => service.update("bambu-a1", { id: "bambu-a1-combo" }), /изменить нельзя/);
});

// ── Env-backed credentials keep working after the move to the database ──────

test("a ${VAR} credential is reported as an env reference, never as a value", () => {
  process.env.TEST_BAMBU_CODE = "from-env-code";
  try {
    service.create({ ...bambu, accessCode: "${TEST_BAMBU_CODE}" });
    const view = service.get("bambu-a1");
    assert.deepEqual(view.secrets.accessCode, {
      set: true,
      source: "env",
      envVar: "TEST_BAMBU_CODE",
      resolved: true
    });
    // The reference resolves for the driver…
    assert.equal(service.materialize()[0].accessCode, "from-env-code");
    // …and the value itself still never leaves the service.
    assert.ok(!JSON.stringify(view).includes("from-env-code"));
  } finally {
    delete process.env.TEST_BAMBU_CODE;
  }
});

test("an env reference to an unset variable is reported unresolved, not silently empty", () => {
  service.create({ ...bambu, accessCode: "${DEFINITELY_NOT_SET_ANYWHERE}", enabled: false });
  const status = service.get("bambu-a1").secrets.accessCode;
  assert.equal(status.source, "env");
  assert.equal(status.resolved, false, "an unset variable is a fixable fact, not a blank field");
});

// ── Enable / remove ─────────────────────────────────────────────────────────

test("disabling a printer drops it from the live config but keeps its settings", () => {
  service.create(bambu);
  disconnected = [];
  service.setEnabled("bambu-a1", false);

  const live = service.materialize();
  assert.equal(live.length, 1);
  assert.equal(live[0].enabled, false, "the poller filters on this flag");
  assert.equal(service.get("bambu-a1").secrets.accessCode.set, true);
  // The poll loop stops visiting a disabled printer, so nothing else would ever
  // close its MQTT session or its keep-alive timer.
  assert.deepEqual(disconnected, ["bambu-a1"]);

  // Re-enabling does not need a disconnect: there is nothing left to drop.
  disconnected = [];
  service.setEnabled("bambu-a1", true);
  assert.deepEqual(disconnected, []);
});

test("removing a printer takes it out of the config and announces the change", () => {
  service.create(bambu);
  changes = [];

  service.remove("bambu-a1");

  assert.deepEqual(service.materialize(), []);
  assert.deepEqual(changes, ["bambu-a1"]);
  assert.throws(() => service.get("bambu-a1"), /not found/i);
});

test("reads and writes against an unknown printer are 404, never a silent no-op", () => {
  assert.throws(() => service.get("ghost"), /not found/i);
  assert.throws(() => service.update("ghost", { name: "x" }), /not found/i);
  assert.throws(() => service.remove("ghost"), /not found/i);
});

// ── Connection probe ────────────────────────────────────────────────────────

test("the connection test reports what the device actually said", async () => {
  service.create(bambu);
  const ok = await service.testConnection("bambu-a1");
  assert.equal(ok.online, true);
  assert.equal(ok.error, null);

  service.update("bambu-a1", { accessCode: "00000000" });
  const bad = await service.testConnection("bambu-a1");
  assert.equal(bad.online, false);
  assert.equal(bad.error, "Неверный код доступа");
});

test("an unreachable printer is explained, not answered with a raw AbortError", async () => {
  // The real adapters pass the underlying network error through verbatim. That
  // is fine as telemetry, but this is the answer to «проверить связь» — it has
  // to name the likely cause while keeping the original text for diagnosis.
  const probing = new PrinterConfigService(store, {
    disconnect: () => {},
    probe: async () => ({
      online: false,
      status: "offline",
      error: "The operation was aborted due to timeout"
    })
  });
  probing.create({ ...bambu, id: "unreachable", host: "192.0.2.99" });

  const result = await probing.testConnection("unreachable");
  assert.match(result.error ?? "", /192\.0\.2\.99:8883/, "the address the operator typed");
  assert.match(result.error ?? "", /не ответил/);
  assert.match(result.error ?? "", /aborted due to timeout/, "the original text survives");
});

// ── Audit trail ─────────────────────────────────────────────────────────────

test("every change is audited by field name — never by credential value", () => {
  service.create(bambu, "миха");
  service.update("bambu-a1", { accessCode: "87654321" }, "миха");

  const events = store.repositories.audit.listByEntity("printer", "bambu-a1");
  const actions = events.map((e) => e.action);
  assert.ok(actions.includes("created"));
  assert.ok(actions.includes("updated"));
  assert.ok(events.every((e) => e.actor === "миха"));

  const update = events.find((e) => e.action === "updated");
  assert.deepEqual(update?.detail.secretsChanged, ["accessCode"]);
  assert.ok(!JSON.stringify(events).includes("87654321"), "audit rows carry no secrets");
});

// ── The one-time seed from the old file ─────────────────────────────────────

const seed = (records: unknown[], source: PrinterConfigSource = { kind: "file", path: "/x.json" }) =>
  async () => ({
    records: records
      .map((r, i) => normalizePrinterRecord(r, (i + 1) * 10))
      .flatMap((r) => (r ? [r] : [])),
    source
  });

test("the file config is imported once, and the database wins from then on", async () => {
  const first = await importPrintersConfig(store, { load: seed([bambu]) });
  assert.equal(first.skipped, false);
  assert.equal(first.imported, 1);
  assert.equal(service.list().length, 1);

  // The operator edits the imported printer…
  service.update("bambu-a1", { name: "Переименован" });

  // …and a restart re-runs the import against the SAME (unchanged) file.
  const second = await importPrintersConfig(store, { load: seed([bambu]) });
  assert.equal(second.skipped, true);
  assert.equal(second.imported, 0);
  assert.equal(
    service.get("bambu-a1").name,
    "Переименован",
    "the file must never revert an edit made in the dashboard"
  );
});

test("an empty seed still marks the import done, so a from-scratch farm stays empty", async () => {
  const result = await importPrintersConfig(store, { load: seed([]) });
  assert.equal(result.imported, 0);
  assert.ok(store.repositories.meta.get(PRINTERS_IMPORT_MARKER), "the marker is set anyway");

  service.create(bambu);
  // A later boot must not resurrect the old file over the printer just added.
  await importPrintersConfig(store, { load: seed([{ ...bambu, id: "ghost-from-file" }]) });
  assert.deepEqual(
    service.list().map((p) => p.id),
    ["bambu-a1"]
  );
});

test("the imported config keeps ${VAR} references verbatim", async () => {
  process.env.TEST_SEED_CODE = "seeded";
  try {
    await importPrintersConfig(store, {
      load: seed([{ ...bambu, accessCode: "${TEST_SEED_CODE}" }])
    });
    assert.equal(service.get("bambu-a1").secrets.accessCode.envVar, "TEST_SEED_CODE");
    assert.equal(service.materialize()[0].accessCode, "seeded");
  } finally {
    delete process.env.TEST_SEED_CODE;
  }
});
