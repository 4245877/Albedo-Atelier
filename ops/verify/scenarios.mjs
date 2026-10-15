#!/usr/bin/env node
/*
 * End-to-end scenarios against the REAL orchestrator image (ops/verify/run.sh
 * builds the stage): real HTTP API, real SQLite, real poller and Moonraker
 * adapter, real OrcaSlicer — and simulated printers (fake-moonraker.mjs) whose
 * command log is the ground truth for "what physically reached a printer".
 *
 *   node scenarios.mjs main      A, A2, E, B, D, C, F, K, G, then a long print for J
 *   node scenarios.mjs restart   J — after the orchestrator was killed mid-print
 *   node scenarios.mjs auto      H — the automatic queue switched on (isolated)
 *
 * State between phases lives in $OUT/state.json; each phase writes
 * $OUT/report-<phase>.json and exits non-zero when any check failed.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ORCH = process.env.ORCH_URL ?? "http://print-orchestrator:3100";
const TOKEN = process.env.ORCH_TOKEN ?? "";
const OUT = process.env.OUT_DIR ?? "/e2e/out";
const SIMS = { k2a: process.env.SIM_K2A ?? "http://fake-k2a:7125", k2b: process.env.SIM_K2B ?? "http://fake-k2b:7125" };
const PHASE = process.argv[2] ?? "main";

const results = [];
let current = null;

// ── Plumbing ─────────────────────────────────────────────────────────────────

async function api(method, url, body, { raw = false } = {}) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${ORCH}${url}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return raw ? { status: res.status, json } : { status: res.status, json };
}

async function ok(method, url, body) {
  const res = await api(method, url, body);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.json).slice(0, 600)}`);
  return res.json;
}

async function sim(printer, method, route, body) {
  const res = await fetch(`${SIMS[printer]}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function simLog(printer) {
  return (await sim(printer, "GET", "/__sim/state")).log;
}

async function startsOf(printer, filename) {
  return (await simLog(printer)).filter((e) => e.kind === "start" && (!filename || e.filename === filename)).length;
}

async function uploadsOf(printer) {
  return (await simLog(printer)).filter((e) => e.kind === "upload").length;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, fn, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out (${timeoutMs / 1000}s) waiting for ${what}`);
}

function check(condition, message, detail) {
  current.checks.push({ ok: Boolean(condition), message, ...(detail === undefined ? {} : { detail }) });
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 500)}`}`);
}

async function scenario(id, title, body) {
  current = { id, title, checks: [], ok: true, error: null, ms: 0 };
  const t0 = Date.now();
  try {
    await body();
    console.log(`✔ ${id} · ${title} (${current.checks.length} checks)`);
  } catch (error) {
    current.ok = false;
    current.error = String(error?.stack ?? error);
    console.log(`✘ ${id} · ${title}\n    ${String(error?.message ?? error)}`);
  }
  current.ms = Date.now() - t0;
  results.push(current);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(OUT, "state.json"), "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(path.join(OUT, "state.json"), JSON.stringify(state, null, 2));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A binary STL of an axis-aligned box, `mm` on each side, standing on the plate. */
