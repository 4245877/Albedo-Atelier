import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";

import {
  boxVertices,
  make3mfModel,
  make3mfPackage,
  makeJpeg,
  makeModelSettingsConfig,
  makePng,
  makeSliceInfoConfig,
  tempDir,
  writeFixture,
  type PlateFixture,
  type ZipInput
} from "../testkit/fixtures";
import { analyze3mf } from "./threemf";
import type { PlateRecord } from "./threemfPlates";
import { sniffImage } from "./threemfPlateAssets";
import type { AnalyzerLimits, AnalyzerResult } from "./types";

/*
 * The plate model: what an operator has to be shown before they can pick one of
 * a project's build plates, and what the slicer is then told to slice.
 *
 * Everything here goes through the real analyzer over real ZIP bytes, so the
 * ZIP/XML guards, the geometry pass and the plate pass are exercised together —
 * a plate list that only holds up against a hand-built object graph would prove
 * nothing about the file an operator actually uploads.
 *
 * The fixtures are synthetic. They are modelled on Bambu Studio / OrcaSlicer
 * exports (see `makeModelSettingsConfig`), but no genuine export from either
 * tool exists in this repository, so the *shapes* below are assumptions and the
 * parser is written to tolerate every one of them being spelled differently.
 */

const LIMITS: AnalyzerLimits = {
  zipMaxEntries: 1000,
  zipMaxEntryBytes: 64 * 1024 * 1024,
  zipMaxTotalBytes: 128 * 1024 * 1024,
  zipMaxRatio: 200,
  xmlMaxBytes: 16 * 1024 * 1024
};

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(name: string, data: Buffer): Promise<AnalyzerResult> {
  const { path, size } = writeFixture(dir, name, data);
  const handle = await fsp.open(path, "r");
  try {
    return await analyze3mf(handle, size, LIMITS);
  } finally {
    await handle.close();
  }
}

function platesOf(result: AnalyzerResult): PlateRecord[] {
  return result.data.plates as PlateRecord[];
}

/** A project whose objects sit far apart, so each plate's own box is distinct. */
function project(
  plates: PlateFixture[],
  options: { extra?: ZipInput[]; objectNames?: Record<string, string>; objects?: number } = {}
): Buffer {
  const count = options.objects ?? 3;
  const xml = make3mfModel({
    unit: "millimeter",
    application: "OrcaSlicer-2.3.0",
    objects: Array.from({ length: count }, (_, i) => ({
      id: String(i + 1),
      vertices: boxVertices(10 * (i + 1), 10 * (i + 1), 10 * (i + 1), [500 * i, 0, 0])
    })),
    items: Array.from({ length: count }, (_, i) => ({ objectid: String(i + 1) }))
  });
  return make3mfPackage(xml, [
    {
      name: "Metadata/model_settings.config",
      data: makeModelSettingsConfig(plates, { objectNames: options.objectNames })
    },
    { name: "Metadata/project_settings.config", data: '{"layer_height":"0.2"}' },
    ...(options.extra ?? [])
  ]);
}

// ── Counting and identity ────────────────────────────────────────────────────

test("a single-plate model publishes one plate, and it holds the whole scene", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(20) }],
    items: [{ objectid: "1" }]
  });
  const plates = platesOf(await run("one.3mf", make3mfPackage(xml)));
  assert.equal(plates.length, 1);
  assert.equal(plates[0].index, 1);
  assert.equal(plates[0].source, "implicit");
  // The implicit plate is NOT an empty plate: everything the build places is on it.
  assert.equal(plates[0].objects.length, 1);
  assert.deepEqual(plates[0].geometry.sizeMm, [20, 20, 20]);
});

test("two declared plates are described separately, each with its own box", async () => {
  const r = await run(
    "two.3mf",
    project([
      { index: 1, name: "Корпус", objectIds: ["1"] },
      { index: 2, objectIds: ["2"] }
    ])
  );
  const plates = platesOf(r);
  assert.equal(plates.length, 2);
  assert.deepEqual(
    plates.map((p) => p.index),
    [1, 2]
  );
  assert.equal(plates[0].name, "Корпус");
  assert.equal(plates[1].name, null, "an unnamed plate says so rather than inventing a label");
  assert.deepEqual(plates[0].geometry.sizeMm, [10, 10, 10]);
  assert.deepEqual(plates[1].geometry.sizeMm, [20, 20, 20]);
  // The merged box is still withheld — a union of two plates is one print's size.
  assert.equal((r.data.geometry as { sizeMm: unknown }).sizeMm, null);
});

