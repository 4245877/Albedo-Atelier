import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import type { AmsTraySnapshot, PrinterLiveStatus } from "../infra/printers/status/types";
import type { CameraService } from "./cameraService";
import { EventFeed } from "./eventFeed";
import { FilamentConsumption } from "./filamentConsumption";
import { PrinterPoller } from "./printerPoller";

/*
 * AT-006 — an unexpected restart mid-print must not lose the accounting.
 *
 * Two trackers used to exist and only one survived a restart: the canonical
 * PrintRun in SQLite came back, but the poller's in-memory identity (run id,
 * start time, AMS baseline) did not. Because a run is minted only on a
 * not-printing → printing EDGE — which never arrives for a print that was
 * already running when the process started — a completion observed after a
 * restart reached the deduction path with `run === undefined`, so:
 *   * filament auto-deduction was skipped entirely (a feed line, nothing more),
 *   * and the completion was recorded with no duration.
 *
 * These tests drive a REAL PrinterPoller across a simulated process restart:
 * the first poller is discarded and a second is constructed, exactly as a
 * container recreation would, while the canonical run persists in a stand-in
 * store.
 */

const RealDate = Date;
let fakeNow = RealDate.UTC(2026, 7, 18, 6, 0, 0);

class FakeDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date> | []) {
    if (args.length === 0) super(fakeNow);
    else super(...args);
  }
  static now(): number {
    return fakeNow;
  }
}

const cameras = { probe: async () => {} } as unknown as CameraService;
const MIN = 60 * 1000;

let script: {
  status: PrinterLiveStatus["status"];
  amsTrays?: AmsTraySnapshot[] | null;
  stateText?: string | null;
};

beforeEach(() => {
  // @ts-expect-error controllable clock
  globalThis.Date = FakeDate;
  fakeNow = RealDate.UTC(2026, 7, 18, 6, 0, 0);
  script = { status: "idle" };
});

afterEach(() => {
  globalThis.Date = RealDate;
});

function config(id: string, protocol: PrinterConfig["protocol"] = "bambu"): PrinterConfig {
  return {
    id,
    name: id.toUpperCase(),
    model: "A1",
    type: "FDM",
    protocol,
    host: "127.0.0.1",
    port: 8883,
    material: "",
    swatch: "",
    snapshotUrl: "",
    streamUrl: "",
    interfaceUrl: "",
    enabled: true,
    apiKey: "",
    serial: "",
    accessCode: "",
    light: {
      enabled: false,
      pin: "",
      invert: false,
      onGcode: "",
      offGcode: "",
      statusObject: "",
      statusField: "value",
      bambuNode: ""
    }
  };
}

function statusFor(printer: PrinterConfig): PrinterLiveStatus {
  return {
    id: printer.id,
    online: script.status !== "offline",
    status: script.status,
    currentFile: script.status === "printing" ? "vase.3mf" : null,
    progressPct: null,
    remainingMinutes: null,
    filamentUsedMm: null,
    amsTrays: script.amsTrays ?? null,
    nozzleDiameterMm: null,
    nozzleType: null,
    activeFilament: null,
    nozzleTemp: null,
    nozzleTarget: null,
    bedTemp: null,
    bedTarget: null,
    chamberTemp: null,
    light: null,
    stateText: script.stateText ?? null,
    stateMessage: null,
    faults: [],
    mediaPresent: null,
    error: null,
    updatedAt: new Date().toISOString()
  };
}

function trays(remain: number): AmsTraySnapshot[] {
  return [
    {
      id: "0",
      slot: 0,
      remain,
      type: "PLA",
      color: "FFFFFF",
      trayUuid: "uuid-0"
    } as unknown as AmsTraySnapshot
  ];
}

/** Stand-in for the canonical SQLite run: it is what survives the "restart". */
type CanonicalRun = {
  id: string;
  file: string | null;
  startedAtMs: number | null;
  amsStart?: AmsTraySnapshot[] | null;
};

function makePoller(
  printer: PrinterConfig,
  canonical: { current: CanonicalRun | null },
  filament: FilamentConsumption,
  events: EventFeed,
  opts: { withRecovery: boolean }
): PrinterPoller {
  return new PrinterPoller(
    () => [printer],
    cameras,
    events,
    () => {},
    undefined,
    () => false,
    filament,
    async (p) => statusFor(p),
    undefined,
    opts.withRecovery
      ? {
          adoptRun: () => canonical.current,
          persistAmsBaseline: (_printerId, amsStart) => {
            if (canonical.current) canonical.current.amsStart = amsStart;
          }
        }
      : undefined
  );
}