function boxStl(x, y, z) {
  const v = [
    [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
    [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]
  ];
  const buf = Buffer.alloc(84 + faces.length * 50);
  buf.write("e2e box", 0, "ascii");
  buf.writeUInt32LE(faces.length, 80);
  faces.forEach((f, i) => {
    const o = 84 + i * 50;
    const [a, b, c] = f.map((k) => v[k]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    [n[0] / len, n[1] / len, n[2] / len, ...a, ...b, ...c].forEach((value, j) => buf.writeFloatLE(value, o + j * 4));
  });
  return buf;
}

/**
 * A small Klipper G-code that declares what an OrcaSlicer export for this machine
 * declares: ten layers of a 20 mm square, extruded — so the analyzer measures a
 * real box, as it would for a real export.
 */
function gcode(model, label) {
  const lines = [
    `; generated by OrcaSlicer 2.3.0 (e2e fixture «${label}»)`,
    "; HEADER_BLOCK_START",
    "; estimated printing time (normal mode) = 12m 0s",
    "; HEADER_BLOCK_END",
    "G28",
    "G90",
    "M83",
    "M104 S240",
    "M140 S70"
  ];
  for (let layer = 1; layer <= 10; layer += 1) {
    const z = (layer * 0.2).toFixed(2);
    lines.push(";LAYER_CHANGE", `;Z:${z}`, `G1 Z${z} F3000`, "G1 X120 Y120 F6000");
    lines.push("G1 X140 Y120 E0.8 F1800", "G1 X140 Y140 E0.8", "G1 X120 Y140 E0.8", "G1 X120 Y120 E0.8");
  }
  lines.push(
    "M104 S0",
    "M140 S0",
    "; CONFIG_BLOCK_START",
    `; printer_model = ${model}`,
    "; gcode_flavor = klipper",
    "; filament_type = PETG",
    "; nozzle_diameter = 0.4",
    "; layer_height = 0.2",
    "; printable_area = 0x0,260x0,260x260,0x260",
    "; printable_height = 260",
    "; filament used [g] = 3.1",
    "; CONFIG_BLOCK_END",
    ""
  );
  return Buffer.from(lines.join("\n"), "utf8");
}

/** A ZIP with stored (uncompressed) entries — all a 3MF package needs. */
function zipStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const bytes = Buffer.from(data);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(bytes) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, bytes);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A geometry-only 3MF (no slicer settings): one closed box mesh, units declared in the file. */
function box3mf(x, y, z) {
  const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<resources><object id="1" type="model"><mesh><vertices>' +
    v.map(([a, b, c]) => `<vertex x="${a}" y="${b}" z="${c}"/>`).join("") +
    "</vertices><triangles>" +
    t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("") +
    '</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 120 120 0"/></build></model>';
  return zipStored([
    {
      name: "[Content_Types].xml",
      data:
        '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'
    },
    {
      name: "_rels/.rels",
      data:
        '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
    },
    { name: "3D/3dmodel.model", data: model }
  ]);
}

async function upload(name, bytes) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  const res = await ok("POST", "/api/print/artifacts", form);
  return res;
}

async function analysed(artifactId) {
  return waitFor(`analysis of ${artifactId}`, async () => {
    const detail = await ok("GET", `/api/print/artifacts/${artifactId}`);
    const analysis = detail.analysis ?? detail.latestAnalysis ?? detail.analyses?.[0];
    return analysis && analysis.state !== "pending" && analysis.state !== "running" ? { detail, analysis } : null;
  }, { timeoutMs: 120_000 });
}

async function task(id) {
  return ok("GET", `/api/print/tasks/${id}`);
}

async function activeRun(taskId) {
  const detail = await task(taskId);
  return detail.printRuns.find((r) => ["PENDING", "RUNNING", "PAUSED", "UNKNOWN"].includes(r.state)) ?? null;
}

/** The confirmations the server says THIS launch needs — exactly what the launch window would tick. */
async function previewFor(taskId, printerId) {
  return (await ok("GET", `/api/print/launch/${taskId}${printerId ? `?printer=${printerId}` : ""}`)).preview;
}

/**
 * The orchestrator holds a printer for 15 s after any start command
 * (RECENT_START_HOLD_MS), so a second start cannot race the device's first
 * status report. A simulated print "finishes" on demand in seconds — wait the
 * hold out, as any real print would have.
 */
async function respectStartHold(printerIds) {
  let wait = 0;
  for (const p of printerIds) {
    const last = (await simLog(p)).filter((e) => e.kind === "start").at(-1);
    if (last) wait = Math.max(wait, Date.parse(last.at) + 16_000 - Date.now());
  }
  if (wait > 0) await sleep(wait);
}

async function launch(taskId, printerId, key) {
  await respectStartHold(printerId ? [printerId] : Object.keys(SIMS));
  const preview = await previewFor(taskId, printerId);
  const confirmations = preview.confirmations.filter((c) => c.required).map((c) => c.code);
  return api("POST", `/api/print/launch/${taskId}`, {
    ...(printerId ? { printerId } : {}),
    confirmations,
    idempotencyKey: key,
    operator: "e2e"
  });
}

async function waitTaskState(taskId, states, timeoutMs = 90_000) {
  const wanted = Array.isArray(states) ? states : [states];
  return waitFor(`task ${taskId} → ${wanted.join("|")}`, async () => {
    const detail = await task(taskId);
    return wanted.includes(detail.task.state) ? detail : null;
  }, { timeoutMs });
}

async function readySlice(variantId) {
  return waitFor(`slice ${variantId}`, async () => {
    const { variant } = await ok("GET", `/api/print/slicing/variants/${variantId}`);
    if (["failed", "blocked", "cancelled"].includes(variant.state)) {
      throw new Error(`slice ${variantId} ended ${variant.state}: ${JSON.stringify({ error: variant.error, blockers: variant.blockers })}`);
    }
    return variant.state === "ready" ? variant : null;
  }, { timeoutMs: 300_000, intervalMs: 2_000 });
}