test("three plates are all described, in index order", async () => {
  const plates = platesOf(
    await run(
      "three.3mf",
      project([
        { index: 2, objectIds: ["2"] },
        { index: 3, objectIds: ["3"] },
        { index: 1, objectIds: ["1"] }
      ])
    )
  );
  assert.deepEqual(
    plates.map((p) => p.index),
    [1, 2, 3],
    "listed by plate number, not by position in the config"
  );
});

test("plate numbers are the file's own — plate 4 alone stays plate 4", async () => {
  // Nothing may assume a plate 1 exists: a project can be left with one plate
  // after the others were deleted, and renumbering it would name a plate the
  // slicer does not have.
  const plates = platesOf(await run("four.3mf", project([{ index: 4, objectIds: ["1"] }])));
  assert.equal(plates.length, 1);
  assert.equal(plates[0].index, 4);
  assert.equal(plates[0].sliceIndex, 1, "--slice takes the plate's position, and there is one plate");
});

test("a plate with no plater_id falls back to its position in the config", async () => {
  const plates = platesOf(
    await run("noid.3mf", project([{ objectIds: ["1"] }, { objectIds: ["2"] }]))
  );
  assert.deepEqual(
    plates.map((p) => p.index),
    [1, 2]
  );
  assert.deepEqual(
    plates.map((p) => p.sliceIndex),
    [1, 2]
  );
});

test("a zero-based plater_id is honoured, not silently rewritten to 1", async () => {
  // Rewriting `0` to `1` used to collapse plates 0 and 1 onto one number, which
  // makes two different prints indistinguishable.
  const plates = platesOf(
    await run("zero.3mf", project([{ index: 0, objectIds: ["1"] }, { index: 1, objectIds: ["2"] }]))
  );
  assert.deepEqual(
    plates.map((p) => p.index),
    [0, 1]
  );
  assert.deepEqual(
    plates.map((p) => p.sliceIndex),
    [1, 2],
    "the CLI counts plates from 1 by position, whatever the file numbers them"
  );
});

test("a plate known only from plate_N entries is reported, with its contents unknown", async () => {
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }],
    items: [{ objectid: "1" }]
  });
  const r = await run(
    "entries.3mf",
    make3mfPackage(xml, [
      { name: "Metadata/plate_1.png", data: makePng() },
      { name: "Metadata/plate_2.png", data: makePng() }
    ])
  );
  const plates = platesOf(r);
  assert.equal((r.data.geometry as { plateCount: number }).plateCount, 2);
  assert.deepEqual(
    plates.map((p) => p.source),
    ["entries", "entries"]
  );
  assert.deepEqual(plates.map((p) => p.objects.length), [0, 0]);
});

// ── Which signal is believed ─────────────────────────────────────────────────
//
// Three things say "there is a plate here" and they are not equally credible.
// Unioning them all — every `plate_N` number found anywhere — let a *picture*
// invent a plate, and an invented plate is worse than a missed one: it can be
// chosen, it has no contents to check, and the `--slice` number taken from it
// addresses a plate the slicer does not have. @see resolvePlates

test("a thumbnail the config does not account for is not a plate", async () => {
  // A leftover from an earlier save, or an operator's attachment. The config
  // enumerated its plates; a stray picture does not add one to that list.
  const r = await run(
    "stray-thumb.3mf",
    project([{ index: 1, objectIds: ["1"] }], { extra: [{ name: "Metadata/plate_2.png", data: makePng() }] })
  );
  assert.equal((r.data.geometry as { plateCount: number }).plateCount, 1);
  assert.deepEqual(platesOf(r).map((p) => p.index), [1]);
  // Not believed, but not swallowed either: the file is inconsistent and a human
  // is told so.
  assert.ok(
    r.warnings.some((w) => w.code === "threemf_plate_entries_undeclared"),
    "the disagreement between config and archive is reported"
  );
});

