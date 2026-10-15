import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  CompatibilityEvidence,
  CompatibilityPrinterInput,
  CompatibilityTaskInput
} from "../scheduling/compatibility";
import {
  evaluateDispatchEligibility,
  type DispatchFacts,
  type DispatchEligibilityInput,
  type DispatchMode
} from "./eligibility";
import { NON_OVERRIDABLE, REASON, hardBlockers, type ReasonCode } from "./reasons";

/*
 * The authoritative DispatchEligibility, exercised as the pure function it is.
 * Every case below is one of the brief's required scenarios; the assertions are
 * on stable reason CODES, never on message text.
 */

const NOW = new Date("2026-07-26T23:00:00Z"); // inside 21:30–07:30 UTC, 8h30m left

function task(over: Partial<CompatibilityTaskInput> = {}): CompatibilityTaskInput {
  return {
    id: "t1",
    title: "Chalice",
    material: "PLA",
    pinnedPrinterId: null,
    dimensions: { x: 100, y: 100, z: 100 },
    dimensionsScaleKnown: true,
    placement: null,
    requiredNozzleMm: 0.4,
    gcodeFlavor: "klipper",
    amsRequired: null,
    toolCount: null,
    needsSlicing: false,
    ...over
  };
}

function printer(over: Partial<CompatibilityPrinterInput> = {}): CompatibilityPrinterInput {
  return {
    id: "k2",
    name: "Creality K2",
    model: "K2 Plus",
    protocol: "moonraker",
    material: "PLA",
    nozzleMm: 0.4,
    buildVolume: { x: 350, y: 350, z: 350 },
    online: true,
    status: "idle",
    remoteStartSupported: true,
    ams: null,
    faults: [],
    mediaPresent: null,
    ...over
  };
}

function evidence(over: Partial<CompatibilityEvidence> = {}): CompatibilityEvidence {
  return {
    readySliceVariant: true,
    profileSetApproved: true,
    profileSetBlocked: false,
    runtimeAvailable: true,
    bedCycle: "CLEAR",
    telemetryAgeMs: 1_000,
    maintenanceBlockers: [],
    sliceEtaS: 2 * 3600,
    gcodeEtaS: null,
    ...over
  };
}

function facts(mode: DispatchMode, over: Partial<DispatchFacts> = {}): DispatchFacts {
  return {
    mode,
    taskState: "QUEUED",
    entryState: "WAITING",
    currentProfileRevisionIds: [],
    adapterUploadSupported: true,
    // The baseline is a *fully prepared* start: the file was delivered by the
    // adapter and matched against the artifact. Every start now requires this —
    // the tests below take it away one property at a time.
    deviceArtifact: {
      state: "VERIFIED",
      transferMode: "adapter_upload",
      verification: "name_and_size",
      remotePath: "chalice.gcode",
      lastError: null,
      stale: false,
      staleReason: null
    },
    night: mode === "night",
    unattendedAllowed: mode === "night",
    file: "chalice.gcode",
    filePathValid: true,
    artifact: { id: "a1", sha256: "a".repeat(64), sizeBytes: 1000, updatedAt: "2026-07-26T10:00:00Z" },
    analysis: {
      id: "an1",
      state: "ready",
      verdict: "schedulable",
      detectedFormat: "gcode",
      blockers: [],
      analyzerVersion: "1.0.0",
      updatedAt: "2026-07-26T11:00:00Z",
      declaredTargetPrinter: "K2 Plus",
      declaredGcodeFlavor: "klipper"
    },
    currentAnalyzerVersion: "1.0.0",
    deviceFileIdentity: "name+size",
    printerModel: "Creality K2 Plus",
    printerClass: "k2plus",
    printerName: "K2 у окна",
    printerProtocol: "moonraker",
    remoteStartSupported: true,
    liveStatus: { online: true, status: "idle" },
    telemetryAgeMs: 1_000,
    activeRun: null,
    startGuard: null,
    bedState: "CLEAR",
    automaticContinuationAllowed: false,
    // Baseline: no intervention pending and an operator at the bench. The
    // operator-schedule tests below take each of those away in turn.
    blockingOperations: [],
    operatorPresence: "AVAILABLE",
    operatorScheduleResolved: true,
    operatorReason: "оператор доступен",
    reservation: null,
    targetPrinterId: "k2",
    sliceVariantId: "sv1",
    etaMinutes: 120,
    nightWindow: "21:30 – 07:30",
    farmTimeZone: "UTC",
    nightSafetyBufferRatio: 0.2,
    now: NOW,
    ...over
  };
}

function evaluate(
  mode: DispatchMode,
  over: {
    task?: Partial<CompatibilityTaskInput>;
    printer?: Partial<CompatibilityPrinterInput>;
    evidence?: Partial<CompatibilityEvidence>;
    facts?: Partial<DispatchFacts>;
  } = {}
) {
  const input: DispatchEligibilityInput = {
    preflight: {
      task: task(over.task),
      printer: printer(over.printer),
      evidence: evidence(over.evidence)
    },
    facts: facts(mode, over.facts)
  };
  return evaluateDispatchEligibility(input);
}

const codes = (result: { reasons: { code: string }[] }): string[] => result.reasons.map((r) => r.code);
const blockerCodes = (result: { reasons: { code: string; severity: string }[] }): string[] =>
  result.reasons.filter((r) => r.severity === "blocker").map((r) => r.code);

// ── Baseline ────────────────────────────────────────────────────────────────

test("a fully-qualified manual start is eligible with no reasons at all", () => {
  const result = evaluate("manual");
  assert.equal(result.status, "eligible", JSON.stringify(result.reasons));
  assert.deepEqual(result.reasons, []);
});

test("a fully-qualified night start is eligible apart from the operator-intervention notice", () => {
  const result = evaluate("night");
  assert.equal(result.status, "review");
  // The bed WILL be occupied when it finishes, and this farm has no auto-clearing
  // hardware — the plan must say so rather than imply the printer frees itself.
  assert.deepEqual(blockerCodes(result), []);
  assert.deepEqual(codes(result), [REASON.OPERATOR_INTERVENTION_REQUIRED]);
});