async function profileSet() {
  const { profiles } = await ok("GET", "/api/print/slicing/profiles");
  const pick = (type, name) => profiles.find((p) => p.type === type && p.name === name && p.status === "active");
  const machine = pick("machine", "Creality K2 PETG 0.4");
  const process = pick("process", "K2 PETG 0.4");
  const filament = pick("filament", "PETG @K2");
  check(machine && process && filament, "the shipped catalog has an active K2 · PETG recipe", { machine: !!machine, process: !!process, filament: !!filament });
  const created = await ok("POST", "/api/print/slicing/profile-sets", {
    name: "K2 · PETG 0.4 (e2e)",
    machine: machine.id,
    process: process.id,
    filament: filament.id,
    printerClass: "k2"
  });
  const approved = await ok("POST", `/api/print/slicing/profile-sets/${created.set.id}/approve`, {});
  check(approved.set?.approved === true || approved.approved === true, "the recipe is approved", approved);
  return created.set.id;
}

// ── Phase: main ──────────────────────────────────────────────────────────────

async function main() {
  const state = {};

  await scenario("0", "stage: real image, real OrcaSlicer, two simulated K2", async () => {
    const ready = await waitFor("orchestrator /ready", async () => {
      const res = await fetch(`${ORCH}/ready`).catch(() => null);
      return res?.ok ? res.json() : null;
    }, { timeoutMs: 180_000, intervalMs: 2_000 });
    check(ready.ready === true, "/ready", ready);
    const runtime = await ok("GET", "/api/print/slicing/runtime");
    check(runtime.runtime.available === true, "OrcaSlicer runtime available (verified by its own smoke slice)", runtime.runtime);
    check(runtime.profileCounts.quarantined === 0 && runtime.profileCounts.active >= 17, "catalog imported clean", runtime.profileCounts);
    const printers = await ok("GET", "/api/printers");
    const list = printers.printers ?? printers;
    check(list.length === 2 && list.every((p) => p.online), "both simulated printers online", list.map((p) => ({ id: p.id, online: p.online })));
    for (const p of ["k2a", "k2b"]) await sim(p, "POST", "/__sim/reset");
    state.setId = await profileSet();
  });

  await scenario("A", "STL → Creality K2 → PETG → slicing → G-code → start on a simulated K2", async () => {
    const up = await upload("e2e-cube-20.stl", boxStl(20, 20, 20));
    const { analysis } = await analysed(up.artifact.id);
    check(analysis.detectedFormat === "stl", "the upload is analysed as an STL", analysis);
    await ok("POST", `/api/print/artifacts/${up.artifact.id}/scale`, { units: "millimeter" });
    const sliced = await ok("POST", "/api/print/slicing/slice", {
      artifactId: up.artifact.id,
      profileSetId: state.setId,
      targetPrinterId: "k2a"
    });
    const variant = await readySlice(sliced.variant.id);
    check(variant.outputArtifactId, "OrcaSlicer produced a G-code", variant);
    const out = await analysed(variant.outputArtifactId);
    check(out.analysis.detectedFormat === "gcode", "the output is G-code", out.analysis.detectedFormat);
    check(out.analysis.verdict === "schedulable", "the output G-code passed its own analysis", { verdict: out.analysis.verdict, blockers: out.analysis.blockers });
    check(/K2/.test(out.analysis.data?.printerModel ?? ""), "the G-code declares the K2 it was sliced for", out.analysis.data?.printerModel);
    check(String(out.analysis.material ?? "").toUpperCase().includes("PETG"), "…and PETG", out.analysis.material);
    const promoted = await ok("POST", `/api/print/slicing/variants/${variant.id}/promote`, {});
    const taskId = promoted.task.task.id;
    check(promoted.task.task.state === "QUEUED", "promoted into the queue", promoted.task.task.state);
    state.taskA = taskId;
    state.variantA = variant.id;
    state.sourceA = up.artifact.id;

    const preview = await previewFor(taskId, "k2a");
    const required = preview.confirmations.filter((c) => c.required).map((c) => c.code).sort();
    check(required.includes("bed_clear"), "a never-confirmed bed must be confirmed by a person", required);
    check(required.includes("material_loaded"), "Klipper reports no loaded spool while idle — a person confirms it", required);

    const refused = await api("POST", `/api/print/launch/${taskId}`, { printerId: "k2a", idempotencyKey: "e2e-A-noconfirm" });
    check(refused.status >= 400, "without the confirmations the launch is refused", refused);
    check((await uploadsOf("k2a")) === 0 && (await startsOf("k2a")) === 0, "…and nothing reached the printer");

    const launched = await launch(taskId, "k2a", "e2e-A");
    check(launched.status === 200, "launch accepted", launched.json);
    const file = launched.json.run.file;
    check((await startsOf("k2a", file)) === 1, "exactly one start command, naming the delivered file", { file });
    const again = await api("POST", `/api/print/launch/${taskId}`, {
      printerId: "k2a",
      confirmations: required,
      idempotencyKey: "e2e-A"
    });
    check(again.json?.run?.deduplicated === true, "a repeated click with the same key returns the same run", again.json);
    check((await startsOf("k2a")) === 1, "…and sends nothing");
    await waitTaskState(taskId, "PRINTING");
    await sim("k2a", "POST", "/__sim/finish");
    const done = await waitTaskState(taskId, "COMPLETED");
    check(done.printRuns.at(-1).state === "SUCCEEDED", "the run completed from telemetry", done.printRuns.at(-1).state);
  });

  await scenario("A2", "geometric 3MF → real OrcaSlicer → G-code → queue (units come from the file)", async () => {
    const up = await upload("e2e-cube.3mf", box3mf(18, 18, 12));
    const { analysis } = await analysed(up.artifact.id);
    check(analysis.detectedFormat === "3mf", "analysed as a 3MF", analysis.detectedFormat);
    check(analysis.verdict === "needs_preparation", "a model, not a print file — it needs slicing", { verdict: analysis.verdict, blockers: analysis.blockers });
    const sliced = await ok("POST", "/api/print/slicing/slice", {
      artifactId: up.artifact.id,
      profileSetId: state.setId,
      targetPrinterId: "k2b"
    });
    const variant = await readySlice(sliced.variant.id);
    const out = await analysed(variant.outputArtifactId);
    check(out.analysis.detectedFormat === "gcode" && out.analysis.verdict === "schedulable", "OrcaSlicer turned it into a schedulable G-code", { format: out.analysis.detectedFormat, verdict: out.analysis.verdict, blockers: out.analysis.blockers });
    const size = out.analysis.data?.bbox?.size ?? out.analysis.data?.size;
    check(Array.isArray(size) && Math.abs(size[0] - 18) < 1.5 && Math.abs(size[2] - 12) < 0.5, "at the size the 3MF declares — no unit guess involved", size);
    const promoted = await ok("POST", `/api/print/slicing/variants/${variant.id}/promote`, {});
    check(promoted.task.task.state === "QUEUED", "queued", promoted.task.task.state);
    await ok("POST", `/api/print/tasks/${promoted.task.task.id}/cancel`, { reason: "e2e: только проверка пути 3MF" });
  });

  await scenario("E", "print finished → part on the bed → the next start is blocked", async () => {
    const up = await upload("e2e-next.gcode", gcode("Creality K2", "next"));
    await analysed(up.artifact.id);
    const queued = await ok("POST", `/api/print/tasks/${up.task.id}/enqueue`, {});
    state.taskE = queued.task.id ?? up.task.id;
    const preview = await previewFor(state.taskE, "k2a");
    const k2a = preview.candidates.find((c) => c.printerId === "k2a");
    const reasons = [...k2a.blockers, ...k2a.reviews].map((r) => r.code);
    check(reasons.includes("BED_NOT_CLEAR"), "the plate still holds the finished part", reasons);
    const before = await startsOf("k2a");
    const refused = await api("POST", `/api/print/launch/${state.taskE}`, { printerId: "k2a", idempotencyKey: "e2e-E" });
    check(refused.status >= 400, "a start without the operator's «стол свободен» is refused", refused.json);
    check((await startsOf("k2a")) === before, "nothing was sent to the occupied printer");
  });

  await scenario("B", "ready G-code → compatibility check → start without slicing", async () => {
    const foreign = await upload("e2e-for-a1.gcode", gcode("Bambu Lab A1", "foreign"));
    await analysed(foreign.artifact.id);
    await ok("POST", `/api/print/tasks/${foreign.task.id}/enqueue`, {});
    const fp = await previewFor(foreign.task.id, "k2b");
    const k2b = fp.candidates.find((c) => c.printerId === "k2b");
    check(k2b.blockers.some((b) => b.code === "TARGET_PRINTER_MISMATCH"), "a file sliced for another printer is refused before any transfer", k2b.blockers.map((b) => b.code));
    const uploadsBefore = await uploadsOf("k2b");
    const wrong = await api("POST", `/api/print/launch/${foreign.task.id}`, { printerId: "k2b", idempotencyKey: "e2e-B-foreign" });
    check(wrong.status >= 400 && (await uploadsOf("k2b")) === uploadsBefore, "…and the launch sends no bytes", wrong.json);
    await ok("POST", `/api/print/tasks/${foreign.task.id}/cancel`, { reason: "e2e: чужой файл" });

    const up = await upload("e2e-bracket-k2.gcode", gcode("Creality K2", "bracket"));
    const { analysis } = await analysed(up.artifact.id);
    check(analysis.verdict === "schedulable", "a K2 G-code is schedulable as uploaded", analysis);
    await ok("POST", `/api/print/tasks/${up.task.id}/enqueue`, {});
    const launched = await launch(up.task.id, "k2b", "e2e-B");
    check(launched.status === 200, "launched on the K2", launched.json);
    const detail = await task(up.task.id);
    check(detail.sliceVariants.length === 0, "no slicing happened for a ready G-code", detail.sliceVariants.length);
    check((await startsOf("k2b", launched.json.run.file)) === 1, "one start on k2b");
    await waitTaskState(up.task.id, "PRINTING");
    await sim("k2b", "POST", "/__sim/finish");
    await waitTaskState(up.task.id, "COMPLETED");
    state.taskB = up.task.id;
  });

  await scenario("D", "finished print → history → «Напечатать ещё раз» → a new, independent print", async () => {
    const page = await ok("GET", "/api/print/history?limit=20");
    const entry = page.entries.find((e) => e.taskId === state.taskA);
    check(entry && entry.state === "COMPLETED", "the finished print is in the history", entry);
    check(entry.recipe?.profileSetId === state.setId || entry.recipe?.profileSet?.id === state.setId || entry.recipe, "with the recipe it was sliced with", entry.recipe);
    check(entry.actions?.reprint?.allowed === true, "and offers «Напечатать ещё раз»", entry.actions);
    const beforeA = await task(state.taskA);
    const first = await ok("POST", `/api/print/tasks/${state.taskA}/reprint`, { requestId: "e2e-D" });
    const second = await ok("POST", `/api/print/tasks/${state.taskA}/reprint`, { requestId: "e2e-D" });
    const reprintId = first.task.task.id;
    check(reprintId !== state.taskA, "the repeat is a NEW task", { reprintId });
    check(second.deduplicated === true && second.task.task.id === reprintId, "the same request id never creates a second one", second);
    const afterA = await task(state.taskA);
    check(afterA.task.state === "COMPLETED" && afterA.task.version === beforeA.task.version, "the finished print itself is untouched", { before: beforeA.task.version, after: afterA.task.version });
    const copy = (await task(reprintId)).sliceVariants[0];
    const original = (await ok("GET", `/api/print/slicing/variants/${state.variantA}`)).variant;
    check(copy && copy.outputArtifactId === original.outputArtifactId, "the same verified G-code — nothing re-sliced", { copy: copy?.outputArtifactId, original: original.outputArtifactId });
    const launched = await launch(reprintId, "k2a", "e2e-D");
    check(launched.status === 200, "the repeat launches (the operator confirms the cleared plate)", launched.json);
    await waitTaskState(reprintId, "PRINTING");
    await sim("k2a", "POST", "/__sim/finish");
    await waitTaskState(reprintId, "COMPLETED");
    state.taskD = reprintId;
  });

  await scenario("C", "several STL → one batch → spread over both printers", async () => {
    const a = await upload("e2e-batch-15.stl", boxStl(15, 15, 15));
    const b = await upload("e2e-batch-25.stl", boxStl(25, 25, 10));
    await analysed(a.artifact.id);
    await analysed(b.artifact.id);
    for (const id of [a.artifact.id, b.artifact.id]) await ok("POST", `/api/print/artifacts/${id}/scale`, { units: "millimeter" });
    const batch = (await ok("POST", "/api/print/slicing/batches", {
      artifactIds: [a.artifact.id, b.artifact.id],
      profileSetId: state.setId
    })).batch;
    const rows = batch.items ?? batch.results ?? batch.rows ?? [];
    check(rows.length === 2 && rows.every((r) => r.ok), "both models accepted into one batch", batch);
    const variants = [];
    for (const row of rows) variants.push(await readySlice(row.variant.id));
    const promoted = await ok("POST", "/api/print/slicing/batches/promote", { variantIds: variants.map((v) => v.id) });
    const taskIds = promoted.items.filter((i) => i.ok).map((i) => i.task?.task?.id ?? i.taskId);
    check(taskIds.length === 2, "both promoted", promoted.items);
    const first = await launch(taskIds[0], null, "e2e-C1");
    check(first.status === 200, "first job launched on the recommended printer", first.json);
    const second = await launch(taskIds[1], null, "e2e-C2");
    check(second.status === 200, "second job launched", second.json);
    check(first.json.printerId !== second.json.printerId, "never two on one printer — the second went to the other K2", { first: first.json.printerId, second: second.json.printerId });
    for (const p of ["k2a", "k2b"]) await sim(p, "POST", "/__sim/finish");
    for (const id of taskIds) await waitTaskState(id, "COMPLETED");
  });

  await scenario("F", "connection lost during the send → outcome unknown → never re-sent automatically", async () => {
    // F1: the printer executed the start, the answer was lost.
    const up1 = await upload("e2e-lost-answer.gcode", gcode("Creality K2", "lost-answer"));
    await analysed(up1.artifact.id);
    await ok("POST", `/api/print/tasks/${up1.task.id}/enqueue`, {});
    await sim("k2b", "POST", "/__sim/set", { dropStartResponse: true, printSeconds: 40 });
    const lost = await launch(up1.task.id, "k2b", "e2e-F1");
    check(lost.status >= 400, "the operator is told the start's outcome is unknown", lost.json);
    const run1 = await activeRun(up1.task.id);
    check(run1 && ["UNKNOWN", "PENDING", "RUNNING"].includes(run1.state), "the run is held, not closed", run1);
    const held = await previewFor(state.taskE, "k2b");
    check(held.candidates.find((c) => c.printerId === "k2b").eligible === false, "the printer is held against other jobs");
    const observed = await waitFor("the print to be observed", async () => ((await activeRun(up1.task.id))?.state === "RUNNING" ? true : null), { timeoutMs: 60_000 });
    check(observed, "telemetry reconciles it: the printer IS printing that file");
    check((await startsOf("k2b", run1.file)) === 1, "exactly one start ever reached the printer");
    await sim("k2b", "POST", "/__sim/finish");
    await waitTaskState(up1.task.id, "COMPLETED");

    // F2: the start died on the wire — nothing printed, nothing re-sent.
    const up2 = await upload("e2e-lost-command.gcode", gcode("Creality K2", "lost-command"));
    await analysed(up2.artifact.id);
    await ok("POST", `/api/print/tasks/${up2.task.id}/enqueue`, {});
    await sim("k2a", "POST", "/__sim/set", { dropStartAndIgnore: true });
    const died = await launch(up2.task.id, "k2a", "e2e-F2");
    check(died.status >= 400, "the operator is told", died.json);
    const run2 = await activeRun(up2.task.id);
    check(run2 && ["UNKNOWN", "PENDING"].includes(run2.state), "the attempt is held as unresolved", run2);
    await sleep(20_000);
    check((await startsOf("k2a", run2.file)) === 1, "20 s later: still exactly one start — nothing retried it");
    const readiness = await ok("GET", `/api/print/launch?task=${up2.task.id}`);
    check(readiness.rows[0].state === "unconfirmed", "the queue row asks the operator what happened", readiness.rows[0]);
    const replay = await api("POST", `/api/print/launch/${up2.task.id}`, { printerId: "k2a", confirmations: ["bed_clear", "material_loaded"], idempotencyKey: "e2e-F2" });
    check(replay.status >= 400 && (await startsOf("k2a", run2.file)) === 1, "a retry with the same key is not replayed as a success and sends nothing", replay.json);
    const resolved = await ok("POST", `/api/print/runs/${run2.id}/resolve`, { outcome: "CANCELLED", reason: "e2e: печать не началась" });
    check(resolved.run, "the operator records that it never started");
    const back = await task(up2.task.id);
    check(back.task.state === "QUEUED", "the job is back in the queue for a deliberate retry", back.task.state);
    check((await startsOf("k2a", run2.file)) === 1, "…and still nothing was re-sent on its own");
    state.taskF2 = up2.task.id;
  });

  await scenario("K", "cancelling: a running print is stopped physically, never «cancelled» onto a free plate", async () => {
    const queued = await upload("e2e-cancel-queued.gcode", gcode("Creality K2", "cancel-queued"));
    await analysed(queued.artifact.id);
    await ok("POST", `/api/print/tasks/${queued.task.id}/enqueue`, {});
    const logBefore = (await simLog("k2b")).length;
    const cancelled = await ok("POST", `/api/print/tasks/${queued.task.id}/cancel`, { reason: "e2e" });
    check(cancelled.outcome === "cancelled" || cancelled.task?.state === "CANCELLED", "a waiting job cancels logically", cancelled);
    check((await simLog("k2b")).length === logBefore, "…without a single command to any printer");

    const up = await upload("e2e-cancel-running.gcode", gcode("Creality K2", "cancel-running"));
    await analysed(up.artifact.id);
    await ok("POST", `/api/print/tasks/${up.task.id}/enqueue`, {});
    await sim("k2b", "POST", "/__sim/set", { printSeconds: 300 });
    const launched = await launch(up.task.id, "k2b", "e2e-K");
    check(launched.status === 200, "started", launched.json);
    await waitTaskState(up.task.id, "PRINTING");
    const refused = await api("POST", `/api/print/tasks/${up.task.id}/cancel`, { reason: "e2e" });
    check(refused.status >= 400, "a logical cancel of a print on the machine is refused", refused.json);
    check((await previewFor(state.taskE, "k2b")).candidates.find((c) => c.printerId === "k2b").eligible === false, "the printing K2 stays held");
    const stop = await api("POST", `/api/print/tasks/${up.task.id}/stop`, {});
    check(stop.status === 200, "«остановить» sends the physical stop", stop.json);
    check((await simLog("k2b")).filter((e) => e.kind === "cancel").length === 1, "exactly one cancel reached the printer");
    const done = await waitTaskState(up.task.id, ["CANCELLED", "FAILED"]);
    check(["CANCELLED", "FAILED"].includes(done.printRuns.at(-1).state), "the run closes from what the printer reports", done.printRuns.at(-1).state);
    const after = (await previewFor(state.taskE, "k2b")).candidates.find((c) => c.printerId === "k2b");
    const reasons = [...after.blockers, ...after.reviews].map((r) => r.code);
    check(reasons.includes("BED_NOT_CLEAR"), "whatever was printed is still on the plate — the next start waits for a person", reasons);
    await sim("k2b", "POST", "/__sim/set", { printSeconds: 20 });
  });

  await scenario("G", "automatic queue switched off at deployment → it can start nothing", async () => {
    const overview = await ok("GET", "/api/automations/auto-queue");
    check(overview.status.configured === false, "AUTO_QUEUE_ENABLED is off", overview.status);
    const arm = await api("POST", "/api/automations/auto-queue/toggle", { on: true });
    check(arm.status === 409, "the rule cannot be switched on", arm.json);
    const tick = await api("POST", "/api/automations/auto-queue/tick", {});
    check(tick.status === 409, "a pass cannot be forced", tick.json);
    await ok("POST", `/api/print/scheduler/tasks/${state.taskF2}/params`, { unattendedAllowed: true });
    for (const p of ["k2a", "k2b"]) await ok("POST", `/api/printers/${p}/bed/clear`, { confirmation: "part_removed", note: "e2e" });
    const before = (await startsOf("k2a")) + (await startsOf("k2b"));
    await sleep(25_000);
    check((await startsOf("k2a")) + (await startsOf("k2b")) === before, "25 s with an eligible, permitted job and free printers: no start");
  });

  await scenario("J-prep", "a long print in flight before the orchestrator is killed", async () => {
    await sim("k2a", "POST", "/__sim/set", { printSeconds: 240 });
    const launched = await launch(state.taskF2, "k2a", "e2e-J");
    check(launched.status === 200, "started", launched.json);
    await waitTaskState(state.taskF2, "PRINTING");
    state.taskJ = state.taskF2;
    state.runJ = launched.json.run.runId;
    state.fileJ = launched.json.run.file;
    state.startsJ = await startsOf("k2a");
  });

  saveState(state);
}