test("a G-code payload the config does not account for IS a plate", async () => {
  // The one entry strong enough to outvote the config: a sliced package carries
  // one G-code per plate, and missing one would let a two-plate payload through
  // `evaluateExecutableArtifact` as a single print.
  const r = await run(
    "stray-gcode.3mf",
    project([{ index: 1, objectIds: ["1"] }], {
      extra: [{ name: "Metadata/plate_2.gcode", data: "G1 X1 Y1\n" }]
    })
  );
  assert.equal((r.data.geometry as { plateCount: number }).plateCount, 2);
  assert.deepEqual(platesOf(r).map((p) => p.index), [1, 2]);
});

test("a file an operator attached to the project never becomes a plate", async () => {
  // Bambu Studio stores arbitrary attachments under `Auxiliaries/`. A file the
  // operator happened to call `plate_7.png` used to add a seventh plate to a
  // two-plate project — selectable, empty, and `--slice 7` into a project that
  // has two plates.
  const r = await run(
    "aux.3mf",
    project([{ index: 1, objectIds: ["1"] }, { index: 2, objectIds: ["2"] }], {
      extra: [{ name: "Auxiliaries/Others/plate_7.png", data: makePng() }]
    })
  );
  assert.equal((r.data.geometry as { plateCount: number }).plateCount, 2);
  assert.deepEqual(platesOf(r).map((p) => p.index), [1, 2]);
  assert.deepEqual(platesOf(r).map((p) => p.sliceIndex), [1, 2]);
});

test("preview variants of one plate are one plate, not three", async () => {
  const r = await run(
    "variants.3mf",
    project([{ index: 1, objectIds: ["1"] }], {
      extra: [
        { name: "Metadata/plate_1.png", data: makePng() },
        { name: "Metadata/plate_1_small.png", data: makePng() },
        { name: "Metadata/plate_no_light_1.png", data: makePng() },
        { name: "Metadata/top_1.png", data: makePng() },
        { name: "Metadata/pick_1.png", data: makePng() }
      ]
    })
  );
  assert.equal((r.data.geometry as { plateCount: number }).plateCount, 1);
});

test("two plates never claim the same --slice position", async () => {
  // A config that declares a SUBSET of the plates the archive names put a
  // declared plate (ordinal 1) and an undeclared one (first in the list) on the
  // same `--slice 1`: choosing one printed the other.
  const r = await run(
    "subset.3mf",
    project([{ index: 2, objectIds: ["2"] }], {
      extra: [
        { name: "Metadata/plate_1.gcode", data: "G1 X1\n" },
        { name: "Metadata/plate_2.gcode", data: "G1 X2\n" }
      ]
    })
  );
  const positions = platesOf(r).map((p) => p.sliceIndex);
  assert.equal(new Set(positions).size, positions.length, "positions are unique");
  assert.ok(
    positions.every((n) => n >= 1 && n <= platesOf(r).length),
    "every position is one the CLI can address"
  );
});

test("a zero-based config plus 1-based thumbnails is still two plates", async () => {
  // The numbering the config uses and the numbering the file names use are
  // different namespaces. Merging them reported three plates for a two-plate
  // project, two of which claimed `--slice 2`.
  const r = await run(
    "zero-mixed.3mf",
    project([{ index: 0, objectIds: ["1"] }, { index: 1, objectIds: ["2"] }], {
      extra: [
        { name: "Metadata/plate_1.png", data: makePng() },
        { name: "Metadata/plate_2.png", data: makePng() }
      ]
    })
  );
  assert.equal((r.data.geometry as { plateCount: number }).plateCount, 2);
  assert.deepEqual(platesOf(r).map((p) => p.index), [0, 1]);
  assert.deepEqual(platesOf(r).map((p) => p.sliceIndex), [1, 2]);
});

