import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrinterConfig } from "../infra/printers/config";
import {
  buildAnycubicStatus,
  JOB_STATE_MAX_AGE_MS,
  parseInfoReport,
  type AnycubicObservation
} from "../infra/printers/anycubic/reports";
import {
  KOBRA_X_INFO_COOLING,
  KOBRA_X_INFO_FREE_AFTER_PRINT,
  KOBRA_X_INFO_PRINTING
} from "../infra/printers/anycubic/testkit/kobraXCaptures";
import type { PrinterLiveStatus } from "../infra/printers/status/types";
import type { CameraService } from "./cameraService";
import { EventFeed } from "./eventFeed";
import { PrinterPoller } from "./printerPoller";
import { assessRestartSafety, type RestartSafetyAssessment } from "./restartSafety";

/*
 * A Kobra X print, start to end, through the path the deploy gate reads:
 * captured `info` reports → the Anycubic adapter's status → the real poller →
 * restart-safety, gathered exactly as the runtime gathers it. A Kobra X never
 * has a canonical run (it is monitoring-only), so `run` is always null here.
 *
 * The regression: heating/purging before a print and cooling after it read as
 * status `unknown`, and restart-safety called `unknown` idle — so a deploy could
 * recreate the orchestrator across the start or the end of a print. A connection
 * lost mid-print read idle the same way.
 */

const PRINTER = {
  id: "anycubic-kobra-x",
  name: "Anycubic Kobra X",
  protocol: "anycubic-lan",
  host: "192.0.2.10",
  enabled: true,
  light: { enabled: false }
} as unknown as PrinterConfig;

const cameras = { probe: async () => {} } as unknown as CameraService;

/**
 * The non-printing phases were seen on 2026-11-18 through `/api/printers` only,
 * read-only: at the start (`extfilbox_filament_feeding` → `nozzle_purging`,
 * nozzle 240 °C, progress 3 %) and on each colour change of a multi-colour print
 * (`printing` → `extfilbox_filament_unfeeding` → `nozzle_purging` → `printing`
 * → `filament_cutting` …, every 20–60 s, progress 6 %), all status `unknown`.
 * The raw `info` was not recorded: these are the captured mid-print `info` with
 * just those observed fields changed.
 */
function phase(state: string, progress: number) {
  return {
    ...KOBRA_X_INFO_PRINTING,
    data: {
      ...KOBRA_X_INFO_PRINTING.data,
      project: { ...KOBRA_X_INFO_PRINTING.data.project, state, progress, curr_layer: 0 },
      temp: { curr_hotbed_temp: 75, curr_nozzle_temp: 240, target_hotbed_temp: 75, target_nozzle_temp: 240 }
    }
  };
}

function farm() {
  let clock = Date.parse("2026-11-18T20:00:00.000Z");
  let observation: AnycubicObservation = {
    job: null,
    jobObservedAt: null,
    temperatures: null,
    temperaturesObservedAt: null
  };
  const events = new EventFeed();
  const poller = new PrinterPoller(
    () => [PRINTER],
    cameras,
    events,
    () => {},
    undefined,
    () => false,
    undefined,
    async (printer): Promise<PrinterLiveStatus> => buildAnycubicStatus(printer, observation, clock)
  );

  return {
    events,
    poller,
    /**
     * An `info` answer arrives, then the poller polls. `ending` is the word a
     * matched `print` push named (KOBRA_X_PRINT_FINISHED), as the session keeps it.
     */
    async info(payload: unknown, ending: string | null = null): Promise<void> {
      clock += 5_000;
      const report = parseInfoReport(payload)!;
      observation = {
        job: report.job,
        jobObservedAt: clock,
        temperatures: report.temperatures,
        temperaturesObservedAt: clock,
        ending
      };
      await poller.pollOnce();
    },
    /** No `info` arrives for `ms`, then the poller polls. */
    async silence(ms: number): Promise<void> {
      clock += ms;
      await poller.pollOnce();
    },
    /** What `GET /restart-safety` answers right now. */
    verdict(): RestartSafetyAssessment {
      return assessRestartSafety(
        [
          {
            id: PRINTER.id,
            name: PRINTER.name,
            protocol: PRINTER.protocol,
            status: poller.getStatus(PRINTER.id),
            run: null,
            printInFlight: poller.hasPrintInFlight(PRINTER.id)
          }
        ],
        { now: () => new Date(clock) }
      );
    }
  };
}

function only(assessment: RestartSafetyAssessment) {
  assert.equal(assessment.printers.length, 1);
  return assessment.printers[0];
}