// ── Phase: restart ───────────────────────────────────────────────────────────

async function restart() {
  const state = loadState();
  await scenario("J", "orchestrator killed mid-print → recovery re-adopts the print, nothing is re-sent", async () => {
    await waitFor("orchestrator /ready after the crash", async () => {
      const res = await fetch(`${ORCH}/ready`).catch(() => null);
      return res?.ok ? true : null;
    }, { timeoutMs: 180_000, intervalMs: 2_000 });
    const run = await waitFor("the run to be observed again", async () => {
      const r = await activeRun(state.taskJ);
      return r && r.state === "RUNNING" ? r : null;
    }, { timeoutMs: 60_000 });
    check(run.id === state.runJ, "the same run, re-adopted from SQLite", { before: state.runJ, after: run.id });
    check((await startsOf("k2a")) === state.startsJ, "no start command after the restart");
    const preview = await previewFor(state.taskE, "k2a");
    check(preview.candidates.find((c) => c.printerId === "k2a").eligible === false, "the printing K2 is not offered to another job");
    await sim("k2a", "POST", "/__sim/finish");
    const done = await waitTaskState(state.taskJ, "COMPLETED");
    check(done.printRuns.at(-1).state === "SUCCEEDED", "completion recorded exactly once, from telemetry");
    const next = await previewFor(state.taskE, "k2a");
    const reasons = [...next.candidates.find((c) => c.printerId === "k2a").blockers, ...next.candidates.find((c) => c.printerId === "k2a").reviews].map((r) => r.code);
    check(reasons.includes("BED_NOT_CLEAR"), "and the plate is held for the part", reasons);
  });
  saveState(state);
}

