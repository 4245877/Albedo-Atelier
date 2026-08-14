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
    requiredNozzleMm: 0.4,
    gcodeFlavor: "klipper",
    amsRequired: null,
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
    printerLabels: ["Creality K2", "K2 Plus"],
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

test("the printer's name, model and class all count as a legitimate declared target", () => {
  for (const declared of ["Creality K2", "K2 Plus", "k2plus", "K2-Plus"]) {
    const result = evaluate("manual", {
      facts: { analysis: { ...facts("manual").analysis!, declaredTargetPrinter: declared } }
    });
    assert.equal(result.status, "eligible", `${declared}: ${JSON.stringify(result.reasons)}`);
  }
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
  printerLabels: ["Bambu Lab A1", "Bambu Lab A1 Combo"],
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