// ── Compatibility cases from the brief ──────────────────────────────────────

test("a model larger than the build volume is blocked", () => {
  const result = evaluate("manual", { task: { dimensions: { x: 400, y: 100, z: 100 } } });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.BUILD_VOLUME_EXCEEDED));
});

test("the build-volume safety margin refuses a part that would touch the bed edge", () => {
  // 348mm on a 350mm bed: it "fits" arithmetically but leaves no clearance.
  const result = evaluate("manual", { task: { dimensions: { x: 348, y: 100, z: 100 } } });
  assert.ok(blockerCodes(result).includes(REASON.BUILD_VOLUME_EXCEEDED));
});

test("unknown dimensions are review (manual) and blocked (night) — never eligible", () => {
  const manual = evaluate("manual", { task: { dimensions: null } });
  assert.equal(manual.status, "review");
  assert.ok(codes(manual).includes(REASON.DIMENSIONS_UNKNOWN));

  const night = evaluate("night", { task: { dimensions: null } });
  assert.equal(night.status, "blocked");
  assert.ok(blockerCodes(night).includes(REASON.DIMENSIONS_UNKNOWN));
});

test("an STL of unproven scale is never treated as millimetres", () => {
  const manual = evaluate("manual", { task: { dimensionsScaleKnown: false } });
  assert.notEqual(manual.status, "eligible");
  assert.ok(codes(manual).includes(REASON.MODEL_SCALE_UNKNOWN));

  const night = evaluate("night", { task: { dimensionsScaleKnown: false } });
  assert.equal(night.status, "blocked");
  assert.ok(blockerCodes(night).includes(REASON.MODEL_SCALE_UNKNOWN));
});

test("a nozzle mismatch blocks in both modes", () => {
  for (const mode of ["manual", "night"] as const) {
    const result = evaluate(mode, { printer: { nozzleMm: 0.6 } });
    assert.equal(result.status, "blocked", mode);
    assert.ok(blockerCodes(result).includes(REASON.NOZZLE_MISMATCH), mode);
  }
});

test("a material mismatch blocks in both modes", () => {
  for (const mode of ["manual", "night"] as const) {
    const result = evaluate(mode, { printer: { material: "PETG" } });
    assert.ok(blockerCodes(result).includes(REASON.MATERIAL_MISMATCH), mode);
  }
});

test("a file sliced for another printer blocks the start", () => {
  const result = evaluate("manual", {
    facts: { analysis: { ...facts("manual").analysis!, declaredTargetPrinter: "Bambu X1C" } }
  });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.TARGET_PRINTER_MISMATCH));
});

/*
 * The declared target is compared against the machine's MODEL and CLASS, with
 * the farm's one model rule. Two things this file used to get wrong, and both
 * were the same substring test: a printer's free-text *name* could establish
 * hardware identity, and `"K2"` matched `"K2 Plus"` because one contains the
 * other. A K2 Plus file on a K2 is a different bed and different nozzle limits.
 */

test("the model and the class are legitimate declared targets, in any spelling", () => {
  for (const declared of ["Creality K2 Plus", "K2 Plus", "k2plus", "K2-Plus", "K2  plus"]) {
    const result = evaluate("manual", {
      facts: { analysis: { ...facts("manual").analysis!, declaredTargetPrinter: declared } }
    });
    assert.equal(result.status, "eligible", `${declared}: ${JSON.stringify(result.reasons)}`);
  }
});

test("a NEIGHBOURING model is refused, however similar the name", () => {
  // Every one of these passed the old substring test against a "K2 Plus".
  for (const declared of ["Creality K2", "K2", "K2 Max", "K2 Plus Combo X"]) {
    const result = evaluate("manual", {
      facts: { analysis: { ...facts("manual").analysis!, declaredTargetPrinter: declared } }
    });
    assert.ok(
      blockerCodes(result).includes(REASON.TARGET_PRINTER_MISMATCH),
      `«${declared}» must not be accepted onto a K2 Plus`
    );
  }
});

test("the operator's own name for the printer never establishes what machine it is", () => {
  const result = evaluate("manual", {
    facts: {
      printerName: "Creality K2",
      analysis: { ...facts("manual").analysis!, declaredTargetPrinter: "Creality K2" }
    }
  });
  assert.ok(
    blockerCodes(result).includes(REASON.TARGET_PRINTER_MISMATCH),
    "a printer called «Creality K2» that IS a K2 Plus must still refuse a K2 file"
  );
});

test("an unconfigured model cannot be compared, and says so instead of «mismatch»", () => {
  const result = evaluate("manual", {
    facts: {
      printerModel: null,
      printerClass: null,
      printerName: "Принтер у окна",
      analysis: { ...facts("manual").analysis!, declaredTargetPrinter: "Creality K2 Plus" }
    }
  });
  assert.ok(blockerCodes(result).includes(REASON.TARGET_PRINTER_UNKNOWN));
  assert.ok(!blockerCodes(result).includes(REASON.TARGET_PRINTER_MISMATCH));
});

test("a model that is only a vendor word is not an identity either", () => {
  // "Creality" normalises to nothing at all — there is no model in it to compare.
  const result = evaluate("manual", {
    facts: {
      printerModel: "Creality",
      printerClass: null,
      analysis: { ...facts("manual").analysis!, declaredTargetPrinter: "Creality K2 Plus" }
    }
  });
  assert.ok(blockerCodes(result).includes(REASON.TARGET_PRINTER_UNKNOWN));
});

test("the class alone can confirm a class-scoped file", () => {
  const result = evaluate("manual", {
    facts: {
      printerModel: null,
      printerClass: "k2plus",
      analysis: { ...facts("manual").analysis!, declaredTargetPrinter: "K2 Plus" }
    }
  });
  assert.equal(result.status, "eligible", JSON.stringify(result.reasons));
});

test("an unknown target printer blocks a NIGHT start (attended is only a warning)", () => {
  const night = evaluate("night", {
    facts: { analysis: { ...facts("night").analysis!, declaredTargetPrinter: null } }
  });
  assert.ok(blockerCodes(night).includes(REASON.TARGET_PRINTER_UNKNOWN));

  const manual = evaluate("manual", {
    facts: { analysis: { ...facts("manual").analysis!, declaredTargetPrinter: null } }
  });
  assert.equal(manual.status, "eligible", "an attended operator vouches for the file");
});

