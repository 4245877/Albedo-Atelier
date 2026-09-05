#!/usr/bin/env python3
"""
Pack an OrcaSlicer **user profile directory** into a stageable `.orca_printer`
bundle.

`stage-orca-presets.py` reads exported bundles (zip archives). An Orca Cloud
*sync* folder is not a bundle — it is the live `user/<uuid>/` tree
(`machine/`, `process/`, `filament/`, plus `.info` sidecars). This script is the
missing adapter: it selects named presets from such a tree and writes one
deterministic archive in the exact shape a real `.orca_printer` has, so the
existing pipeline (SHA-256 → catalog → inheritance-in-vendor → self-checks →
quarantine) applies unchanged. Nothing here validates or rewrites a preset —
profile bytes are copied verbatim.

Two shape details a sync folder differs in, both handled here:
  * printers live under `machine/`, while a bundle uses `printer/` — and the
    stager classifies by that folder name (a sparse user preset carries none of
    the `printer_model`/`printable_area` keys its payload sniffing looks for, so
    a `machine/` path would be misfiled as a process);
  * `.info` sidecars are Orca's cloud sync bookkeeping (`setting_id`,
    `updated_time`), not presets, and are left out.

The archive is byte-reproducible: entries sorted, a fixed timestamp, fixed
compression. Re-running with the same inputs yields the same SHA-256, so
re-staging is a no-op rather than a spurious new revision.

Selection is explicit (`--select`), never "everything in the folder": a sync
tree accumulates abandoned experiments and renamed copies, and importing them
wholesale is what multiplies same-named revisions.

Run:
  python3 scripts/bundle-orca-user-dir.py --src <user dir> --select <sel.json> --out <file.orca_printer>

The selection file:
  {"bundleName": "...", "orcaVersion": "02.03.02.74",
   "machine": [...], "process": [...], "filament": [...]}
Names are OrcaSlicer preset `name`s (the JSON's `name` field), not filenames.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile

# Orca bundle folder per profile kind; `machine` is called `printer` in a bundle.
BUNDLE_DIR = {"machine": "printer", "process": "process", "filament": "filament"}
# A fixed DOS timestamp (1980-01-01) so the archive does not change run to run.
FIXED_DATE = (1980, 1, 1, 0, 0, 0)


def load_presets(src: str, kind: str) -> dict[str, tuple[str, bytes]]:
    """Every preset of one kind in the user dir, keyed by its OrcaSlicer `name`."""
    out: dict[str, tuple[str, bytes]] = {}
    kind_dir = os.path.join(src, kind)
    if not os.path.isdir(kind_dir):
        return out
    for entry in sorted(os.listdir(kind_dir)):
        if not entry.endswith(".json"):
            continue
        abs_path = os.path.join(kind_dir, entry)
        if not os.path.isfile(abs_path):
            continue
        with open(abs_path, "rb") as fh:
            data = fh.read()
        try:
            obj = json.loads(data.decode("utf-8"))
        except Exception as exc:
            print(f"  !! {kind}/{entry} does not parse as JSON ({exc}); skipped", file=sys.stderr)
            continue
        if not isinstance(obj, dict):
            continue
        name = obj.get("name") or os.path.splitext(entry)[0]
        if isinstance(name, list):
            name = name[0] if name else os.path.splitext(entry)[0]
        # Keep the archive entry named after the preset, as OrcaSlicer writes it.
        out[name] = (f"{name}.json", data)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Pack an OrcaSlicer user profile dir into a .orca_printer bundle")
    parser.add_argument("--src", required=True, help="OrcaSlicer user profile directory (contains machine/ process/ filament/)")
    parser.add_argument("--select", required=True, help="JSON file listing the preset names to include")
    parser.add_argument("--out", required=True, help="output .orca_printer path")
    args = parser.parse_args()

    src = os.path.abspath(os.path.expanduser(args.src))
    if not os.path.isdir(src):
        print(f"source directory not found: {src}", file=sys.stderr)
        return 2
    with open(os.path.expanduser(args.select), encoding="utf-8") as fh:
        sel = json.load(fh)

    available = {kind: load_presets(src, kind) for kind in BUNDLE_DIR}

    chosen: list[tuple[str, bytes]] = []          # (archive path, bytes)
    structure: dict[str, list[str]] = {}
    missing: list[str] = []
    for kind, bundle_dir in BUNDLE_DIR.items():
        names = sel.get(kind) or []
        rels: list[str] = []
        for name in names:
            found = available[kind].get(name)
            if not found:
                missing.append(f"{kind}:{name}")
                continue
            filename, data = found
            rel = f"{bundle_dir}/{filename}"
            chosen.append((rel, data))
            rels.append(rel)
        structure[f"{'printer' if kind == 'machine' else kind}_config"] = sorted(rels)

    if missing:
        print("selected presets not found in the source directory:", file=sys.stderr)
        for m in missing:
            print(f"  - {m}", file=sys.stderr)
        return 2
    if not chosen:
        print("selection is empty", file=sys.stderr)
        return 2

    printer_names = sel.get("machine") or []
    manifest = {
        "bundle_id": sel.get("bundleName") or os.path.basename(src),
        "bundle_type": "printer config bundle",
        "filament_config": structure["filament_config"],
        "printer_config": structure["printer_config"],
        "printer_preset_name": printer_names[0] if printer_names else "",
        "process_config": structure["process_config"],
        "version": sel.get("orcaVersion") or "",
    }
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    entries = sorted(chosen + [("bundle_structure.json", manifest_bytes)])
    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, data in entries:
            info = zipfile.ZipInfo(rel, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)

    counts = {k: len(sel.get(k) or []) for k in BUNDLE_DIR}
    print(f"bundled {len(chosen)} presets → {args.out} "
          f"(machine={counts['machine']} process={counts['process']} filament={counts['filament']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
