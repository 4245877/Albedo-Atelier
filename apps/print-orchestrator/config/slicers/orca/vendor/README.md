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
#    SAME release the bundles were pinned to (02.03.00.62 / 2.3.x) so resolved
#    values match what the CLI produces:
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

The closure the shipped `catalog.v1.json` needs — 16 files across two vendors:

| Vendor | Kind | Profiles |
| --- | --- | --- |
| BBL | machine | `Bambu Lab A1 0.4 nozzle` → `fdm_bbl_3dp_001_common` → `fdm_machine_common` |
| BBL | process | `0.20mm Standard @BBL A1`, `0.20mm Strength @BBL A1` → `fdm_process_bbl_0.20` → `fdm_process_bbl_common` → `fdm_process_common` |
| BBL | filament | `Bambu PLA Basic @BBL A1` → `Bambu PLA Basic @base` → `fdm_filament_pla` → `fdm_filament_common` |
| Creality | filament | `Creality Generic PLA @K2-all` → `Creality Generic PLA` → `fdm_filament_pla` → `fdm_filament_common` |

## Deliberately still missing

Two parents do **not** exist in OrcaSlicer 2.3.x at all — that release ships
`Creality K2 Plus`, never a plain `Creality K2`:

| Missing parent | Referenced by |
| --- | --- |
| `Creality K2 0.2 nozzle` | machine `Creality K2 PETG 0.4 FAST` |
| `0.08mm SuperDetail @Creality K2 0.2 nozzle` | processes `Creality K2 0.4*`, `… - Copy` |

Those six K2 presets were exported from a different OrcaSlicer build and stay
quarantined **on purpose**: their parents are genuinely absent, so nothing can
know what they resolve to. That is a real unresolved dependency, not a packaging
gap — do not "fix" it by loosening validation. To use them, install the build that
provides those profiles and re-run the script against its `resources/profiles`.

> The system profiles are pinned to a specific OrcaSlicer version (`02.03.00.62`
> for these bundles). Always install parents from the **same** release the slicing
> worker is pinned to (`ORCA_SLICER_VERSION`).