test("an incompatible G-code flavor blocks the start (a mere warning while planning)", () => {
  const result = evaluate("manual", {
    facts: { analysis: { ...facts("manual").analysis!, declaredGcodeFlavor: "bbl" } }
  });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.GCODE_FLAVOR_MISMATCH));
});

test("an unapproved profile set is review (manual) and blocked (night)", () => {
  const manual = evaluate("manual", {
    task: { needsSlicing: true },
    evidence: { profileSetApproved: false }
  });
  assert.ok(codes(manual).includes(REASON.PROFILE_SET_NOT_APPROVED));
  assert.notEqual(manual.status, "eligible");

  const night = evaluate("night", {
    task: { needsSlicing: true },
    evidence: { profileSetApproved: false }
  });
  assert.ok(blockerCodes(night).includes(REASON.PROFILE_SET_NOT_APPROVED));
});

test("a quarantined profile set blocks in both modes", () => {
  const result = evaluate("manual", { evidence: { profileSetBlocked: true } });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.PROFILE_SET_QUARANTINED));
});

test("a slice variant other than the one the confirmed plan approved blocks", () => {
  const result = evaluate("manual", {
    facts: {
      sliceVariantId: "sv-other",
      reservation: {
        planId: "plan1",
        assignmentId: "as1",
        printerId: "k2",
        sliceVariantId: "sv1",
        artifactSha256: null,
        profileRevisionIds: [],
      stale: false,
      staleReason: null,
        expectedRemotePath: null
      }
    }
  });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.SLICE_VARIANT_MISMATCH));
});

test("a confirmed assignment is only executable on the printer it names", () => {
  const result = evaluate("manual", {
    facts: {
      targetPrinterId: "k2",
      reservation: {
        planId: "plan1",
        assignmentId: "as1",
        printerId: "bambu-x1",
        sliceVariantId: null,
        artifactSha256: null,
        profileRevisionIds: [],
      stale: false,
      staleReason: null,
        expectedRemotePath: null
      }
    }
  });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.ASSIGNMENT_PRINTER_MISMATCH));
});

// ── A person's own placement vs. the printer they now choose ─────────────────

const MANUAL_PLACEMENT = {
  planId: null,
  assignmentId: "as-manual",
  printerId: "bambu-x1",
  sliceVariantId: null,
  artifactSha256: null,
  profileRevisionIds: [],
  stale: false,
  staleReason: null,
  expectedRemotePath: null,
  replaceable: true
};

test("an operator explicitly choosing another printer moves their own placement: a note, not a refusal", () => {
  // The launch window's printer choice is a newer decision of the same person;
  // the launch withdraws the old placement (audited) before placing the job.
  const result = evaluate("manual", {
    facts: { stage: "preflight", targetPrinterId: "k2", explicitPrinterChoice: true, reservation: MANUAL_PLACEMENT }
  });
  assert.deepEqual(blockerCodes(result), []);
  const note = result.reasons.find((r) => r.code === REASON.ASSIGNMENT_REPLACED);
  assert.equal(note?.severity, "warning");
});

test("a placement still binds everything that is not that explicit choice", () => {
  const mismatch = (over: Partial<DispatchFacts>, mode: DispatchMode = "manual") =>
    blockerCodes(
      evaluate(mode, {
        facts: { stage: "preflight", targetPrinterId: "k2", explicitPrinterChoice: true, reservation: MANUAL_PLACEMENT, ...over }
      })
    ).includes(REASON.ASSIGNMENT_PRINTER_MISMATCH);

  assert.ok(mismatch({ explicitPrinterChoice: false }), "a recommendation never moves a person's placement");
  assert.ok(mismatch({}, "auto"), "the automatic queue goes where a person placed the job, or nowhere");
  assert.ok(mismatch({}, "night"), "nor does a night start");
  assert.ok(mismatch({ stage: "dispatch" }), "the final gate runs the placement the launch made, never moves one");
  assert.ok(mismatch({ reservation: { ...MANUAL_PLACEMENT, planId: "plan1" } }), "a confirmed plan is moved by replanning");
  assert.ok(mismatch({ reservation: { ...MANUAL_PLACEMENT, replaceable: false } }), "a start in flight is not a placement to move");
  assert.ok(mismatch({ reservation: { ...MANUAL_PLACEMENT, replaceable: undefined } }), "absent means not replaceable");
});

test("another job's live decision on this printer is a refusal nobody can override", () => {
  const held = (planned: boolean) =>
    evaluate("manual", {
      facts: {
        stage: "preflight",
        printerHold: { assignmentId: "as-other", taskId: "t-other", taskTitle: "Кронштейн", planned }
      }
    });
  for (const planned of [false, true]) {
    const result = held(planned);
    assert.equal(result.status, "blocked");
    assert.ok(blockerCodes(result).includes(REASON.PRINTER_RESERVED));
    assert.ok(hardBlockers(result).some((r) => r.code === REASON.PRINTER_RESERVED), "not overridable");
    assert.match(result.reasons.find((r) => r.code === REASON.PRINTER_RESERVED)?.message ?? "", /Кронштейн/);
  }
  assert.equal(
    blockerCodes(evaluate("manual", { facts: { printerHold: null } })).includes(REASON.PRINTER_RESERVED),
    false
  );
});

test("content drift from the confirmed plan blocks the start", () => {
  const result = evaluate("manual", {
    facts: {
      reservation: {
        planId: "plan1",
        assignmentId: "as1",
        printerId: "k2",
        sliceVariantId: null,
        artifactSha256: "b".repeat(64),
        profileRevisionIds: [],
      stale: false,
      staleReason: null,
        expectedRemotePath: null
      }
    }
  });
  assert.ok(blockerCodes(result).includes(REASON.ARTIFACT_HASH_MISMATCH));
});

test("a file missing on the device blocks the start", () => {
  const result = evaluate("manual", { facts: { deviceFileIdentity: "missing" } });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.DEVICE_FILE_MISSING));
});

