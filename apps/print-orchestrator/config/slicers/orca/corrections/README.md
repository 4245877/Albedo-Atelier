# Operator corrections

Presets **authored here**, not exported from OrcaSlicer. Everything under
`../profiles/` is verbatim operator export; this directory is the one place a
deliberate, reviewed edit lives, so "the catalog is byte-faithful to its source"
stays true and the exceptions are enumerable.

A file belongs here only when the exported preset is genuinely defective *and*
the fix is choosing the right system parent — never to make a validator stop
complaining. Each entry below states what changed and why.

Corrections are staged through the same pipeline as any bundle
(`bundle-orca-user-dir.py` → `stage-orca-presets.py` → import), so they get the
same SHA-256, inheritance resolution and self-checks.

## `machine/Creality K2 PETG 0.4.json`

Derived from the operator's `Creality K2 PETG 0.4 FAST` (Orca Cloud sync folder
`574cb639-…`, preset `version` `2.3.2.74`). Three keys differ; the settings are
otherwise byte-for-byte the operator's.

| key | source | here | why |
| --- | --- | --- | --- |
| `inherits` | `Creality K2 0.2 nozzle` | `Creality K2 0.4 nozzle` | the fix |
| `name` | `Creality K2 PETG 0.4 FAST` | `Creality K2 PETG 0.4` | `FAST`/`FAST1` is an uninformative name, and the preset is not a speed variant — the two source presets (`… FAST`, `… Balance`) are byte-identical apart from their name |
| `printer_settings_id` | `Creality K2 PETG 0.4 FAST` | `Creality K2 PETG 0.4` | follows `name` |

**The defect.** The source preset declares `nozzle_diameter: ["0.4"]` while
inheriting `Creality K2 0.2 nozzle`, whose `printer_variant` is `"0.2"`. Orca
copies a preset without re-parenting it, so a preset made by duplicating the
0.2-nozzle printer and typing `0.4` into the nozzle field keeps the 0.2 lineage.
The merged result claims a 0.4 mm nozzle on a 0.2 mm printer variant — the
importer quarantines it as `nozzle_variant_mismatch`, correctly.

**Why 0.4 is the right side of the contradiction.** The machine reports its own
hardware: Moonraker on the K2 (`192.168.0.132:4408`,
`configfile.settings.extruder.nozzle_diameter`) returns `0.4`. So the nozzle
value is the truth and the inherited variant is the error.

**Why re-parenting and not an override.** Setting `printer_variant` to `"0.4"`
on top of the 0.2 parent would silence the check while leaving every other
0.2-derived value in place. The parent is not a label: `Creality K2 0.2 nozzle`
and `Creality K2 0.4 nozzle` differ in the extrusion geometry the slicer
actually uses. The same split runs through the process tree — the 0.2 process
parent carries `line_width` `0.22` / `initial_layer_line_width` `0.25`, the 0.4
one `0.42` / `0.5`. A 0.4 mm nozzle driven by 0.2 mm line widths under-extrudes.

Both parents ship in `../vendor/Creality/machine/`; see `../vendor/README.md`
for why the plain-K2 family comes from OrcaSlicer v2.3.2 rather than the pinned
2.3.0 runtime.

**Upstream fix.** Re-save this printer preset in OrcaSlicer with the printer
bound to its 0.4-nozzle variant and re-sync; then this correction can be dropped
and the export used directly.

## `machine/Bambu Lab A1 0.4 PETG.json`

Derived from the operator's preset of the same name in the same sync folder.
One key differs: `machine_start_gcode`.

**The defect.** The synced preset carries OrcaSlicer **2.3.2**'s 600-line A1 start
block, which addresses the AMS flush parameters as `flush_volumetric_speeds[…]`
and `flush_temperatures[…]`. Those placeholders do not exist in the pinned
**2.3.0** runtime — its own block uses `filament_max_volumetric_speed[…]` and
`nozzle_temperature_range_high[…]`. OrcaSlicer 2.3.0 therefore aborts before
slicing:

```
OrcaSlicer завершился с кодом 156: Failed to generate gcode for invalid custom G-code.
machine_start_gcode Parsing error at line 121: Not a variable name
    M620.1 E F{flush_volumetric_speeds[initial_no_support_extruder]/2.4053*60} …
```

This is the failure mode a Windows-authored preset hides: it slices there because
that OrcaSlicer is 2.3.2. Working upstream is not evidence of working here.

**What is actually the operator's.** Diffing the synced block against 2.3.2's own
default leaves exactly one line — a build-plate Z offset:

| | |
| --- | --- |
| 2.3.2 / 2.3.0 default | `G29.1 Z{-0.02} ; for Textured PEI Plate` |
| operator | `G29.1 Z0.09` |

Everything else in those 600 lines is vendor boilerplate that happened to be
recorded because the preset was saved on 2.3.2.

**The correction.** `machine_start_gcode` = the pinned 2.3.0 block with that one
substitution applied. The operator's calibration is preserved; the 2.3.2-only
placeholders are gone. Verified: no token in the resulting block is outside the
2.3.0 placeholder vocabulary, and the profile slices.

The preset's other overrides need no change — `change_filament_gcode` and
`time_lapse_gcode` are byte-identical to 2.3.0's defaults already.

**Upstream fix.** Pin the deployment to the OrcaSlicer release the presets are
authored on (`ORCA_SLICER_VERSION` / `ORCA_HOST_DIR`), or reset the start G-code
to default in OrcaSlicer and re-apply the Z offset. Until the runtime moves, a
2.3.2-authored start block cannot be used verbatim.
