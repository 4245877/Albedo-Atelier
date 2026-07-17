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

## Import & quarantine policy

On import each profile becomes an immutable `ProfileRevision` with a status:

- `active` — inheritance resolves fully and there are no blocker-level problems.
- `quarantined` — a blocker was found: an **unresolved parent** (a `vendor/` system
  profile is missing), an inheritance **cycle**, a **wrong-type** parent, or a
  self-contradiction (e.g. `nozzle_diameter` disagreeing with `printer_variant`).
  A quarantined revision is **never** activated and cannot be used in a profile set.
- `invalid` — the file is not a usable profile (unparseable, not an object, no name,
  unknown type).

A profile that inherits an OrcaSlicer system profile (almost all of them) stays
quarantined until that parent is provided under `vendor/` — see `vendor/README.md`.
This is intentional: the orchestrator will not slice against an unresolved profile.