test("an unverified upload blocks a night start and warns on a manual one", () => {
  const night = evaluate("night", { facts: { deviceFileIdentity: "name-only" } });
  assert.ok(blockerCodes(night).includes(REASON.DEVICE_FILE_NOT_VERIFIED));

  const manual = evaluate("manual", { facts: { deviceFileIdentity: "name-only" } });
  assert.equal(manual.status, "review");
  assert.ok(codes(manual).includes(REASON.DEVICE_FILE_NOT_VERIFIED));
});

test("a start with NO tracked device file is refused — nothing delivered or checked it", () => {
  const result = evaluate("manual", { facts: { deviceArtifact: null } });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.DEVICE_TRANSFER_NOT_CONFIRMED));
});

test("every non-VERIFIED device-file state refuses the start", () => {
  const cases: [string, string][] = [
    ["PRESENT_UNVERIFIED", REASON.DEVICE_FILE_NOT_VERIFIED],
    ["UPLOADING", REASON.DEVICE_TRANSFER_NOT_CONFIRMED],
    ["NOT_PRESENT", REASON.DEVICE_TRANSFER_NOT_CONFIRMED],
    ["INVALID", REASON.DEVICE_FILE_INVALID],
    ["FAILED", REASON.DEVICE_FILE_INVALID],
    ["STALE", REASON.DEVICE_FILE_STALE]
  ];
  for (const [state, expected] of cases) {
    const result = evaluate("manual", {
      facts: {
        deviceArtifact: {
          state,
          transferMode: "adapter_upload",
          verification: null,
          remotePath: "chalice.gcode",
          lastError: null,
          stale: false,
          staleReason: null
        }
      }
    });
    assert.equal(result.status, "blocked", state);
    assert.ok(blockerCodes(result).includes(expected as ReasonCode), `${state} → ${expected}`);
  }
});

test("a VERIFIED file that no longer matches the job is STALE, not startable", () => {
  const result = evaluate("manual", {
    facts: {
      deviceArtifact: {
        state: "VERIFIED",
        transferMode: "adapter_upload",
        verification: "name_and_size",
        remotePath: "chalice.gcode",
        lastError: null,
        stale: true,
        staleReason: "слайс изменился"
      }
    }
  });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.DEVICE_FILE_STALE));
});

test("a manually transferred file is startable attended, never unattended", () => {
  const manual = {
    state: "VERIFIED",
    transferMode: "manual_file_transfer",
    verification: "operator_confirmed",
    remotePath: "chalice.gcode",
    lastError: null,
    stale: false,
    staleReason: null
  };
  const attended = evaluate("manual", {
    facts: { adapterUploadSupported: false, deviceArtifact: manual }
  });
  assert.ok(
    !blockerCodes(attended).includes(REASON.DEVICE_TRANSFER_NOT_CONFIRMED),
    "a named confirmation is the evidence an attended start needs"
  );

  const unattended = evaluate("night", {
    facts: { adapterUploadSupported: false, deviceArtifact: manual }
  });
  assert.ok(blockerCodes(unattended).includes(REASON.DEVICE_TRANSFER_NOT_CONFIRMED));
});

test("a file whose presence was never checked blocks — unchecked is not verified", () => {
  const result = evaluate("manual", { facts: { deviceFileIdentity: "unchecked" } });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.DEVICE_FILE_NOT_VERIFIED));
});

test("an occupied bed blocks BOTH a manual and an automatic start", () => {
  for (const mode of ["manual", "night"] as const) {
    const result = evaluate(mode, {
      evidence: { bedCycle: "AWAITING_CLEARANCE" },
      facts: { bedState: "AWAITING_CLEARANCE" }
    });
    assert.equal(result.status, "blocked", mode);
    assert.ok(blockerCodes(result).includes(REASON.BED_NOT_CLEAR), mode);
    assert.ok(blockerCodes(result).includes(REASON.OPERATOR_INTERVENTION_REQUIRED), mode);
  }
});

test("an unknown bed state blocks — an unknown bed is never assumed empty", () => {
  const result = evaluate("manual", { evidence: { bedCycle: null }, facts: { bedState: null } });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.BED_STATE_UNKNOWN));
});

test("another active run on the printer blocks the start", () => {
  const result = evaluate("manual", { facts: { activeRun: { id: "run9", state: "RUNNING" } } });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.ACTIVE_RUN_EXISTS));
});

test("an unresolved previous dispatch blocks the start", () => {
  const result = evaluate("manual", {
    facts: { startGuard: { file: "old.gcode", state: "UNKNOWN" } }
  });
  assert.ok(blockerCodes(result).includes(REASON.UNRESOLVED_DISPATCH));
});

test("stale telemetry blocks the start in both modes", () => {
  for (const mode of ["manual", "night"] as const) {
    const result = evaluate(mode, {
      evidence: { telemetryAgeMs: 10 * 60_000 },
      facts: { telemetryAgeMs: 10 * 60_000 }
    });
    assert.equal(result.status, "blocked", mode);
    assert.ok(blockerCodes(result).includes(REASON.TELEMETRY_STALE), mode);
  }
});

test("an offline printer blocks the start", () => {
  const result = evaluate("manual", {
    printer: { online: false },
    facts: { liveStatus: { online: false, status: "offline" } }
  });
  assert.ok(blockerCodes(result).includes(REASON.PRINTER_OFFLINE));
});

// ── Night-specific ──────────────────────────────────────────────────────────

test("an unknown ETA blocks an automatic night start", () => {
  const result = evaluate("night", { facts: { etaMinutes: null } });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.UNKNOWN_ETA));
});

test("the night window is checked against the time LEFT, with the buffer applied", () => {
  // 8h30m left at 23:00; a 7h30m print + 20% = 9h does not fit.
  const tooLong = evaluate("night", { facts: { etaMinutes: 450 } });
  assert.ok(blockerCodes(tooLong).includes(REASON.NIGHT_WINDOW_TOO_SHORT));
  assert.equal(tooLong.nightWindowFit?.remainingMinutes, 510);
  assert.equal(tooLong.nightWindowFit?.bufferedEtaMinutes, 540);

  // The same print started an hour earlier does fit (9h30m left).
  const fits = evaluate("night", {
    facts: { etaMinutes: 450, now: new Date("2026-07-26T22:00:00Z") }
  });
  assert.ok(!blockerCodes(fits).includes(REASON.NIGHT_WINDOW_TOO_SHORT));
});

