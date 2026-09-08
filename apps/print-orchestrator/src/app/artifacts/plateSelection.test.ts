import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { readPlateSelection, readPlates, selectedPlate } from "../../domain/print/plateSelection";
import type { Artifact, ArtifactAnalysis } from "../../domain/print/types";
import type { PrintQueueStore as Store } from "../../domain/print/repositories";
import { openPrintQueueStore } from "../../infra/db/store";
import { ArtifactStorage } from "../../infra/storage/artifactStorage";
import { ArtifactService } from "./artifactService";
import {
  boxVertices,
  make3mfModel,
  make3mfPackage,
  makeModelSettingsConfig,
  makePng
} from "./testkit/fixtures";

/*
 * Plate selection as a *stored fact about specific bytes*, exercised through the
 * real service and the real analyzer.
 *
 * The point of these tests is not that a number can be written into a metadata
 * column — it is that the number stops meaning what it meant the moment anything
 * underneath it moves. A choice made against two plates must not silently
 * survive into a file that now has three, because "plate 2" then names a
 * different print, and nothing else in the chain would notice.
 */

const LIMITS = {
  zipMaxEntries: 1000,
  zipMaxEntryBytes: 64 * 1024 * 1024,
  zipMaxTotalBytes: 128 * 1024 * 1024,
  zipMaxRatio: 200,
  xmlMaxBytes: 16 * 1024 * 1024
};

let TMP: string;
let store: Store;
let artifacts: ArtifactService;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plate-sel-"));
  store = openPrintQueueStore(":memory:");
  const storage = new ArtifactStorage({ root: path.join(TMP, "artifacts") });
  await storage.init();
  artifacts = new ArtifactService(store, storage, {
    limits: LIMITS,
    maxFileBytes: 8 * 1024 * 1024,
    timeoutMs: 10000,
    concurrency: 2
  });
});

afterEach(() => {
  artifacts.close();
  store.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** A project with `count` plates, each holding one distinctly-sized cube. */
function project(count: number, options: { withThumbnails?: boolean } = {}): Buffer {
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
      data: makeModelSettingsConfig(
        Array.from({ length: count }, (_, i) => ({
          index: i + 1,
          name: `Пластина ${i + 1}`,
          objectIds: [String(i + 1)]
        }))
      )
    },
    { name: "Metadata/project_settings.config", data: '{"layer_height":"0.2"}' },
    ...(options.withThumbnails
      ? Array.from({ length: count }, (_, i) => ({
          name: `Metadata/plate_${i + 1}.png`,
          data: makePng(400 + i, 300 + i)
        }))
      : [])
  ]);
}

async function ingest(name: string, data: Buffer): Promise<string> {
  const res = await artifacts.ingest({ source: Readable.from(data), fileName: name });
  await artifacts.whenIdle();
  return res.artifact.id;
}

function current(id: string): { artifact: Artifact; analysis: ArtifactAnalysis } {
  const artifact = store.repositories.artifacts.getById(id);
  const analysis = store.repositories.artifactAnalyses.latestForArtifact(id);
  assert.ok(artifact && analysis);
  return { artifact, analysis };
}

// ── The happy path ───────────────────────────────────────────────────────────

test("a chosen plate is what the rest of the system reads back", async () => {
  const id = await ingest("p.3mf", project(3));
  artifacts.selectPlate(id, { plateIndex: 2, actor: "albedo" });

  const { artifact, analysis } = current(id);
  const plate = selectedPlate(artifact, analysis);
  assert.equal(plate?.index, 2);
  assert.equal(plate?.name, "Пластина 2");
  assert.deepEqual(plate?.sizeMm, [20, 20, 20]);
  assert.equal(readPlateSelection(artifact, analysis)?.confirmation.confirmedBy, "albedo");
});

test("the plate list survives the round-trip through the analysis column", async () => {
  const id = await ingest("p.3mf", project(2, { withThumbnails: true }));
  const { analysis } = current(id);
  const plates = readPlates(analysis);
  assert.deepEqual(
    plates.map((p) => ({ index: p.index, objects: p.objectCount, preview: p.hasPreview })),
    [
      { index: 1, objects: 1, preview: true },
      { index: 2, objects: 1, preview: true }
    ]
  );
});

// ── Staleness ────────────────────────────────────────────────────────────────