test("with no config at all, plate_N entries are the only plate list there is", async () => {
  // The fallback still stands: when nothing enumerated the plates, the entries
  // are all the evidence available and they are believed.
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }],
    items: [{ objectid: "1" }]
  });
  const r = await run(
    "noconfig.3mf",
    make3mfPackage(xml, [
      { name: "Metadata/plate_1.png", data: makePng() },
      { name: "Metadata/plate_2.png", data: makePng() }
    ])
  );
  assert.equal((r.data.geometry as { plateCount: number }).plateCount, 2);
  assert.deepEqual(platesOf(r).map((p) => p.sliceIndex), [1, 2]);
});

// ── Contents ─────────────────────────────────────────────────────────────────

test("a plate lists its instances with object and instance ids, and object names", async () => {
  const plates = platesOf(
    await run(
      "objects.3mf",
      project(
        [
          { index: 1, objectIds: ["1", "2"], instanceIds: ["0", "3"] },
          { index: 2, objectIds: ["3"] }
        ],
        { objectNames: { "1": "bracket_left.stl", "2": "bracket_right.stl" } }
      )
    )
  );
  assert.deepEqual(plates[0].objects, [
    {
      objectId: "1",
      instanceId: "0",
      name: "bracket_left.stl",
      footprintMm: { min: [0, 0], max: [10, 10] }
    },
    {
      objectId: "2",
      instanceId: "3",
      name: "bracket_right.stl",
      footprintMm: { min: [500, 0], max: [520, 20] }
    }
  ]);
  assert.equal(plates[1].objects[0].name, null, "an object nobody named stays unnamed");
});

test("an empty plate is described as empty rather than dropped", async () => {
  // Dropping it would make the plate count and the plate list disagree, and the
  // operator would be left wondering which plate the file means.
  const plates = platesOf(
    await run("empty.3mf", project([{ index: 1, objectIds: ["1"] }, { index: 2, objectIds: [] }]))
  );
  assert.equal(plates.length, 2);
  assert.equal(plates[1].objects.length, 0);
  assert.equal(plates[1].source, "model_settings", "we KNOW it is empty, we are not merely ignorant");
  assert.equal(plates[1].geometry.sizeMm, null);
});

test("plate-level settings are carried verbatim, including keys we know nothing about", async () => {
  const plates = platesOf(
    await run(
      "settings.3mf",
      project([
        {
          index: 1,
          name: "Крышка",
          locked: true,
          objectIds: ["1"],
          settings: {
            curr_bed_type: "Textured PEI Plate",
            print_sequence: "by object",
            spiral_mode: "false",
            filament_map_mode: "Auto For Flush",
            some_future_key: "42"
          }
        }
      ])
    )
  );
  assert.equal(plates[0].locked, true);
  assert.equal(plates[0].settings.curr_bed_type, "Textured PEI Plate");
  assert.equal(plates[0].settings.print_sequence, "by object");
  assert.equal(plates[0].settings.spiral_mode, "false");
  assert.equal(plates[0].settings.filament_map_mode, "Auto For Flush");
  assert.equal(plates[0].settings.some_future_key, "42", "unknown keys survive instead of failing the parse");
});

test("malformed optional metadata leaves the plate usable", async () => {
  // A `<metadata>` with no key, no value, or a nonsense plater_id must not cost
  // us the plate — the plate itself is what the operator has to choose from.
  const config =
    '<?xml version="1.0"?><config><plate>' +
    '<metadata key="plater_id" value="not-a-number"/>' +
    "<metadata/>" +
    '<metadata key="locked"/>' +
    '<metadata value="orphan"/>' +
    '<model_instance><metadata key="object_id" value="1"/></model_instance>' +
    "</plate></config>";
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(10) }],
    items: [{ objectid: "1" }]
  });
  const plates = platesOf(
    await run("malformed.3mf", make3mfPackage(xml, [{ name: "Metadata/model_settings.config", data: config }]))
  );
  assert.equal(plates.length, 1);
  assert.equal(plates[0].index, 1, "an unparseable plater_id falls back to the position");
  assert.equal(plates[0].locked, false);
  assert.equal(plates[0].objects[0].instanceId, null, "a missing instance_id is null, not invented");
});

// ── Previews ─────────────────────────────────────────────────────────────────

