import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkProfileSelf,
  validateProfileSet,
  type ProfileSetValidationInput
} from "./compatibility";
import type { FilamentFields, MachineFields, ProcessFields } from "./orcaProfile";

const codes = (fs: { code: string }[]): string[] => fs.map((f) => f.code);

function machineFields(over: Partial<MachineFields> = {}): MachineFields {
  return {
    nozzleDiameterMm: 0.4,
    printerVariant: "0.4",
    printerModel: "Bambu Lab A1",
    gcodeFlavor: "marlin",
    maxLayerHeightMm: 0.28,
    minLayerHeightMm: 0.08,
    bedWidthMm: 256,
    bedDepthMm: 256,
    bedHeightMm: 256,
    ...over
  };
}
function processFields(over: Partial<ProcessFields> = {}): ProcessFields {
  return { layerHeightMm: 0.2, initialLayerHeightMm: 0.2, compatiblePrinters: [], ...over };
}
function filamentFields(over: Partial<FilamentFields> = {}): FilamentFields {
  return {
    filamentType: "PETG",
    nozzleTempC: 245,
    nozzleTempInitialC: 245,
    bedTempC: 80,
    compatiblePrinters: [],
    ...over
  };
}

// ── Per-profile self checks ──────────────────────────────────────────────────

test("machine self: nozzle_diameter contradicting printer_variant is a blocker; the parent-name hint only warns", () => {
  // The real Creality K2 case: 0.4 nozzle declared, but variant/parent say 0.2.
  const result = checkProfileSelf({
    type: "machine",
    name: "Creality K2 PETG 0.4 FAST",
    inherits: "Creality K2 0.2 nozzle",
    raw: {},
    resolved: { nozzle_diameter: ["0.4"], printer_variant: "0.2", printable_area: ["0x0", "260x0", "260x260", "0x260"] }
  });
  // printer_variant is a real setting → reliable → still a blocker.
  assert.ok(codes(result.blockers).includes("nozzle_variant_mismatch"));
  // The parent NAME ("… 0.2 nozzle") is only an inference — a deliberate override
  // must not quarantine, so this is a warning, never a blocker.
  assert.ok(codes(result.warnings).includes("nozzle_parent_mismatch"));
  assert.ok(!codes(result.blockers).includes("nozzle_parent_mismatch"));
});

test("machine self: a parent-name nozzle hint alone (no printer_variant conflict) does NOT quarantine", () => {
  // nozzle_diameter 0.4 but parent name says "0.8 nozzle", and NO printer_variant to
  // corroborate. Name-based inference must not block — active with a warning only.
  const result = checkProfileSelf({
    type: "machine",
    name: "Creality K2 0.4",
    inherits: "Creality K2 0.8 nozzle",
    raw: {},
    resolved: { nozzle_diameter: ["0.4"], printable_area: ["0x0", "260x0", "260x260", "0x260"] }
  });
  assert.ok(codes(result.warnings).includes("nozzle_parent_mismatch"));
  assert.equal(result.blockers.length, 0, JSON.stringify(result.blockers));
});

test("process self: an absurd layer height is a blocker; a merely large one warns", () => {
  const invalid = checkProfileSelf({
    type: "process",
    name: "weird",
    inherits: null,
    raw: { layer_height: "1.5" },
    resolved: null
  });
  assert.ok(codes(invalid.blockers).includes("layer_height_invalid"));

  const large = checkProfileSelf({
    type: "process",
    name: "chunky",
    inherits: null,
    raw: { layer_height: "0.7" },
    resolved: null
  });
  assert.ok(codes(large.warnings).includes("layer_height_high"));
});

test("filament self: PETG far below its range is a blocker; slightly off is a warning", () => {
  const cold = checkProfileSelf({
    type: "filament",
    name: "petg-cold",
    inherits: null,
    raw: { filament_type: ["PETG"], nozzle_temperature: ["150"] },
    resolved: null
  });
  assert.ok(codes(cold.blockers).includes("temperature_out_of_range"));

  const lowish = checkProfileSelf({
    type: "filament",
    name: "petg-lowish",
    inherits: null,
    raw: { filament_type: ["PETG"], nozzle_temperature: ["212"] },
    resolved: null
  });
  assert.ok(codes(lowish.warnings).includes("temperature_unusual"));
  assert.equal(lowish.blockers.length, 0);
});

