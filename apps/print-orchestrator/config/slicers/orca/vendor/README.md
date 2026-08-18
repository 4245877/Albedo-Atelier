# Vendor (system) profiles — inheritance parents

OrcaSlicer user presets almost always `inherits` a **system** profile that ships
inside OrcaSlicer (`resources/profiles/<Vendor>/…`), not inside the exported
bundle. Those parents are what this directory holds, so the shipped catalog can
resolve without an OrcaSlicer installation being present.

Two things about them decide whether a profile resolves *correctly*, and both are
enforced by the importer and by the install script:

1. **The chain is transitive.** `Bambu Lab A1 0.4 PETG` inherits
   `Bambu Lab A1 0.4 nozzle`, which inherits `fdm_bbl_3dp_001_common`, which
   inherits `fdm_machine_common`. Installing only the parent the catalog names
   leaves the preset quarantined on the *next* link.
2. **Names are vendor-scoped.** OrcaSlicer ships 46 files named
   `fdm_machine_common` (41 with distinct content), two `fdm_bbl_3dp_001_common`
   (BBL's and OrcaArena's), 27 `fdm_filament_common`… Resolving by bare name
   merges another brand's base settings into a Bambu profile — and the merged
   result is exactly what is fed to the slicer. So files live under
   `vendor/<Vendor>/<machine|process|filament>/<profile name>.json`, and a chain
   locks onto the vendor of the first system parent it enters and stays in it.

A flat `vendor/*.json` file (no vendor folder) still works: it is treated as an
**unscoped** operator override that fits any vendor. Prefer the vendor-scoped
layout — it is what the install script writes.

## Install

```
# from apps/print-orchestrator/

# 1. what is missing (also a CI/release gate — exits non-zero):
pnpm run slicing:vendor:check

# 2. install the whole transitive closure from an OrcaSlicer install. Use the
#    release each preset was exported against, so resolved values match what the
#    preset author saw (see "Why the Creality K2 parents come from v2.3.2" below —
#    the K2 chain is NOT in the 2.3.0 tree):
node scripts/install-orca-vendor-profiles.mjs \
  --orca-resources ~/opt/orca-2.3.0/squashfs-root/resources/profiles

# 3. re-import and confirm missingParents:
#    POST /api/print/slicing/presets/import   then   GET /api/print/slicing/runtime
```

`--check` alone verifies what the **lean image** ships (this directory only). Add
`--orca-resources <tree>` to also credit a mounted slicer runtime, which is what a
deployment setting `ORCA_SYSTEM_PROFILES_DIR` actually resolves against.

## Two sources, one order

At runtime the importer looks for a parent in

1. this directory (`vendor/`), then
2. `ORCA_SYSTEM_PROFILES_DIR` — by default the `resources/profiles` tree next to
   `ORCA_SLICER_CMD`, i.e. the mounted OrcaSlicer's own profiles.

The first hit for a given (vendor, name) wins, so an operator copy here
deliberately overrides the runtime's. A deployment that mounts an OrcaSlicer
runtime (`compose.orca.yml`) resolves even with this directory empty; the lean
image has no mount, which is why the closure below is installed and committed.

## What is installed here

The closure the shipped `catalog.v1.json` needs — 24 files across two vendors:

| Vendor | Kind | Profiles |
| --- | --- | --- |
| BBL | machine | `Bambu Lab A1 0.4 nozzle` → `fdm_bbl_3dp_001_common` → `fdm_machine_common` |
| BBL | process | `0.20mm Standard @BBL A1`, `0.20mm Strength @BBL A1` → `fdm_process_bbl_0.20` → `fdm_process_bbl_common` → `fdm_process_common` |
| BBL | filament | `Bambu PLA Basic @BBL A1` → `Bambu PLA Basic @base` → `fdm_filament_pla` → `fdm_filament_common` |
| Creality | machine | `Creality K2 0.2 nozzle`, `Creality K2 0.4 nozzle` → `fdm_creality_common` → `fdm_machine_common` |
| Creality | process | `0.08mm SuperDetail @Creality K2 0.2 nozzle` → `fdm_process_common_klipper` → `fdm_process_creality_common` → `fdm_process_common` |
| Creality | filament | `Creality Generic PLA @K2-all` → `Creality Generic PLA` → `fdm_filament_pla` → `fdm_filament_common` |

### Why the Creality K2 parents come from v2.3.2, not 2.3.0

The pinned runtime (2.3.0) ships **`Creality K2 Plus`** and no plain `Creality K2`
— which is why these three parents were unresolvable for a while and their nine
dependants sat quarantined. They are not absent from OrcaSlicer, only from *that*
release: upstream added the plain-K2 family in **v2.3.2**, exactly the release the
K2 bundles declare in their own `version` field (`2.3.2.74`). So the closure above
was installed from `v2.3.2`, i.e. from the release the presets were authored
against — which is what "the same release" means for a *preset's* parents.

Mixing is safe here because it was checked rather than assumed: the shared bases
(`fdm_machine_common`, `fdm_creality_common`, `fdm_process_common_klipper`) are
byte-identical between 2.3.0 and 2.3.2, and the two process bases differ in exactly
one key (`enable_prime_tower`, `0` → `1`). Nothing BBL-scoped is touched, so no
Bambu profile's resolved bytes move.

## Deliberately still missing

Nothing. Every parent the catalog and the stored revisions reference resolves —
`pnpm run slicing:vendor:check` exits 0 and `GET /api/print/slicing/runtime`
reports an empty `missingParents`.

One preset is nevertheless still quarantined, and no vendor file can change that:
machine `Creality K2 PETG 0.4 FAST` declares `nozzle_diameter: ["0.4"]` on
`printer_variant: "0.2"`. That contradiction is inside the operator's own export
(the printer reports a 0.4 mm nozzle), so it is fixed by re-exporting the preset
from OrcaSlicer with the printer bound to its 0.4-nozzle variant — never by
loosening validation.

> The system profiles are pinned to a specific OrcaSlicer version. Always install a
> parent from the release its dependent preset was exported against, and diff the
> shared bases against `ORCA_SLICER_VERSION`'s tree when the two differ.