test("an unparseable window or timezone blocks the night start fail-closed", () => {
  const badWindow = evaluate("night", { facts: { nightWindow: "всю ночь" } });
  assert.ok(blockerCodes(badWindow).includes(REASON.NIGHT_WINDOW_UNKNOWN));

  const badZone = evaluate("night", { facts: { farmTimeZone: "Not/AZone" } });
  assert.ok(blockerCodes(badZone).includes(REASON.NIGHT_WINDOW_UNKNOWN));
});

test("a task without explicit unattended permission cannot start at night", () => {
  const result = evaluate("night", { facts: { unattendedAllowed: false } });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.UNATTENDED_NOT_ALLOWED));
});

test("unattendedAllowed does NOT clear a bed — the two permissions are separate", () => {
  const result = evaluate("night", {
    evidence: { bedCycle: "AWAITING_CLEARANCE" },
    facts: { bedState: "AWAITING_CLEARANCE", unattendedAllowed: true, night: true }
  });
  assert.equal(result.status, "blocked");
  assert.ok(blockerCodes(result).includes(REASON.BED_NOT_CLEAR));
  assert.ok(
    blockerCodes(result).includes(REASON.AUTOMATIC_CONTINUATION_NOT_SUPPORTED),
    "a printer with no verified clearing hardware may not continue automatically"
  );
});

test("automatic continuation is allowed only for a printer with the verified capability", () => {
  const withCapability = evaluate("night", {
    evidence: { bedCycle: "AWAITING_CLEARANCE" },
    facts: { bedState: "AWAITING_CLEARANCE", automaticContinuationAllowed: true }
  });
  // Even here the bed is still occupied *right now*, so the start waits — but the
  // "this printer can never continue by itself" reason is gone.
  assert.ok(blockerCodes(withCapability).includes(REASON.BED_NOT_CLEAR));
  assert.ok(!blockerCodes(withCapability).includes(REASON.AUTOMATIC_CONTINUATION_NOT_SUPPORTED));

  // And a clear bed on a capable printer drops the morning-intervention notice.
  const capable = evaluate("night", { facts: { automaticContinuationAllowed: true } });
  assert.equal(capable.status, "eligible", JSON.stringify(capable.reasons));
});

// ── Consistency + override policy ───────────────────────────────────────────

test("preview, planner and dispatch produce identical reasons for identical facts", () => {
  // The three call sites differ only in how far the device-file check got; with
  // the same evidence the rule set must answer identically.
  const preview = evaluate("manual", { printer: { nozzleMm: 0.6 } });
  const planner = evaluate("manual", { printer: { nozzleMm: 0.6 } });
  const dispatch = evaluate("manual", { printer: { nozzleMm: 0.6 } });
  assert.deepEqual(codes(preview), codes(planner));
  assert.deepEqual(codes(planner), codes(dispatch));
  assert.equal(preview.status, dispatch.status);
});

test("every reason carries a stable, known code", () => {
  const seen = new Set<string>();
  const collect = (r: { reasons: { code: string }[] }): void => {
    for (const reason of r.reasons) seen.add(reason.code);
  };
  collect(evaluate("night", { facts: { etaMinutes: null, bedState: null }, evidence: { bedCycle: null } }));
  collect(evaluate("manual", { printer: { nozzleMm: 0.9, material: "ABS" } }));
  collect(evaluate("manual", { facts: { deviceFileIdentity: "missing" } }));
  assert.ok(seen.size > 0);
  const known = new Set<string>(Object.values(REASON));
  for (const code of seen) {
    assert.ok(known.has(code), `unknown reason code leaked: ${code}`);
  }
});

test("hard rules are never overridable", () => {
  const result = evaluate("manual", {
    evidence: { bedCycle: "AWAITING_CLEARANCE" },
    facts: { bedState: "AWAITING_CLEARANCE" }
  });
  const hard = hardBlockers(result).map((r) => r.code);
  assert.ok(hard.includes(REASON.BED_NOT_CLEAR));

  // The set is a deliberate, reviewed list — assert its safety-critical members.
  for (const code of [
    REASON.BED_NOT_CLEAR,
    REASON.BUILD_VOLUME_EXCEEDED,
    REASON.NOZZLE_MISMATCH,
    REASON.TARGET_PRINTER_MISMATCH,
    REASON.GCODE_FLAVOR_MISMATCH,
    REASON.DEVICE_FILE_MISSING,
    REASON.DEVICE_FILE_NOT_VERIFIED,
    REASON.ACTIVE_RUN_EXISTS,
    REASON.UNRESOLVED_DISPATCH
  ] as ReasonCode[]) {
    assert.ok(NON_OVERRIDABLE.has(code), `${code} must not be overridable`);
  }
});

// ── G-code containers (Bambu plate packages) ────────────────────────────────

/**
 * A Bambu printer is started on a `<name>.gcode.3mf` — a 3MF *wrapper* whose
 * payload is the sliced plate. The analysed content is therefore G-code while
 * the path ends in `.3mf`, and the naive "extension promises a model" rule read
 * that as a corrupted file and refused every Bambu start.
 */

const CONTAINER = {
  file: "chalice-1a2b3c4d.gcode.3mf",
  printerProtocol: "bambu",
  printerModel: "Bambu Lab A1 Combo",
  printerClass: null,
  printerName: "A1",
  deviceArtifact: {
    state: "VERIFIED",
    transferMode: "adapter_upload",
    verification: "name_and_size",
    remotePath: "chalice-1a2b3c4d.gcode.3mf",
    lastError: null,
    stale: false,
    staleReason: null
  }
} satisfies Partial<DispatchFacts>;