test("replacing the file's bytes lapses the choice", async () => {
  const id = await ingest("p.3mf", project(2));
  artifacts.selectPlate(id, { plateIndex: 2 });

  const { artifact, analysis } = current(id);
  const replaced = { ...artifact, sha256: "0".repeat(64) };
  const resolved = readPlateSelection(replaced, analysis);
  assert.equal(resolved?.stale, true);
  assert.equal(resolved?.staleReason, "файл был заменён");
  assert.equal(selectedPlate(replaced, analysis), null, "a lapsed choice authorises nothing");
});

test("a re-analysis that finds a different number of plates lapses the choice", async () => {
  // The same bytes, read by a newer analyzer, can legitimately hold a different
  // number of plates — and then "plate 2" names a different print. This is why
  // the count is captured alongside the index.
  const id = await ingest("p.3mf", project(2));
  artifacts.selectPlate(id, { plateIndex: 2 });

  const { artifact, analysis } = current(id);
  const geometry = { ...(analysis.data.geometry as Record<string, unknown>), plateCount: 3 };
  const reanalysed = { ...analysis, data: { ...analysis.data, geometry } };

  const resolved = readPlateSelection(artifact, reanalysed);
  assert.equal(resolved?.stale, true);
  assert.match(resolved?.staleReason ?? "", /пластин теперь 3, а не 2/);
});

test("a choice pointing at a plate that is no longer there lapses", async () => {
  const id = await ingest("p.3mf", project(3));
  artifacts.selectPlate(id, { plateIndex: 3 });

  const { artifact, analysis } = current(id);
  const plates = (analysis.data.plates as { index: number }[]).filter((p) => p.index !== 3);
  const geometry = { ...(analysis.data.geometry as Record<string, unknown>), plateCount: 3 };
  const trimmed = { ...analysis, data: { ...analysis.data, plates, geometry } };

  const resolved = readPlateSelection(artifact, trimmed);
  assert.equal(resolved?.stale, true);
  assert.match(resolved?.staleReason ?? "", /№3 больше нет/);
});

test("a re-analysis that MOVES the plate lapses the choice too", async () => {
  // The sharp case, and the one every other check here walks straight past: same
  // bytes, same hash, same plate count, same plate number still present — but the
  // analyzer now puts that plate at a different position, and the position is
  // what `--slice` executes. Without capturing it, "plate 2" silently becomes
  // whatever now stands second.
  const id = await ingest("p.3mf", project(3));
  artifacts.selectPlate(id, { plateIndex: 2 });

  const { artifact, analysis } = current(id);
  const plates = (analysis.data.plates as { index: number; sliceIndex: number }[]).map((p) =>
    p.index === 2 ? { ...p, sliceIndex: 3 } : p
  );
  const moved = { ...analysis, data: { ...analysis.data, plates } };

  const resolved = readPlateSelection(artifact, moved);
  assert.equal(resolved?.stale, true);
  assert.match(resolved?.staleReason ?? "", /на другом месте/);
  assert.equal(selectedPlate(artifact, moved), null, "and it authorises nothing");
});

test("a plate whose contents the file never described cannot be chosen", async () => {
  // Known only because some `plate_N` entry names it: no contents, no size, and
  // a position that was inferred rather than read. There is nothing here to make
  // a decision about, and choosing it would slice with every size check reduced
  // to nothing.
  const id = await ingest("p.3mf", project(2));
  const { artifact, analysis } = current(id);
  const plates = (analysis.data.plates as Record<string, unknown>[]).map((p) =>
    p.index === 2 ? { ...p, source: "entries", objects: [], objectCount: 0 } : p
  );
  store.repositories.artifactAnalyses.update({
    ...analysis,
    data: { ...analysis.data, plates }
  });

  assert.throws(() => artifacts.selectPlate(artifact.id, { plateIndex: 2 }), /состав пластины не разобран/);
  // …and plate 1, which the file does describe, is still perfectly choosable.
  assert.equal(artifacts.selectPlate(artifact.id, { plateIndex: 1 }).plate.index, 1);
});

test("a choice recorded against neither hash nor size is treated as unverifiable", async () => {
  const id = await ingest("p.3mf", project(2));
  artifacts.selectPlate(id, { plateIndex: 1 });
  const { artifact, analysis } = current(id);

  const unverifiable = {
    ...artifact,
    metadata: {
      ...artifact.metadata,
      plateSelection: { plateIndex: 1, plateCount: 2, confirmedBy: "x", confirmedAt: "" }
    }
  };
  const resolved = readPlateSelection(unverifiable, analysis);
  assert.equal(resolved?.stale, true);
  assert.match(resolved?.staleReason ?? "", /нельзя сверить/);
});

