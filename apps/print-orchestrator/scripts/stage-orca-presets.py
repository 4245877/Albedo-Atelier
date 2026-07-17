#!/usr/bin/env python3
"""
Stage OrcaSlicer preset archives into the repo's vendored catalog.

This is a one-time / re-runnable **ops** tool (not shipped runtime code). It reads
the operator's exported OrcaSlicer bundles from a source directory (default
``~/Presets``) and lays them out under ``config/slicers/orca`` in the shape the
brief asks for:

    config/slicers/orca/
    ├── catalog.v1.json        # the index (sources + every profile, with SHA-256)
    ├── sources/               # the ORIGINAL archives, copied byte-for-byte
    ├── profiles/
    │   ├── machine/           # extracted printer profiles (raw bytes, unmodified)
    │   ├── process/
    │   └── filament/
    ├── profile-sets/          # curated, human-authored profile-set candidates
    └── vendor/                # OrcaSlicer *system* profiles (parents) go here

Guarantees:
  * source archives are copied verbatim (same bytes, same SHA-256);
  * extracted profile files are the raw bytes from inside the archive (unmodified),
    so their SHA-256 is stable and the runtime importer can verify immutability;
  * filenames are lowercase ASCII (names are transliterated/slugified; the real
    OrcaSlicer name is preserved in the catalog, never lost);
  * identical content shared by several bundles is stored once and its catalog
    entry lists every source it came from;
  * the originals under the source directory are never deleted or modified.

Run:  python3 scripts/stage-orca-presets.py [--src ~/Presets] [--out config/slicers/orca]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from datetime import datetime, timezone

# Minimal Cyrillic→Latin transliteration so a name like "@BBL A1 0.4 PLA тест"
# yields a readable ASCII slug ("bbl-a1-0-4-pla-test") instead of dropping the word.
CYR = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "",
    "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def translit(text: str) -> str:
    return "".join(CYR.get(ch, CYR.get(ch.lower(), ch)) if ch.lower() in CYR else ch for ch in text)


def slug(text: str) -> str:
    t = translit(text).lower()
    t = t.replace("@", " at ").replace("+", " plus ")
    t = re.sub(r"[^a-z0-9.]+", "-", t)
    t = re.sub(r"-{2,}", "-", t).strip("-.")
    return t or "unnamed"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def classify(rel_path: str, obj: dict) -> str:
    """machine | process | filament, from the archive folder first, else the keys."""
    lowered = rel_path.lower()
    if "/printer/" in lowered or lowered.startswith("printer/"):
        return "machine"
    if "/process/" in lowered or lowered.startswith("process/"):
        return "process"
    if "/filament/" in lowered or lowered.startswith("filament/"):
        return "filament"
    # Root-level entries (e.g. "Printer presets.zip"): infer from the payload.
    if "printer_model" in obj or "printable_area" in obj or "printer_technology" in obj:
        return "machine"
    if "filament_type" in obj or "filament_settings_id" in obj:
        return "filament"
    return "process"


def first(value):
    """OrcaSlicer stores many scalars as single-element arrays; unwrap for the index."""
    if isinstance(value, list):
        return value[0] if value else None
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage OrcaSlicer presets into config/slicers/orca")
    parser.add_argument("--src", default=os.path.expanduser("~/Presets"))
    parser.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "slicers", "orca"),
    )
    args = parser.parse_args()

    src_dir = os.path.abspath(os.path.expanduser(args.src))
    out_dir = os.path.abspath(os.path.expanduser(args.out))
    if not os.path.isdir(src_dir):
        print(f"source directory not found: {src_dir}", file=sys.stderr)
        return 2

    sources_dir = os.path.join(out_dir, "sources")
    for sub in ("sources", "profiles/machine", "profiles/process", "profiles/filament", "profile-sets", "vendor"):
        os.makedirs(os.path.join(out_dir, sub), exist_ok=True)

    archives = sorted(
        f for f in os.listdir(src_dir)
        if f.lower().endswith((".orca_printer", ".orca_filament", ".zip")) and os.path.isfile(os.path.join(src_dir, f))
    )
    if not archives:
        print(f"no OrcaSlicer archives found in {src_dir}", file=sys.stderr)
        return 2

    sources_index: list[dict] = []
    # keyed by (type, sha256) -> profile entry, so identical content dedupes.
    profiles: dict[tuple[str, str], dict] = {}
    used_filenames: set[str] = set()

    for archive in archives:
        abs_archive = os.path.join(src_dir, archive)
        with open(abs_archive, "rb") as fh:
            raw_archive = fh.read()
        source_id = slug(os.path.splitext(archive)[0])
        ext = os.path.splitext(archive)[1].lower()
        staged_name = f"{source_id}{ext}"
        # Copy the archive verbatim (byte-for-byte).
        shutil.copyfile(abs_archive, os.path.join(sources_dir, staged_name))

        bundle_version = None
        bundle_type = None
        with zipfile.ZipFile(abs_archive) as zf:
            entries = sorted(n for n in zf.namelist() if n.lower().endswith(".json"))
            for name in entries:
                data = zf.read(name)
                if os.path.basename(name) == "bundle_structure.json":
                    try:
                        meta = json.loads(data)
                        bundle_version = meta.get("version")
                        bundle_type = meta.get("bundle_type")
                    except Exception:
                        pass
                    continue
                try:
                    obj = json.loads(data)
                except Exception as exc:
                    print(f"  !! {archive}:{name} does not parse as JSON ({exc}); skipped", file=sys.stderr)
                    continue
                if not isinstance(obj, dict):
                    continue
                ptype = classify(name, obj)
                digest = sha256_bytes(data)
                key = (ptype, digest)
                if key in profiles:
                    if source_id not in profiles[key]["sources"]:
                        profiles[key]["sources"].append(source_id)
                    continue

                display_name = first(obj.get("name")) or os.path.splitext(os.path.basename(name))[0]
                base = slug(display_name)
                filename = f"{base}.json"
                rel = f"profiles/{ptype}/{filename}"
                if rel in used_filenames:
                    filename = f"{base}.{digest[:8]}.json"
                    rel = f"profiles/{ptype}/{filename}"
                used_filenames.add(rel)

                # Write the raw bytes exactly as they were inside the archive.
                with open(os.path.join(out_dir, rel), "wb") as out:
                    out.write(data)

                profiles[key] = {
                    "logicalId": f"{ptype}:{display_name}",
                    "type": ptype,
                    "name": display_name,
                    "file": rel,
                    "sha256": digest,
                    "sizeBytes": len(data),
                    "inherits": (first(obj.get("inherits")) or None) or None,
                    "from": first(obj.get("from")),
                    "sources": [source_id],
                }

        sources_index.append({
            "id": source_id,
            "file": f"sources/{staged_name}",
            "originalName": archive,
            "sha256": sha256_bytes(raw_archive),
            "sizeBytes": len(raw_archive),
            "bundleType": bundle_type,
            "orcaVersion": bundle_version,
        })

    profile_list = sorted(profiles.values(), key=lambda p: (p["type"], p["name"].lower(), p["sha256"]))
    catalog = {
        "catalogVersion": 1,
        "generator": "scripts/stage-orca-presets.py",
        "stagedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "slicer": "OrcaSlicer",
        "sources": sorted(sources_index, key=lambda s: s["id"]),
        "profiles": profile_list,
    }
    with open(os.path.join(out_dir, "catalog.v1.json"), "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, ensure_ascii=False, indent=2, sort_keys=False)
        fh.write("\n")

    counts = {"machine": 0, "process": 0, "filament": 0}
    for p in profile_list:
        counts[p["type"]] += 1
    print(f"staged {len(sources_index)} sources → {len(profile_list)} unique profiles "
          f"(machine={counts['machine']} process={counts['process']} filament={counts['filament']})")
    print(f"catalog: {os.path.join(out_dir, 'catalog.v1.json')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