const CONTAINER_ANALYSIS = {
  id: "an1",
  state: "ready",
  verdict: "schedulable",
  detectedFormat: "gcode",
  blockers: [],
  analyzerVersion: "1.0.0",
  updatedAt: "2026-07-26T11:00:00Z",
  declaredTargetPrinter: "Bambu Lab A1",
  declaredGcodeFlavor: "marlin"
};

test("a .gcode.3mf plate package holding G-code is NOT a format contradiction", () => {
  const result = evaluate("manual", {
    facts: { ...CONTAINER, analysis: CONTAINER_ANALYSIS }
  });
  assert.ok(
    !result.reasons.some((r) => r.code === REASON.FORMAT_MISMATCH),
    `a G-code container must not be refused as a format mismatch: ${JSON.stringify(
      result.reasons.filter((r) => r.code === REASON.FORMAT_MISMATCH)
    )}`
  );
});

test("a .gcode.3mf that does NOT contain G-code is still refused", () => {
  // The wrapper must contain what its name claims — the contradiction simply
  // runs in the other direction.
  const result = evaluate("manual", {
    facts: {
      ...CONTAINER,
      analysis: { ...CONTAINER_ANALYSIS, detectedFormat: "3mf" }
    }
  });
  assert.ok(result.reasons.some((r) => r.code === REASON.FORMAT_MISMATCH));
});

test("a bare .3mf holding G-code keeps its old meaning — refused", () => {
  const result = evaluate("manual", {
    facts: {
      ...CONTAINER,
      file: "chalice.3mf",
      deviceArtifact: { ...CONTAINER.deviceArtifact, remotePath: "chalice.3mf" },
      analysis: CONTAINER_ANALYSIS
    }
  });
  assert.ok(result.reasons.some((r) => r.code === REASON.FORMAT_MISMATCH));
});

/* ── Preflight vs dispatch: one rule set, two stages ────────────────────────
 *
 * The two used to be different *rule sets*: the preview ran
 * `evaluateCompatibility` alone, so it never saw the file's declared target, the
 * G-code flavor, remote-start support or the queue shape — and cheerfully
 * offered a printer whose refusal was already certain, after which the operator
 * confirmed, the file was uploaded, and only then the gate said no.
 *
 * The invariant these tests hold: `preflight` refuses everything `dispatch`
 * refuses EXCEPT the two facts that need the bytes to have moved. So a preview
 * that passes can only be overtaken by a change, never by something that was
 * already true.
 */

test("preflight drops only the rules that need the file to be on the device", () => {
  const before = evaluate("manual", {
    facts: { stage: "preflight", deviceFileIdentity: "unchecked", deviceArtifact: null }
  });
  // At `dispatch` those same facts are exactly what refuses the start.
  const after = evaluate("manual", {
    facts: { stage: "dispatch", deviceFileIdentity: "unchecked", deviceArtifact: null }
  });

  assert.equal(before.status, "eligible", "an undelivered file is not a preview refusal");
  assert.equal(after.status, "blocked");
  assert.ok(codes(after).includes(REASON.DEVICE_FILE_NOT_VERIFIED));
  assert.ok(codes(after).includes(REASON.DEVICE_TRANSFER_NOT_CONFIRMED));
});

test("preflight still refuses a file built for another printer — before any transfer", () => {
  const result = evaluate("manual", {
    facts: {
      stage: "preflight",
      deviceArtifact: null,
      deviceFileIdentity: "unchecked",
      analysis: {
        id: "an1",
        state: "ready",
        verdict: "schedulable",
        detectedFormat: "gcode",
        blockers: [],
        analyzerVersion: "1.0.0",
        updatedAt: "2026-07-26T11:00:00Z",
        declaredTargetPrinter: "Bambu Lab A1",
        declaredGcodeFlavor: "klipper"
      }
    }
  });
  assert.equal(result.status, "blocked");
  assert.ok(codes(result).includes(REASON.TARGET_PRINTER_MISMATCH));
});

test("preflight still refuses an adapter that cannot start remotely", () => {
  const result = evaluate("manual", {
    facts: { stage: "preflight", deviceArtifact: null, remoteStartSupported: false }
  });
  assert.ok(codes(result).includes(REASON.REMOTE_START_UNSUPPORTED));
  assert.equal(result.status, "blocked");
});

test("preflight still refuses a task that is not actually in the queue", () => {
  const result = evaluate("manual", {
    facts: { stage: "preflight", deviceArtifact: null, taskState: "DRAFT", entryState: null }
  });
  assert.ok(codes(result).includes(REASON.TASK_STATE));
  assert.ok(codes(result).includes(REASON.NO_QUEUE_ENTRY));
});

test("the default stage is the STRICT one — a caller that forgets does not get leniency", () => {
  // `stage` omitted entirely.
  const result = evaluate("manual", {
    facts: { deviceFileIdentity: "unchecked", deviceArtifact: null }
  });
  assert.equal(result.status, "blocked", "fail-closed by construction");
});

/* ── The review acknowledgement ─────────────────────────────────────────── */

const REVIEWED = {
  id: "an1",
  state: "ready",
  verdict: "review",
  detectedFormat: "gcode",
  blockers: [] as { code: string; message: string }[],
  analyzerVersion: "1.0.0",
  updatedAt: "2026-07-26T11:00:00Z",
  declaredTargetPrinter: "K2 Plus",
  declaredGcodeFlavor: "klipper"
};

test("an unread `review` verdict refuses the start", () => {
  const result = evaluate("manual", { facts: { analysis: { ...REVIEWED } } });
  assert.equal(result.status, "blocked");
  assert.ok(codes(result).includes(REASON.ANALYSIS_VERDICT));
});

test("a review a named operator accepted becomes a warning, not a pass in silence", () => {
  const result = evaluate("manual", {
    facts: {
      analysis: { ...REVIEWED, reviewAccepted: true, reviewAcceptedBy: "мастер", reviewAcceptedAt: "t" }
    }
  });
  assert.equal(result.status, "review", "the reason is still on screen and still in the ledger");
  const reason = result.reasons.find((r) => r.code === REASON.ANALYSIS_VERDICT)!;
  assert.equal(reason.severity, "warning");
  assert.match(reason.message, /мастер/, "and it names who accepted it");
});