test("a declared thumbnail path wins over the conventional name", async () => {
  // Orca/Bambu spell these differently between versions, so what the file says
  // must beat what we would have guessed.
  const plates = platesOf(
    await run(
      "declared.3mf",
      project(
        [{ index: 1, objectIds: ["1"], thumbnailFile: "Metadata/custom_thumb.png" }],
        {
          extra: [
            { name: "Metadata/custom_thumb.png", data: makePng(640, 480) },
            { name: "Metadata/plate_1.png", data: makePng(1, 1) }
          ]
        }
      )
    )
  );
  assert.deepEqual(plates[0].preview, {
    kind: "declared",
    entry: "Metadata/custom_thumb.png",
    contentType: "image/png",
    widthPx: 640,
    heightPx: 480,
    bytes: makePng(640, 480).length
  });
});

test("with no declared path the conventional plate_N.png is used", async () => {
  const plates = platesOf(
    await run(
      "conventional.3mf",
      project([{ index: 2, objectIds: ["1"] }], {
        extra: [{ name: "Metadata/plate_2.png", data: makePng(300, 200) }]
      })
    )
  );
  assert.equal(plates[0].preview?.kind, "conventional");
  assert.equal(plates[0].preview?.entry, "Metadata/plate_2.png");
  assert.equal(plates[0].preview?.widthPx, 300);
});

test("a JPEG preview is accepted and measured", async () => {
  const plates = platesOf(
    await run(
      "jpeg.3mf",
      project([{ index: 1, objectIds: ["1"], thumbnailFile: "Metadata/thumb.jpg" }], {
        extra: [{ name: "Metadata/thumb.jpg", data: makeJpeg(320, 240) }]
      })
    )
  );
  assert.equal(plates[0].preview?.contentType, "image/jpeg");
  assert.equal(plates[0].preview?.widthPx, 320);
  assert.equal(plates[0].preview?.heightPx, 240);
});

test("no picture at all is simply no preview", async () => {
  const plates = platesOf(await run("nopic.3mf", project([{ index: 1, objectIds: ["1"] }])));
  assert.equal(plates[0].preview, null);
});

test("a declared preview naming a missing entry is reported, not fabricated", async () => {
  const r = await run(
    "missing.3mf",
    project([{ index: 1, objectIds: ["1"], thumbnailFile: "Metadata/gone.png" }])
  );
  assert.equal(platesOf(r)[0].preview, null);
  assert.ok(r.warnings.some((w) => w.code === "threemf_plate_preview_unreadable"));
});

test("a .png that is not a PNG is refused — the extension is never evidence", async () => {
  // This is the MIME-spoofing case: an SVG served as image/png is a script the
  // browser will happily run.
  const r = await run(
    "spoof.3mf",
    project([{ index: 1, objectIds: ["1"], thumbnailFile: "Metadata/evil.png" }], {
      extra: [
        {
          name: "Metadata/evil.png",
          data: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        }
      ]
    })
  );
  assert.equal(platesOf(r)[0].preview, null);
  assert.ok(r.warnings.some((w) => w.code === "threemf_plate_preview_unreadable"));
});

test("a thumbnail path pointing outside the package resolves to nothing", async () => {
  // Not a traversal *defence* so much as a demonstration that there is nothing
  // to traverse: a declared path is matched against the archive's own entry
  // list, every member of which SafeZip already validated.
  for (const declared of ["../../etc/passwd", "/etc/passwd", "..\\..\\secret.png"]) {
    const r = await run(
      "escape.3mf",
      project([{ index: 1, objectIds: ["1"], thumbnailFile: declared }])
    );
    assert.equal(platesOf(r)[0].preview, null, declared);
  }
});

test("an implausibly large image is skipped, and the rest of the analysis stands", async () => {
  const huge = Buffer.concat([makePng(4096, 4096), Buffer.alloc(5 * 1024 * 1024, 0x7a)]);
  const r = await run(
    "huge.3mf",
    project([{ index: 1, objectIds: ["1"], thumbnailFile: "Metadata/huge.png" }], {
      extra: [{ name: "Metadata/huge.png", data: huge }]
    })
  );
  assert.equal(platesOf(r)[0].preview, null);
  assert.equal(r.verdict, "needs_preparation", "a fat thumbnail is not a broken 3MF");
  assert.deepEqual(platesOf(r)[0].geometry.sizeMm, [10, 10, 10]);
});