// ── Phase: auto ──────────────────────────────────────────────────────────────

async function auto() {
  const state = loadState();
  await scenario("H", "automatic queue ON (isolated) → only fully admissible jobs start", async () => {
    await waitFor("orchestrator /ready", async () => {
      const res = await fetch(`${ORCH}/ready`).catch(() => null);
      return res?.ok ? true : null;
    }, { timeoutMs: 180_000, intervalMs: 2_000 });
    const overview = await ok("GET", "/api/automations/auto-queue");
    check(overview.status.configured === true, "the deployment switch is on in this isolated stage", overview.status);
    check(overview.status.armed === false, "…but the operator rule is still off — nothing armed it", overview.status);
    for (const p of ["k2a", "k2b"]) await ok("POST", `/api/printers/${p}/bed/clear`, { confirmation: "part_removed", note: "e2e" });

    const forbidden = await upload("e2e-auto-forbidden.gcode", gcode("Creality K2", "auto-forbidden"));
    await analysed(forbidden.artifact.id);
    await ok("POST", `/api/print/tasks/${forbidden.task.id}/enqueue`, {});
    const allowed = await upload("e2e-auto-allowed.gcode", gcode("Creality K2", "auto-allowed"));
    await analysed(allowed.artifact.id);
    await ok("POST", `/api/print/tasks/${allowed.task.id}/enqueue`, {});
    await ok("POST", `/api/print/scheduler/tasks/${allowed.task.id}/params`, { unattendedAllowed: true });

    const before = (await startsOf("k2a")) + (await startsOf("k2b"));
    const armed = await ok("POST", "/api/automations/auto-queue/toggle", { on: true });
    check(armed.automation.on === true, "the operator arms the rule");
    await sleep(25_000);
    const status = (await ok("GET", "/api/automations/auto-queue")).status;
    const plan = (await ok("GET", "/api/automations/auto-queue")).plan;
    const byTask = new Map(plan.map((d) => [d.taskId, d]));
    check(byTask.get(forbidden.task.id)?.outcome === "not_allowed", "a job without «можно без оператора» is never a candidate", byTask.get(forbidden.task.id));
    const waiting = byTask.get(allowed.task.id);
    check(waiting && waiting.outcome === "waiting", "the permitted job waits — Klipper does not report the loaded spool while idle, and nobody is there to confirm it", waiting);
    check(/материал/i.test(waiting.message) || /MATERIAL/.test(waiting.code ?? ""), "…and says so", waiting);
    check(status.lastTickAt !== null, "the executor did run its passes", status);
    check((await startsOf("k2a")) + (await startsOf("k2b")) === before, "no start command was sent");
    await ok("POST", "/api/automations/auto-queue/toggle", { on: false });
    state.autoChecked = true;
  });
  saveState(state);
}

// ── Run ──────────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT, { recursive: true });
const phases = { main, restart, auto };
if (!phases[PHASE]) {
  console.error(`unknown phase «${PHASE}» (main | restart | auto)`);
  process.exit(2);
}
await phases[PHASE]();
fs.writeFileSync(path.join(OUT, `report-${PHASE}.json`), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${PHASE}: ${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length > 0 ? 1 : 0);