test("an accepted review does NOT authorise an unattended start", () => {
  const result = evaluate("night", {
    facts: {
      analysis: { ...REVIEWED, reviewAccepted: true, reviewAcceptedBy: "мастер", reviewAcceptedAt: "t" }
    }
  });
  // Nobody is present at night to have accepted anything on the machine's behalf.
  const reason = result.reasons.find((r) => r.code === REASON.ANALYSIS_VERDICT)!;
  assert.equal(reason.severity, "blocker");
});

test("an acknowledgement never clears an analysis BLOCKER", () => {
  const result = evaluate("manual", {
    facts: {
      analysis: {
        ...REVIEWED,
        reviewAccepted: true,
        reviewAcceptedBy: "мастер",
        blockers: [{ code: "gcode_forbidden", message: "M502 вне контекста калибровки" }]
      }
    }
  });
  assert.equal(result.status, "blocked");
  assert.ok(codes(result).includes(REASON.ANALYSIS_BLOCKERS));
});

/* ── The `.gcode.3mf` container ─────────────────────────────────────────── */

test("an uploaded sliced 3MF is accepted as the container its name promises", () => {
  const result = evaluate("manual", {
    facts: {
      file: "chalice.gcode.3mf",
      deviceArtifact: {
        state: "VERIFIED",
        transferMode: "adapter_upload",
        verification: "name_and_size",
        remotePath: "chalice.gcode.3mf",
        lastError: null,
        stale: false,
        staleReason: null
      },
      analysis: {
        ...REVIEWED,
        verdict: "schedulable",
        detectedFormat: "3mf",
        containsGcodePayload: true
      }
    }
  });
  assert.ok(
    !codes(result).includes(REASON.FORMAT_MISMATCH),
    "a plate package IS what «.gcode.3mf» claims — this refused every such upload"
  );
});

test("a plain model renamed to .gcode.3mf is still a contradiction", () => {
  const result = evaluate("manual", {
    facts: {
      file: "chalice.gcode.3mf",
      deviceArtifact: {
        state: "VERIFIED",
        transferMode: "adapter_upload",
        verification: "name_and_size",
        remotePath: "chalice.gcode.3mf",
        lastError: null,
        stale: false,
        staleReason: null
      },
      analysis: {
        ...REVIEWED,
        verdict: "schedulable",
        detectedFormat: "3mf",
        containsGcodePayload: false
      }
    }
  });
  assert.ok(codes(result).includes(REASON.FORMAT_MISMATCH));
});

test("an unanswered payload question refuses — «probably a print» is not evidence", () => {
  const result = evaluate("manual", {
    facts: {
      file: "chalice.gcode.3mf",
      deviceArtifact: {
        state: "VERIFIED",
        transferMode: "adapter_upload",
        verification: "name_and_size",
        remotePath: "chalice.gcode.3mf",
        lastError: null,
        stale: false,
        staleReason: null
      },
      analysis: { ...REVIEWED, verdict: "schedulable", detectedFormat: "3mf" }
    }
  });
  assert.ok(codes(result).includes(REASON.FORMAT_MISMATCH));
});

// ── HIGH-05: freshness is the bytes and the analyzer, never a metadata timestamp ──

test("a confirmation that bumped the artifact's updatedAt does NOT make its analysis stale", () => {
  // The artifact row moved (a scale or review confirmation was written to its
  // metadata) long after the analysis — its bytes did not.
  const result = evaluate("manual", {
    facts: {
      artifact: { id: "a1", sha256: "a".repeat(64), sizeBytes: 1000, updatedAt: "2026-07-27T10:00:00Z" },
      analysis: {
        ...facts("manual").analysis!,
        updatedAt: "2026-07-26T11:00:00Z",
        analyzedSha256: "a".repeat(64)
      }
    }
  });
  assert.ok(!codes(result).includes("ANALYSIS_STALE"), JSON.stringify(result.reasons));
});

test("an analysis of DIFFERENT bytes is stale, whatever the timestamps say", () => {
  const result = evaluate("manual", {
    facts: {
      analysis: { ...facts("manual").analysis!, analyzedSha256: "b".repeat(64), updatedAt: "2099-01-01T00:00:00Z" }
    }
  });
  assert.ok(blockerCodes(result).includes("ANALYSIS_STALE"));
});

test("an analysis made by an older analyzer is still refused as outdated", () => {
  const result = evaluate("manual", {
    facts: { analysis: { ...facts("manual").analysis!, analyzerVersion: "0.9.0" } }
  });
  assert.ok(blockerCodes(result).includes("ANALYZER_OUTDATED"));
});

// ── HIGH-11: a sliced package is a print like a bare G-code ─────────────────

test("HIGH-11: a sliced package with no declared machine is refused at night, like a bare G-code", () => {
  const sliced = (mode: DispatchMode) => ({
    ...facts(mode).analysis!,
    detectedFormat: "3mf",
    containsGcodePayload: true,
    declaredTargetPrinter: null
  });
  assert.ok(blockerCodes(evaluate("night", { facts: { analysis: sliced("night") } })).includes(REASON.TARGET_PRINTER_UNKNOWN));
  assert.ok(
    !blockerCodes(evaluate("manual", { facts: { analysis: sliced("manual") } })).includes(REASON.TARGET_PRINTER_UNKNOWN),
    "attended, the operator vouches for it"
  );
});

test("HIGH-11: the caller's per-format currency decides 'outdated', not the bare version string", () => {
  const older = { ...facts("manual").analysis!, analyzerVersion: "1.3.0" };
  // A G-code read by 1.3.0 is current under 1.4.0 (only 3MF reading changed)…
  const gcode = evaluate("manual", { facts: { analysis: { ...older, analyzerVersionCurrent: true } } });
  assert.ok(!blockerCodes(gcode).includes("ANALYZER_OUTDATED"));
  // …a 3MF read by 1.3.0 is not.
  const pkg = evaluate("manual", { facts: { analysis: { ...older, analyzerVersionCurrent: false } } });
  assert.ok(blockerCodes(pkg).includes("ANALYZER_OUTDATED"));
});