test("a print that survives a restart keeps its run id, duration and deduction", async () => {
  const printer = config("bambu-a1");
  const events = new EventFeed();
  const deducted: { key: string | undefined; grams: number | undefined }[] = [];
  const filament = new FilamentConsumption(
    {
      enabled: true,
      consume: async (payload: { idempotencyKey?: string; grams?: number }) => {
        deducted.push({ key: payload.idempotencyKey, grams: payload.grams });
        return { ok: true } as never;
      }
    } as never,
    events
  );

  // The canonical run the dispatcher created; this is what SQLite holds.
  const canonical = {
    current: {
      id: "run-canonical-1",
      file: "vase.3mf",
      startedAtMs: fakeNow,
      amsStart: null
    } as CanonicalRun | null
  };

  // ── process lifetime #1: the print starts and runs for two hours ──────────
  const first = makePoller(printer, canonical, filament, events, { withRecovery: true });
  script = { status: "idle", amsTrays: trays(100) };
  await first.pollOnce(); // baseline
  script = { status: "printing", amsTrays: trays(100) };
  await first.pollOnce(); // start edge -> run minted, AMS baseline persisted

  assert.ok(
    canonical.current?.amsStart,
    "the AMS baseline must be written to the canonical run, not just held in memory"
  );

  fakeNow += 120 * MIN;

  // ── the restart: poller #1 is discarded entirely ─────────────────────────
  const second = makePoller(printer, canonical, filament, events, { withRecovery: true });

  // The printer is still printing; there is no start edge for the new process.
  script = { status: "printing", amsTrays: trays(40) };
  await second.pollOnce();

  // ── completion, observed by the NEW process ──────────────────────────────
  fakeNow += 10 * MIN;
  script = { status: "idle", amsTrays: trays(40), stateText: "complete" };
  await second.pollOnce();

  // 1. duration recovered from the canonical start, not lost
  const avg = second.today.getAvgPrintMs();
  assert.equal(avg, 130 * MIN, "duration must span the WHOLE print, across the restart");

  // 2. filament deducted exactly once
  assert.equal(deducted.length, 1, "exactly one deduction for one physical print");

  // 3. the idempotency key is anchored to the CANONICAL run id, so a deduction
  //    attempted by another process lifetime cannot double-count
  assert.ok(
    deducted[0].key?.includes("run-canonical-1"),
    `idempotency key must derive from the canonical run id, got: ${deducted[0].key}`
  );

  // 4. no "not tracked — deduct by hand" warning
  const feed = events.list().map((e) => e.text).join("\n");
  assert.ok(
    !/не отслеживалась/.test(feed),
    "a recovered run must not be reported as untracked"
  );
});

test("without recovery the same restart loses the deduction (the pre-fix behaviour)", async () => {
  const printer = config("bambu-a1");
  const events = new EventFeed();
  const deducted: unknown[] = [];
  const filament = new FilamentConsumption(
    {
      enabled: true,
      consume: async () => {
        deducted.push(1);
        return { ok: true } as never;
      }
    } as never,
    events
  );
  const canonical = { current: null as CanonicalRun | null };

  const first = makePoller(printer, canonical, filament, events, { withRecovery: false });
  script = { status: "idle", amsTrays: trays(100) };
  await first.pollOnce();
  script = { status: "printing", amsTrays: trays(100) };
  await first.pollOnce();

  fakeNow += 120 * MIN;
  const second = makePoller(printer, canonical, filament, events, { withRecovery: false });
  script = { status: "printing", amsTrays: trays(40) };
  await second.pollOnce();
  fakeNow += 10 * MIN;
  script = { status: "idle", amsTrays: trays(40), stateText: "complete" };
  await second.pollOnce();

  assert.equal(deducted.length, 0, "pre-fix: the deduction is skipped");
  assert.equal(second.today.getAvgPrintMs(), null, "pre-fix: the duration is lost");

  // ...and the debt is now recorded DURABLY rather than only as a feed line.
  const owed = filament.listUnreconciled();
  assert.equal(owed.length, 1, "an unreconciled deduction must be recorded durably");
  assert.equal(owed[0].printerId, "bambu-a1");
  assert.match(owed[0].reason, /перезапуск/);
});

test("unreconciled debts survive serialization and can be acknowledged", () => {
  const events = new EventFeed();
  const filament = new FilamentConsumption({ enabled: true, consume: async () => ({ ok: true }) } as never, events);
  const printer = config("k2", "moonraker");

  // Reach the durable record through the public completion path.
  filament.consumeForPrint(
    printer,
    { ...statusFor(printer), status: "printing" },
    { ...statusFor(printer), status: "idle" },
    undefined,
    "part.gcode"
  );

  const owed = filament.serializeUnreconciled();
  assert.equal(owed.length, 1);

  // A restored FilamentConsumption still holds it (this is the restart path).
  const restored = new FilamentConsumption(undefined, new EventFeed(), undefined, [], {
    initialUnreconciled: owed
  });
  assert.equal(restored.listUnreconciled().length, 1);
  assert.equal(restored.clearUnreconciled(owed[0].id), true);
  assert.equal(restored.listUnreconciled().length, 0);
  assert.equal(restored.clearUnreconciled("nope"), false);
});