test("self: uninformative names (Copy / FAST1 / тест) warn but never block", () => {
  for (const name of ["0.08mm SuperDetail @Creality K2 0.2 nozzle - Copy", "Creality K2 0.4 FAST1", "@BBL A1 0.4 PLA тест"]) {
    const r = checkProfileSelf({ type: "process", name, inherits: null, raw: {}, resolved: null });
    assert.ok(codes(r.warnings).includes("uninformative_name"), name);
    assert.equal(r.blockers.length, 0, name);
  }
});

// ── Cross-profile set validation ─────────────────────────────────────────────

function activeSet(over: Partial<ProfileSetValidationInput> = {}): ProfileSetValidationInput {
  return {
    machine: { name: "Bambu Lab A1 0.4 PETG", status: "active", fields: machineFields() },
    process: { name: "PETG 0.4mm @BBL A1", status: "active", fields: processFields() },
    filament: { name: "VVM PETG 0.4@BBL A1", status: "active", fields: filamentFields() },
    ...over
  };
}

test("a fully compatible active set has no blockers", () => {
  const r = validateProfileSet(activeSet());
  assert.equal(r.blockers.length, 0, JSON.stringify(r.blockers));
});

test("layer height above the machine max AND above 75% of nozzle is a blocker", () => {
  // The real A1 "PETG 0.8mm" process: layer 0.32 / initial 0.36 on a 0.4 nozzle, max 0.28.
  const r = validateProfileSet(
    activeSet({
      process: {
        name: "PETG 0.8mm @BBL A1",
        status: "active",
        fields: processFields({ layerHeightMm: 0.32, initialLayerHeightMm: 0.36 })
      }
    })
  );
  assert.ok(codes(r.blockers).includes("layer_exceeds_max"));
  assert.ok(codes(r.blockers).includes("layer_too_thick"));
});

test("a process/filament name implying a bigger nozzle than the machine warns", () => {
  const r = validateProfileSet(
    activeSet({
      process: { name: "PETG 0.6mm @BBL A1", status: "active", fields: processFields({ layerHeightMm: 0.24 }) }
    })
  );
  assert.ok(codes(r.warnings).includes("process_nozzle_intent"));
  assert.equal(r.blockers.length, 0);
});

test("a quarantined member blocks the whole set", () => {
  const r = validateProfileSet(
    activeSet({
      machine: { name: "Creality K2 PETG 0.4 FAST", status: "quarantined", fields: machineFields() }
    })
  );
  assert.ok(codes(r.blockers).includes("member_not_active"));
});

test("filament material not in the printer's material list warns", () => {
  const r = validateProfileSet(
    activeSet({ target: { printerMaterial: "PLA", printerProtocol: "bambu", printerModel: "Bambu Lab A1" } })
  );
  assert.ok(codes(r.warnings).includes("material_not_supported"));
});

test("a supported material + matching firmware produces no material/gcode complaints", () => {
  const r = validateProfileSet(
    activeSet({ target: { printerMaterial: "PLA / PETG / TPU", printerProtocol: "bambu", printerModel: "Bambu Lab A1" } })
  );
  assert.ok(!codes(r.warnings).includes("material_not_supported"));
  assert.ok(!codes(r.warnings).includes("gcode_flavor_mismatch"));
});

test("the machine profile's nozzle contradicting the target printer's nozzle is a blocker", () => {
  const r = validateProfileSet(
    activeSet({ target: { printerModel: "Bambu Lab A1", printerNozzleMm: 0.6 } })
  );
  assert.ok(codes(r.blockers).includes("printer_nozzle_mismatch"));
});

test("a matching target nozzle does not block", () => {
  const r = validateProfileSet(activeSet({ target: { printerModel: "Bambu Lab A1", printerNozzleMm: 0.4 } }));
  assert.ok(!codes(r.blockers).includes("printer_nozzle_mismatch"));
});