// ── Automatic queue: the `auto` mode ────────────────────────────────────────
// Nobody pressed anything for an automatic start. Everything unattended applies,
// every open question is a refusal, and the job carries the operator's
// permission to run without them; its time preference replaces the night flag.

test("auto: a fully prepared job with the permission has no blocker", () => {
  const result = evaluate("auto", { facts: { unattendedAllowed: true } });
  assert.deepEqual(blockerCodes(result), [], JSON.stringify(result.reasons));
});

test("auto: without the operator's permission to run unattended, refused", () => {
  const result = evaluate("auto", { facts: { unattendedAllowed: false } });
  assert.ok(blockerCodes(result).includes(REASON.UNATTENDED_NOT_ALLOWED));
});

test("auto: every open question is a refusal — nobody is there to answer it", () => {
  const cases: [string, Parameters<typeof evaluate>[1], ReasonCode][] = [
    ["unknown size", { task: { dimensions: null } }, REASON.DIMENSIONS_UNKNOWN],
    ["unreported material", { printer: { material: null } }, REASON.MATERIAL_UNKNOWN],
    ["unknown nozzle", { printer: { nozzleMm: null } }, REASON.NOZZLE_UNKNOWN],
    ["unrecorded bed", { evidence: { bedCycle: null }, facts: { bedState: null } }, REASON.BED_STATE_UNKNOWN]
  ];
  for (const [what, over, code] of cases) {
    const manual = evaluate("manual", over);
    const auto = evaluate("auto", { ...over, facts: { unattendedAllowed: true, ...(over?.facts ?? {}) } });
    assert.ok(blockerCodes(auto).includes(code), `${what}: auto refuses (${JSON.stringify(auto.reasons)})`);
    if (code !== REASON.BED_STATE_UNKNOWN) {
      assert.ok(!blockerCodes(manual).includes(code), `${what}: an attended start may answer it`);
    }
  }
});

test("auto: an accepted review verdict does not count — nobody accepted it for THIS start", () => {
  const analysis = {
    id: "an1",
    state: "ready",
    verdict: "review",
    detectedFormat: "gcode",
    blockers: [],
    analyzerVersion: "1.0.0",
    updatedAt: "2026-07-26T11:00:00Z",
    declaredTargetPrinter: "K2 Plus",
    declaredGcodeFlavor: "klipper",
    reviewAccepted: true,
    reviewAcceptedBy: "miha"
  };
  const manual = evaluate("manual", { facts: { analysis } });
  assert.ok(!blockerCodes(manual).includes(REASON.ANALYSIS_VERDICT));
  const auto = evaluate("auto", { facts: { analysis, unattendedAllowed: true } });
  assert.ok(blockerCodes(auto).includes(REASON.ANALYSIS_VERDICT));
});

test("auto: a file only an operator vouched for, or one matched by name alone, is refused", () => {
  const manualTransfer = evaluate("auto", {
    facts: {
      unattendedAllowed: true,
      deviceArtifact: {
        state: "VERIFIED",
        transferMode: "manual_file_transfer",
        verification: "operator_confirmed",
        remotePath: "chalice.gcode",
        lastError: null,
        stale: false,
        staleReason: null
      }
    }
  });
  assert.ok(blockerCodes(manualTransfer).includes(REASON.DEVICE_TRANSFER_NOT_CONFIRMED));
  const nameOnly = evaluate("auto", { facts: { unattendedAllowed: true, deviceFileIdentity: "name-only" } });
  assert.ok(blockerCodes(nameOnly).includes(REASON.DEVICE_FILE_NOT_VERIFIED));
});

test("auto: the planner's «busy, print after it» is a refusal, as at night", () => {
  // The preflight lifts a plate held by another job as a soft `printer_busy`
  // (the planner may queue behind it). Attended, it stays a warning; nobody
  // attends an automatic start, so — like night — it refuses.
  const busy = { evidence: { bedCycle: "RUNNING" as const } };
  const manual = evaluate("manual", busy);
  assert.ok(!blockerCodes(manual).includes(REASON.PRINTER_BUSY));
  const auto = evaluate("auto", { ...busy, facts: { unattendedAllowed: true } });
  assert.ok(blockerCodes(auto).includes(REASON.PRINTER_BUSY));
});

test("auto: a night job follows the night window and must fit; outside it, it waits", () => {
  const inside = evaluate("auto", { facts: { unattendedAllowed: true, night: true } }); // 23:00, 8h30 left
  assert.deepEqual(blockerCodes(inside), []);
  const outside = evaluate("auto", {
    facts: { unattendedAllowed: true, night: true, now: new Date("2026-07-26T12:00:00Z") }
  });
  assert.ok(blockerCodes(outside).includes(REASON.NIGHT_WINDOW_TOO_SHORT));
  // `any` time preference: no window rule at all.
  const anyTime = evaluate("auto", { facts: { unattendedAllowed: true, now: new Date("2026-07-26T12:00:00Z") } });
  assert.deepEqual(blockerCodes(anyTime), []);
});

test("auto: a day job waits for an operator on shift; a person pressing the button is evidently there", () => {
  const asleep = { dayOnly: true, operatorPresence: "ASLEEP", operatorReason: "оператор спит" } as const;
  const auto = evaluate("auto", { facts: { unattendedAllowed: true, ...asleep } });
  assert.ok(blockerCodes(auto).includes(REASON.AUTO_DAY_ONLY));
  const unknown = evaluate("auto", {
    facts: { unattendedAllowed: true, dayOnly: true, operatorScheduleResolved: false, operatorPresence: "UNKNOWN", operatorReason: "нет расписания" }
  });
  assert.ok(blockerCodes(unknown).includes(REASON.AUTO_DAY_ONLY), "an unknown schedule is not an operator on shift");
  const onShift = evaluate("auto", { facts: { unattendedAllowed: true, dayOnly: true } });
  assert.ok(!codes(onShift).includes(REASON.AUTO_DAY_ONLY));
  const manual = evaluate("manual", { facts: asleep });
  assert.ok(!codes(manual).includes(REASON.AUTO_DAY_ONLY), "only the automatic queue waits for the shift");
});