test("idle → feeding/purging (unknown) → printing → cooling (unknown) → idle: held from the first unknown to the confirmed idle", async () => {
  const kobra = farm();

  await kobra.info(KOBRA_X_INFO_FREE_AFTER_PRINT);
  assert.equal(kobra.poller.getStatus(PRINTER.id)?.status, "idle");
  assert.equal(kobra.verdict().safeToRestart, true, "a confirmed idle Kobra X holds nothing back");

  for (const [state, progress] of [["extfilbox_filament_feeding", 0], ["nozzle_purging", 3]] as const) {
    await kobra.info(phase(state, progress));
    const live = kobra.poller.getStatus(PRINTER.id)!;
    assert.equal(live.status, "unknown", `${state} is reported as unknown by the adapter`);
    assert.equal(live.stateText, state);
    const verdict = kobra.verdict();
    assert.equal(verdict.safeToRestart, false, `${state}: a print is starting — not safe`);
    assert.deepEqual(only(verdict).risks, ["state-unconfirmed"]);
    assert.equal(only(verdict).verdict, "at-risk");
  }

  await kobra.info(KOBRA_X_INFO_PRINTING);
  assert.equal(kobra.poller.hasPrintInFlight(PRINTER.id), true, "the start edge was observed across the unknowns");
  assert.ok(kobra.events.list().some((e) => /начал печать/.test(e.text)));
  assert.deepEqual(only(kobra.verdict()).risks, ["untracked-print"]);

  await kobra.info(KOBRA_X_INFO_COOLING);
  assert.equal(kobra.poller.getStatus(PRINTER.id)?.status, "unknown");
  assert.equal(kobra.poller.hasPrintInFlight(PRINTER.id), true, "cooling ends nothing yet");
  assert.equal(kobra.verdict().safeToRestart, false, "the completion has not been observed — not safe");
  assert.deepEqual(only(kobra.verdict()).risks, ["state-unconfirmed"]);

  await kobra.info(KOBRA_X_INFO_FREE_AFTER_PRINT, "finished");
  assert.ok(kobra.events.list().some((e) => /завершил печать/.test(e.text)), "the completion was recorded");
  assert.equal(kobra.poller.hasPrintInFlight(PRINTER.id), false);
  const after = kobra.verdict();
  assert.equal(after.safeToRestart, true, "confirmed idle again: the gate opens without waiting");
  assert.equal(after.activePrints, 0);
});

test("colour changes mid-print (unknown every 20–60 s) hold the gate on every sample, and start or end nothing", async () => {
  // Pre-fix, /restart-safety flipped untracked-print ↔ idle with each phase, so
  // whether deploy.sh's single sample allowed a recreate was down to timing.
  const kobra = farm();
  await kobra.info(KOBRA_X_INFO_FREE_AFTER_PRINT);
  await kobra.info(KOBRA_X_INFO_PRINTING);
  const starts = () => kobra.events.list().filter((e) => /начал печать/.test(e.text)).length;
  assert.equal(starts(), 1);

  for (const state of ["extfilbox_filament_unfeeding", "nozzle_purging", "printing", "filament_cutting", "extfilbox_filament_feeding", "nozzle_purging", "printing"]) {
    await kobra.info(phase(state, 6));
    const verdict = kobra.verdict();
    assert.equal(verdict.safeToRestart, false, `${state}: mid-print — not safe`);
    assert.deepEqual(only(verdict).risks, [state === "printing" ? "untracked-print" : "state-unconfirmed"]);
    assert.equal(kobra.poller.hasPrintInFlight(PRINTER.id), true, `${state}: still the same print`);
  }
  assert.equal(starts(), 1, "a colour change is neither a new start…");
  assert.ok(!kobra.events.list().some((e) => /завершил печать|режим ожидания/.test(e.text)), "…nor an end");
});

test("a print started at the printer while the orchestrator watches: stale and lost telemetry never read idle", async () => {
  const kobra = farm();
  await kobra.info(KOBRA_X_INFO_FREE_AFTER_PRINT);
  await kobra.info(phase("nozzle_purging", 3));
  await kobra.info(KOBRA_X_INFO_PRINTING);

  // No `info` for longer than the adapter trusts: the status goes offline.
  await kobra.silence(JOB_STATE_MAX_AGE_MS + 1_000);
  const stale = kobra.poller.getStatus(PRINTER.id)!;
  assert.equal(stale.online, false);
  assert.equal(stale.status, "offline");
  assert.equal(kobra.verdict().safeToRestart, false, "the poller still holds the print a restart would forget");
  assert.deepEqual(only(kobra.verdict()).risks, ["untracked-print"]);

  // Telemetry comes back mid-print: the same print, still held.
  await kobra.info(KOBRA_X_INFO_PRINTING);
  assert.equal(kobra.poller.getStatus(PRINTER.id)?.status, "printing");
  assert.equal(kobra.poller.hasPrintInFlight(PRINTER.id), true);
  assert.deepEqual(only(kobra.verdict()).risks, ["untracked-print"]);

  // Lost again during the cool-down: still the same print, still held.
  await kobra.info(KOBRA_X_INFO_COOLING);
  await kobra.silence(JOB_STATE_MAX_AGE_MS + 1_000);
  assert.equal(kobra.verdict().safeToRestart, false);

  // Back, already free: the reconnect reconciles the print, and the hold is released.
  await kobra.info(KOBRA_X_INFO_FREE_AFTER_PRINT);
  assert.ok(kobra.events.list().some((e) => /во время потери связи/.test(e.text)), "the unobserved ending was reconciled");
  assert.equal(kobra.poller.hasPrintInFlight(PRINTER.id), false);
  assert.equal(kobra.verdict().safeToRestart, true);
});

test("a Kobra X the orchestrator never saw printing holds nothing while unreachable", async () => {
  // Switched off or out of reach from the start: no print is held in memory, so
  // a restart costs nothing — an unreachable printer must not block deploys forever.
  const kobra = farm();
  await kobra.silence(1_000);
  const waiting = kobra.poller.getStatus(PRINTER.id)!;
  assert.equal(waiting.online, false);
  assert.equal(waiting.status, "unknown", "connected, no `info` yet");
  assert.equal(kobra.verdict().safeToRestart, true);

  await kobra.info(KOBRA_X_INFO_FREE_AFTER_PRINT);
  await kobra.silence(JOB_STATE_MAX_AGE_MS + 1_000);
  assert.equal(kobra.poller.getStatus(PRINTER.id)?.status, "offline");
  assert.equal(kobra.verdict().safeToRestart, true);
});