test("the machine profile describing a different model than the target printer is a blocker", () => {
  const r = validateProfileSet(activeSet({ target: { printerModel: "Creality K2" } }));
  assert.ok(codes(r.blockers).includes("printer_model_mismatch"));
});

test("a loosely-matching model (normalised) does not block", () => {
  // machine model "Bambu Lab A1" vs a differently-spaced/cased target.
  const r = validateProfileSet(activeSet({ target: { printerModel: "bambu-lab a1" } }));
  assert.ok(!codes(r.blockers).includes("printer_model_mismatch"));
});

test("PET and PETG are NOT treated as the same material (no two-sided prefix match)", () => {
  // A printer loaded with PET must not silently 'support' a PETG filament (and the
  // reverse), which the old two-sided startsWith allowed.
  const petgOnPet = validateProfileSet(
    activeSet({
      filament: { name: "PETG", status: "active", fields: filamentFields({ filamentType: "PETG" }) },
      target: { printerMaterial: "PET", printerModel: "Bambu Lab A1" }
    })
  );
  assert.ok(codes(petgOnPet.warnings).includes("material_not_supported"));

  const petOnPetg = validateProfileSet(
    activeSet({
      filament: { name: "PET", status: "active", fields: filamentFields({ filamentType: "PET" }) },
      target: { printerMaterial: "PETG", printerModel: "Bambu Lab A1" }
    })
  );
  assert.ok(codes(petOnPetg.warnings).includes("material_not_supported"));

  // Exact family still matches (PETG-CF reduces to PETG).
  const petgCfOnPetg = validateProfileSet(
    activeSet({
      filament: { name: "PETG-CF", status: "active", fields: filamentFields({ filamentType: "PETG-CF" }) },
      target: { printerMaterial: "PETG", printerModel: "Bambu Lab A1" }
    })
  );
  assert.ok(!codes(petgCfOnPetg.warnings).includes("material_not_supported"));
});

// ── Class targets (interchangeable printers) ─────────────────────────────────

test("class target: an unknown/empty class is a blocker", () => {
  const r = validateProfileSet(activeSet({ classTargets: { className: "ghost", printers: [] } }));
  assert.ok(codes(r.blockers).includes("printer_class_unknown"));
});

test("class target: a homogeneous compatible class has no blockers", () => {
  const r = validateProfileSet(
    activeSet({
      classTargets: {
        className: "a1",
        printers: [
          { printerModel: "Bambu Lab A1", printerNozzleMm: 0.4 },
          { printerModel: "Bambu Lab A1", printerNozzleMm: 0.4 }
        ]
      }
    })
  );
  assert.equal(r.blockers.length, 0, JSON.stringify(r.blockers));
  assert.ok(!codes(r.warnings).includes("printer_class_partial"));
});

test("class target: a heterogeneous class (only some fit) warns but does not block", () => {
  const r = validateProfileSet(
    activeSet({
      classTargets: {
        className: "mixed",
        printers: [
          { printerModel: "Bambu Lab A1", printerNozzleMm: 0.4 }, // compatible
          { printerModel: "Bambu Lab A1", printerNozzleMm: 0.6 } // nozzle mismatch → not compatible
        ]
      }
    })
  );
  assert.equal(r.blockers.length, 0, JSON.stringify(r.blockers));
  assert.ok(codes(r.warnings).includes("printer_class_partial"));
});

test("class target: a class where NO member fits is a blocker", () => {
  const r = validateProfileSet(
    activeSet({
      classTargets: {
        className: "wrong",
        printers: [
          { printerModel: "Bambu Lab A1", printerNozzleMm: 0.6 },
          { printerModel: "Bambu Lab A1", printerNozzleMm: 0.8 }
        ]
      }
    })
  );
  assert.ok(codes(r.blockers).includes("printer_class_incompatible"));
  // The concrete reason (nozzle mismatch) is surfaced too.
  assert.ok(codes(r.blockers).includes("printer_nozzle_mismatch"));
});