test("sniffImage reads sizes from headers and refuses everything else", () => {
  assert.deepEqual(sniffImage(makePng(12, 34)), {
    contentType: "image/png",
    widthPx: 12,
    heightPx: 34
  });
  assert.equal(sniffImage(makeJpeg(8, 9))?.contentType, "image/jpeg");
  assert.equal(sniffImage(Buffer.from("GIF89a-not-supported")), null);
  assert.equal(sniffImage(Buffer.from("%PDF-1.4")), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  // A PNG signature with a first chunk that is not IHDR is not a PNG we can read.
  const broken = makePng(10, 10);
  broken.write("IDAT", 12, "latin1");
  assert.equal(sniffImage(broken), null);
});

// ── slice_info.config ────────────────────────────────────────────────────────

test("a sliced plate's own estimate is attached to it", async () => {
  const r = await run(
    "estimates.3mf",
    project(
      [
        { index: 1, objectIds: ["1"], gcodeFile: "Metadata/plate_1.gcode" },
        { index: 2, objectIds: ["2"] }
      ],
      {
        extra: [
          { name: "Metadata/plate_1.gcode", data: "; G1 X0\n" },
          {
            name: "Metadata/slice_info.config",
            data: makeSliceInfoConfig([
              {
                index: 1,
                predictionS: 5400,
                weightG: 31.2,
                supportUsed: true,
                filaments: [{ id: 1, type: "PETG", color: "#1A2B3C", usedG: 31.2 }]
              }
            ])
          }
        ]
      }
    )
  );
  const plates = platesOf(r);
  assert.deepEqual(plates[0].estimate, {
    durationS: 5400,
    weightG: 31.2,
    supportUsed: true,
    filaments: [{ id: 1, type: "PETG", colorHex: "#1A2B3C", usedG: 31.2 }]
  });
  assert.equal(plates[1].estimate, null, "a plate the file says nothing about reports nothing");
  assert.equal(plates[0].sliced, true);
  assert.equal(plates[0].gcodeEntry, "Metadata/plate_1.gcode");
  assert.equal(plates[1].sliced, false);
});

test("an unreadable or foreign slice_info never costs us the analysis", async () => {
  for (const data of [
    "not xml at all <<<",
    '<?xml version="1.0"?><config><plate><metadata key="prediction" value="soon"/></plate></config>',
    '<?xml version="1.0"?><config><plate><filament id="x" used_g="lots"/></plate></config>',
    '<?xml version="1.0"?><whatever/>'
  ]) {
    const r = await run(
      "slice-info.3mf",
      project([{ index: 1, objectIds: ["1"] }], {
        extra: [{ name: "Metadata/slice_info.config", data }]
      })
    );
    assert.equal(r.verdict, "needs_preparation", data);
    const estimate = platesOf(r)[0].estimate;
    // Either nothing was read, or what was read is honestly null — never a guess.
    if (estimate) {
      assert.equal(estimate.durationS, null);
      assert.deepEqual(estimate.filaments, []);
    }
  }
});

// ── Limits ───────────────────────────────────────────────────────────────────

test("a pathological plate count is truncated loudly, and the count stays truthful", async () => {
  const many: PlateFixture[] = Array.from({ length: 200 }, (_, i) => ({
    index: i + 1,
    objectIds: ["1"]
  }));
  const r = await run("many.3mf", project(many, { objects: 1 }));
  const plates = platesOf(r);
  assert.equal(plates.length, 64, "detail is capped");
  assert.equal(
    (r.data.geometry as { plateCount: number }).plateCount,
    200,
    "the COUNT is never quietly wrong — it is what withholds the merged box"
  );
  assert.equal(r.data.platesTruncated, true);
  assert.ok(r.warnings.some((w) => w.code === "threemf_plates_truncated"));
});

test("a plate crammed with instances lists a bounded number and says it did", async () => {
  const objectIds = Array.from({ length: 900 }, () => "1");
  const r = await run("crowded.3mf", project([{ index: 1, objectIds }], { objects: 1 }));
  const plate = platesOf(r)[0];
  assert.equal(plate.objects.length, 512);
  assert.equal(plate.objectsTruncated, true);
});