// ── Refusals ─────────────────────────────────────────────────────────────────

test("a plate cannot be chosen before the analysis has spoken", async () => {
  const id = await ingest("pending.3mf", project(2));
  // Put the analysis back into `running`, as it is while a worker holds it.
  const analysis = store.repositories.artifactAnalyses.latestForArtifact(id);
  assert.ok(analysis);
  store.repositories.artifactAnalyses.update({ ...analysis, state: "running" });
  assert.throws(() => artifacts.selectPlate(id, { plateIndex: 1 }), /после успешного анализа/);
});

test("a file with no plate list cannot have a plate chosen for it", async () => {
  const stl = Buffer.concat([Buffer.alloc(84), Buffer.alloc(50)]);
  stl.writeUInt32LE(1, 80);
  const id = await ingest("cube.stl", stl);
  assert.throws(() => artifacts.selectPlate(id, { plateIndex: 1 }), /нет пластин/);
});

test("withdrawing a choice removes it entirely rather than blanking it", async () => {
  const id = await ingest("p.3mf", project(2));
  artifacts.selectPlate(id, { plateIndex: 1 });
  artifacts.clearPlateSelection(id, "albedo");

  const { artifact, analysis } = current(id);
  assert.equal(artifact.metadata.plateSelection, undefined);
  assert.equal(readPlateSelection(artifact, analysis), null);
});

// ── Preview bytes ────────────────────────────────────────────────────────────

test("the preview endpoint serves the plate's own picture", async () => {
  const id = await ingest("p.3mf", project(2, { withThumbnails: true }));
  const first = await artifacts.readPlatePreview(id, 1);
  const second = await artifacts.readPlatePreview(id, 2);
  assert.equal(first.contentType, "image/png");
  assert.ok(first.data.equals(makePng(400, 300)));
  assert.ok(second.data.equals(makePng(401, 301)), "each plate gets ITS picture, not the first one");
  assert.notEqual(first.etag, second.etag);
});

test("a plate with no picture, and an unknown plate, are both 'not found'", async () => {
  const id = await ingest("p.3mf", project(2));
  await assert.rejects(artifacts.readPlatePreview(id, 1), /Превью пластины/);
  await assert.rejects(artifacts.readPlatePreview(id, 99), /Пластина №99/);
});

test("the preview read never trusts the analysis about the content type", async () => {
  // Even a doctored `data` column cannot make the endpoint serve something that
  // is not an image: the type is re-derived from the bytes on the way out.
  const id = await ingest("p.3mf", project(1, { withThumbnails: true }));
  const analysis = store.repositories.artifactAnalyses.latestForArtifact(id);
  assert.ok(analysis);
  const plates = (analysis.data.plates as Record<string, unknown>[]).map((p) => ({
    ...p,
    preview: { ...(p.preview as Record<string, unknown>), entry: "Metadata/project_settings.config" }
  }));
  store.repositories.artifactAnalyses.update({ ...analysis, data: { ...analysis.data, plates } });

  await assert.rejects(artifacts.readPlatePreview(id, 1), /Превью пластины/);
});

// ── An analysis older than the plate list ────────────────────────────────────

test("a multi-plate file analysed before plates existed asks for a re-analysis", async () => {
  // The row a 1.2.0 analyzer wrote: it knows there are several plates (that is
  // what withholds the merged box) but cannot say which is which. A picker with
  // nothing in it would be a step nobody can take.
  const { resolveArtifactStatus } = await import("./nextAction");
  const id = await ingest("old.3mf", project(2));
  const analysis = store.repositories.artifactAnalyses.latestForArtifact(id);
  assert.ok(analysis);
  const { plates: _dropped, ...withoutPlates } = analysis.data;
  const legacy = { ...analysis, analyzerVersion: "1.2.0", data: withoutPlates };
  store.repositories.artifactAnalyses.update(legacy);

  const { artifact, analysis: current2 } = current(id);
  const status = resolveArtifactStatus(artifact, current2, null);
  assert.equal(status.next.kind, "reanalyze");
  assert.equal(status.next.actionable, true);
  assert.match(status.next.explanation, /Перезапустите анализ/);
  assert.equal(status.plates.required, false, "nothing to require a choice from");

  // And a plate cannot be chosen for it either — the list it would come from is
  // simply not there.
  assert.throws(() => artifacts.selectPlate(id, { plateIndex: 1 }), /нет пластин/);
});
