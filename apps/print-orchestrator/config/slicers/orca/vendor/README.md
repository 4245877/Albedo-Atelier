# Vendor (system) profiles — inheritance parents

OrcaSlicer user presets almost always `inherits` a **system** profile that ships
inside OrcaSlicer (`resources/profiles/<Vendor>/…`), not inside the exported
bundle. Those parents are not redistributed here. Drop the matching system profile
JSONs into this directory (any of `machine/`, `process/`, `filament/`
subdirectories, or flat) and re-import: the importer treats `vendor/` profiles as
available parents, so revisions that were quarantined for a *missing parent* resolve
and can become `active`.

Each vendor file must be a real OrcaSlicer profile JSON carrying `name` (and, ideally,
`type`). The importer keys parents by their `name`.

## Install (mandatory step for a working set)

Until these parents are present the shipped catalog imports **3 active / 22
quarantined** profiles — enough to see the pipeline, not enough to approve a full
machine + process + filament set. Completing this step is required before slicing
can produce a printable file.

A helper does the copy + verification for you (pure filesystem, no network):

```
# from apps/print-orchestrator/
# 1. see exactly which parents are missing (also a CI/release gate — exits non-zero):
node scripts/install-orca-vendor-profiles.mjs --check

# 2. install them from your OrcaSlicer install (use the SAME release the bundles
#    were pinned to — 02.03.00.62 / 2.3.0 — so resolved values match the CLI):
node scripts/install-orca-vendor-profiles.mjs --orca-resources ~/.config/OrcaSlicer/system

# 3. re-import and confirm missingParents is now empty:
#    POST /api/print/slicing/presets/import   then   GET /api/print/slicing/runtime
```

The script reads the catalog to learn which parent *names* are missing, finds the
matching profile JSONs under `--orca-resources`, and copies them here. It exits
non-zero while any parent is still unresolved, so it can gate a release.

## Parents the current catalog needs

These `inherits` targets are referenced by `catalog.v1.json` but are **not present**,
so every profile depending on them is currently quarantined:

| Missing parent | Vendor | Referenced by |
| --- | --- | --- |
| `Bambu Lab A1 0.4 nozzle` | BBL (Bambu) | machine `Bambu Lab A1 0.4 PETG` |
| `Creality K2 0.4 nozzle` | Creality | machines `Creality K2 PETG 0.4 FAST`, `… Balance` |
| `0.20mm Standard @BBL A1` | BBL | processes `PETG 0.4mm/0.6mm/0.8mm @BBL A1` |
| `0.20mm Strength @BBL A1` | BBL | processes `@BBL A1 0.4 PLA`, `@BBL A1 0.4 PLA тест` |
| `0.08mm SuperDetail @Creality K2 0.2 nozzle` | Creality | processes `Creality K2 0.4*` |
| `Bambu PLA Basic @BBL A1` | BBL | filaments `VVM PETG 0.4/0.6/0.8`, `Creality Hyper PLA … Copy` |
| `Creality Generic PLA @K2-all` | Creality | filaments `PETG @K2*` |

The list the importer sees at runtime is also available from
`GET /api/print/slicing/runtime` (the `missingParents` field) and on the dashboard.

> Note: the Bambu/Creality system profiles are pinned to a specific OrcaSlicer
> version (`02.03.00.62` for these bundles). Use the parents from the **same**
> OrcaSlicer release the slicing worker is pinned to, so resolved values match what
> the CLI would produce.
