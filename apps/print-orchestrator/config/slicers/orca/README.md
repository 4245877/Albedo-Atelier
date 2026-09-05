# OrcaSlicer preset catalog (`config/slicers/orca`)

The vendored, content-addressed catalog of OrcaSlicer presets the orchestrator
imports into the `profile_revisions` table (migration `003_slicing`). It is the
**single source of truth** for machine / process / filament profiles; the runtime
never reads the operator's `~/Presets` directly.

## Layout

```
config/slicers/orca/
├── catalog.v1.json     index of every source archive and every profile (with SHA-256)
├── sources/            the ORIGINAL OrcaSlicer archives, copied byte-for-byte
├── profiles/
│   ├── machine/        printer profiles (raw bytes as extracted, unmodified)
│   ├── process/        print/quality profiles
│   └── filament/       filament profiles
├── profile-sets/       human-authored profile-set candidates (see its README)
├── corrections/        operator-authored fixes to defective exports (see its README)
└── vendor/             OrcaSlicer *system* profiles — the inheritance parents (see its README)
```

## Guarantees

- **Sources are verbatim.** Files in `sources/` are byte-for-byte copies of the
  operator's archives; their SHA-256 matches the originals and is recorded in
  `catalog.v1.json`. The originals under `~/Presets` are never modified or deleted.
- **Profiles are immutable.** Each file under `profiles/` is the raw JSON as it was
  inside its archive. `catalog.v1.json` records the SHA-256 of every file; the
  importer (`PresetImportService`) recomputes and **verifies** it on import, so any
  drift is caught rather than silently imported.
- **Filenames are lowercase ASCII.** Names are transliterated/slugified for the
  filesystem; the real OrcaSlicer `name` is preserved in the catalog and is what the
  logical profile id is built from — nothing is lost.
- **Identical content is stored once.** A profile shared by several bundles (e.g.
  `Creality`, `ENYONE PLA`) is one file whose catalog entry lists every `source` it
  came from.

## Re-staging

The catalog is produced by a deterministic, re-runnable ops script:

```
python3 scripts/stage-orca-presets.py --src ~/Presets --out config/slicers/orca
```

Re-running with the same inputs yields the same bytes. Add new bundles by dropping
them in the source directory and re-running, then re-import from the dashboard /
`POST /api/print/slicing/presets/import`.

### Staging from an Orca Cloud sync folder

The stager reads **bundles** (zip archives). An Orca Cloud sync folder is not one —
it is the live `user/<uuid>/` tree (`machine/`, `process/`, `filament/`, plus
`.info` sync sidecars). `scripts/bundle-orca-user-dir.py` is the adapter: it packs
a named selection of those presets into one deterministic `.orca_printer`, which
then stages like any other bundle. It rewrites nothing — profile bytes are copied
verbatim; it only maps `machine/` to the `printer/` folder a bundle uses (the
stager classifies by that folder, and a *sparse* user preset carries none of the
`printer_model` / `printable_area` keys its payload sniffing falls back to) and
drops the `.info` sidecars.

```
# 1. what to take — preset names, not filenames (see user-dir-selection.json)
# 2. pack, stage, import:
python3 scripts/bundle-orca-user-dir.py \
  --src ~/apps/<uuid> --select config/slicers/orca/user-dir-selection.json \
  --out /tmp/staging/orca-user-<uuid>.orca_printer
python3 scripts/bundle-orca-user-dir.py \
  --src config/slicers/orca/corrections --select config/slicers/orca/corrections/selection.json \
  --out /tmp/staging/operator-corrections.orca_printer
python3 scripts/stage-orca-presets.py --src /tmp/staging --out config/slicers/orca
```

The selection is explicit on purpose. A sync folder accumulates abandoned
experiments, renamed copies and presets for nozzles the farm does not have;
importing it wholesale is what multiplies same-named revisions and defective
chains. Pick the presets that belong to a real printer in `config/printers.json`
and leave the rest out — they stay in the sync folder, losing nothing.

A preset that is genuinely defective and fixable only by re-parenting goes through
`corrections/`, never by editing a file under `profiles/`.

## Import & quarantine policy

On import each profile becomes an immutable `ProfileRevision` with a status:

- `active` — inheritance resolves fully and there are no blocker-level problems.
- `quarantined` — a blocker was found: an **unresolved parent** (no system profile
  with that name in `vendor/` or the pinned slicer's tree), an **ambiguous parent**
  (several OrcaSlicer vendors ship that exact name and nothing says which is meant),
  an inheritance **cycle**, a **wrong-type** parent, or a self-contradiction (e.g.
  `nozzle_diameter` disagreeing with `printer_variant`). A quarantined revision is
  **never** activated and cannot be used in a profile set.
- `invalid` — the file is not a usable profile (unparseable, not an object, no name,
  unknown type).

Almost every user preset inherits an OrcaSlicer **system** profile, and the whole
chain must resolve — transitively and **within one vendor** (see
`vendor/README.md`). The resolved settings are literally what is handed to the
slicer, so a parent resolved from the wrong vendor would be a wrong-G-code bug;
resolution therefore locks onto the vendor of the first system parent it enters.
Each revision records what it resolved through in its `metadata`
(`inheritanceChain`, `inheritanceLevels`, `vendor`).

A preset whose parent genuinely does not exist in the pinned OrcaSlicer release
stays quarantined — that is a real unresolved dependency, and the orchestrator will
not slice against an unresolved profile.
