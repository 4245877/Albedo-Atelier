# Profile-set candidates

A **profile set** is a vetted `(machine, process, filament)` triple bound to a
compatible printer (or printer class). Sets are created and **approved** through the
API / dashboard (`POST /api/print/slicing/profile-sets`, `…/approve`) and stored in
the `profile_sets` table — approval is refused while the combination has any
blocker.

Files here are *candidate templates* (documentation and convenience), keyed by the
OrcaSlicer profile **names** so they survive re-import. They are **not** auto-approved:
importing a candidate creates an unapproved set, runs compatibility validation, and
records the warnings/blockers for an operator to review.

## Format (`*.json`)

```json
{
  "name": "K2 · PETG · FAST",
  "printer": "creality-k2",              // farm printer id (config/printers.json) or …
  "printerClass": null,                   // … a class label; one of the two
  "machine": "Creality K2 PETG 0.4 FAST", // profile names (type is implied by the field)
  "process": "Creality K2 0.4 FAST",
  "filament": "PETG @K2 FAST"
}
```

See `example-k2-petg-fast.json`. It is intentionally *not* approvable as-is: the K2
machine profile has a `nozzle_diameter` (0.4) vs `printer_variant`/parent (0.2)
contradiction **and** its parents are missing, so validation reports blockers and
approval is withheld until those are resolved.
