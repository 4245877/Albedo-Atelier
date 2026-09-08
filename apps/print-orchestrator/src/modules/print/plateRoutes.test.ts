import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

/*
 * The plate surface end-to-end: choosing a plate of a multi-plate 3MF, reading
 * a plate's thumbnail out of the uploaded package, and the refusals around both.
 *
 * Run against the real store, the real analyzer and the real ZIP reader through
 * HTTP, because the security properties this feature has to have are properties
 * of the *request*: what a caller can name, and what they cannot. A unit test of
 * the service would prove the entry lookup works and prove nothing about whether
 * a caller can influence it.
 *
 * env freezes on first import, so process.env is set at module top and
 * everything reading it is imported dynamically afterwards.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-plate-routes-"));
const TOKEN = "plate-test-token";
process.env.ORCHESTRATOR_API_TOKEN = TOKEN;
process.env.STATE_FILE_PATH = path.join(TMP, "state.json");
process.env.MAX_UPLOAD_FILE_BYTES = String(8 * 1024 * 1024);
process.env.ANALYSIS_CONCURRENCY = "2";
process.env.UPLOAD_MIN_FREE_DISK_BYTES = "1048576";
process.env.PRINTERS_CONFIG_PATH = path.join(TMP, "no-printers.json");

let app: FastifyInstance;
let farmStore: typeof import("../../app/farmStore").farmStore;
let fixtures: typeof import("../../app/artifacts/testkit/fixtures");

before(async () => {
  const { AppError, toClientError } = await import("../../core/errors");
  const { registerSecurity } = await import("../../http/security");
  const { registerPrintQueueRoutes } = await import("./routes");
  ({ farmStore } = await import("../../app/farmStore"));
  fixtures = await import("../../app/artifacts/testkit/fixtures");

  app = Fastify();
  registerSecurity(app);
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.statusCode).send({ error: toClientError(error) });
      return;
    }
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    reply.code(status).send({ error: { code: "ERR", message: error.message } });
  });
  await app.register(registerPrintQueueRoutes, {
    prefix: "/api/print",
    services: farmStore,
    commands: farmStore.commands
  });
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A two-plate OrcaSlicer-style project: plate 1 holds a cube and declares a PNG
 * thumbnail, plate 2 holds a bigger cube 500 mm away and has none. `salt` makes
 * otherwise-identical uploads distinct content (the store deduplicates blobs).
 */
function twoPlateProject(
  salt: number,
  options: { thumbnail?: Buffer; thumbnailPath?: string; emptySecondPlate?: boolean } = {}
): Buffer {
  const { boxVertices, make3mfModel, make3mfPackage, makeModelSettingsConfig, makePng } = fixtures;
  const xml = make3mfModel({
    unit: "millimeter",
    application: `OrcaSlicer-2.3.0 build ${salt}`,
    objects: [
      { id: "1", vertices: boxVertices(10) },
      { id: "2", vertices: boxVertices(30, 30, 30, [500, 0, 0]) }
    ],
    items: [{ objectid: "1" }, { objectid: "2" }]
  });
  const thumbPath = options.thumbnailPath ?? "Metadata/plate_1.png";
  return make3mfPackage(xml, [
    {
      name: "Metadata/model_settings.config",
      data: makeModelSettingsConfig([
        { index: 1, name: "Корпус", objectIds: ["1"], thumbnailFile: thumbPath },
        { index: 2, objectIds: options.emptySecondPlate ? [] : ["2"] }
      ])
    },
    { name: "Metadata/project_settings.config", data: '{"layer_height":"0.2"}' },
    ...(thumbPath.startsWith("Metadata/") && !options.thumbnailPath
      ? [{ name: thumbPath, data: options.thumbnail ?? makePng(600, 400) }]
      : []),
    // A file the caller would love to read if only they could name it.
    { name: "Metadata/project_secret.txt", data: "SECRET-PROFILE-TOKEN" }
  ]);
}

function multipart(filename: string, data: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----atelier${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
  );
  return {
    payload: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}

/** Uploads a package, waits for the analysis, and returns the artifact id + detail. */
async function upload(name: string, data: Buffer) {
  const { payload, headers } = multipart(name, data);
  const res = await app.inject({
    method: "POST",
    url: "/api/print/artifacts",
    payload,
    headers: { ...headers, authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(res.statusCode === 200 || res.statusCode === 201, true, res.body);
  const id = res.json().artifact.id as string;
  await farmStore.artifacts.whenIdle();
  return { id, detail: await detailOf(id) };
}

async function detailOf(id: string) {
  const res = await app.inject({ method: "GET", url: `/api/print/artifacts/${id}` });
  assert.equal(res.statusCode, 200);
  return res.json();
}

const auth = { authorization: `Bearer ${TOKEN}` };

function selectPlate(id: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/print/artifacts/${id}/plate`, payload: body, headers: auth });
}

// ── The plate list and the next action ───────────────────────────────────────

test("a multi-plate project asks for a plate instead of dead-ending", async () => {
  const { detail } = await upload("project.3mf", twoPlateProject(1));
  assert.equal(detail.status.next.kind, "select_plate");
  assert.equal(detail.status.next.actionable, true);
  assert.match(detail.status.next.explanation, /2 пластин/);
  assert.equal(detail.status.plates.count, 2);
  assert.equal(detail.status.plates.required, true);
  assert.equal(detail.status.plates.selectedIndex, null);

  const plates = detail.analyses.at(-1).data.plates;
  assert.equal(plates.length, 2);
  assert.equal(plates[0].name, "Корпус");
  assert.deepEqual(plates[1].geometry.sizeMm, [30, 30, 30]);
});

test("a single-plate 3MF is untouched: no plate step, no confirmation", async () => {
  const { boxVertices, make3mfModel, make3mfPackage } = fixtures;
  const xml = make3mfModel({
    unit: "millimeter",
    objects: [{ id: "1", vertices: boxVertices(25) }],
    items: [{ objectid: "1" }]
  });
  const { detail } = await upload("single.3mf", make3mfPackage(xml));
  assert.equal(detail.status.next.kind, "slice");
  assert.equal(detail.status.plates.required, false);
  assert.equal(detail.status.plates.count, 1);
});

// ── Choosing ─────────────────────────────────────────────────────────────────

test("choosing a plate is recorded, audited, and clears the pending step", async () => {
  const { id } = await upload("choose.3mf", twoPlateProject(2));
  const res = await selectPlate(id, { plateIndex: 2 });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().selection.plateIndex, 2);
  assert.equal(res.json().selection.plateCount, 2);

  const detail = await detailOf(id);
  assert.equal(detail.artifact.metadata.plateSelection.plateIndex, 2);
  assert.equal(detail.status.plates.selectedIndex, 2);
  assert.equal(detail.status.plates.required, false);
  assert.equal(detail.status.next.kind, "slice", "with a plate chosen the file can be sliced");
  assert.ok(detail.audit.some((e: { action: string }) => e.action === "plate_selected"));
});

test("choosing a plate the file does not have is refused, and says which exist", async () => {
  const { id } = await upload("missing.3mf", twoPlateProject(3));
  const res = await selectPlate(id, { plateIndex: 7 });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /нет пластины №7/);
  assert.match(res.json().error.message, /1, 2/);
});

test("a plate with nothing on it cannot be chosen", async () => {
  const { id, detail } = await upload("empty.3mf", twoPlateProject(4, { emptySecondPlate: true }));
  // It is still SHOWN — the operator must be able to see that it is empty.
  assert.equal(detail.analyses.at(-1).data.plates.length, 2);

  const res = await selectPlate(id, { plateIndex: 2 });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /нет ни одной модели/);
});

test("a non-numeric plate index is a 400, not a stored nonsense choice", async () => {
  const { id } = await upload("bad.3mf", twoPlateProject(5));
  for (const body of [{ plateIndex: "two" }, { plateIndex: 1.5 }, {}]) {
    const res = await selectPlate(id, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal((await detailOf(id)).artifact.metadata.plateSelection, undefined);
});

test("the choice can be withdrawn, and the file goes back to asking", async () => {
  const { id } = await upload("clear.3mf", twoPlateProject(6));
  assert.equal((await selectPlate(id, { plateIndex: 1 })).statusCode, 200);

  const res = await app.inject({ method: "DELETE", url: `/api/print/artifacts/${id}/plate`, headers: auth });
  assert.equal(res.statusCode, 200);

  const detail = await detailOf(id);
  assert.equal(detail.artifact.metadata.plateSelection, undefined);
  assert.equal(detail.status.next.kind, "select_plate");
  assert.ok(detail.audit.some((e: { action: string }) => e.action === "plate_selection_cleared"));
});

test("choosing a plate is a mutation: it needs the API token", async () => {
  const { id } = await upload("auth.3mf", twoPlateProject(7));
  const res = await app.inject({
    method: "POST",
    url: `/api/print/artifacts/${id}/plate`,
    payload: { plateIndex: 1 }
  });
  assert.equal(res.statusCode, 401);
  assert.equal((await detailOf(id)).artifact.metadata.plateSelection, undefined);
});

// ── Preview ──────────────────────────────────────────────────────────────────

test("a plate's declared thumbnail is served with its real type", async () => {
  const { id } = await upload("thumb.3mf", twoPlateProject(8));
  const res = await app.inject({ method: "GET", url: `/api/print/artifacts/${id}/plates/1/preview` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.ok(res.rawPayload.subarray(0, 8).equals(fixtures.makePng().subarray(0, 8)));
});

test("a plate with no picture is a 404, not an empty image", async () => {
  const { id } = await upload("nopic.3mf", twoPlateProject(9));
  const res = await app.inject({ method: "GET", url: `/api/print/artifacts/${id}/plates/2/preview` });
  assert.equal(res.statusCode, 404);
});

test("a plate that does not exist is a 404", async () => {
  const { id } = await upload("nine.3mf", twoPlateProject(10));
  assert.equal(
    (await app.inject({ method: "GET", url: `/api/print/artifacts/${id}/plates/9/preview` })).statusCode,
    404
  );
});

test("a .png entry that is not a PNG is never served", async () => {
  // The archive carries an SVG under a .png name — the classic way to get a
  // script served as an image. The analyzer refuses it, so there is no preview
  // to fetch at all.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const { id, detail } = await upload("spoof.3mf", twoPlateProject(11, { thumbnail: svg }));
  assert.equal(detail.analyses.at(-1).data.plates[0].preview, null);
  const res = await app.inject({ method: "GET", url: `/api/print/artifacts/${id}/plates/1/preview` });
  assert.equal(res.statusCode, 404);
});

test("an oversized image is not served, and the file is still analysed", async () => {
  const huge = Buffer.concat([fixtures.makePng(4000, 4000), Buffer.alloc(5 * 1024 * 1024, 0x5a)]);
  const { id, detail } = await upload("huge.3mf", twoPlateProject(12, { thumbnail: huge }));
  assert.equal(detail.analyses.at(-1).state, "ready");
  assert.equal(
    (await app.inject({ method: "GET", url: `/api/print/artifacts/${id}/plates/1/preview` })).statusCode,
    404
  );
});

test("a caller cannot name an archive entry — only a plate", async () => {
  // Every shape someone would reach for if the endpoint took a path. The route
  // parses one integer out of the URL and looks the entry up in the stored
  // analysis, so none of these can reach the ZIP reader at all.
  const { id } = await upload("traverse.3mf", twoPlateProject(13));
  const attempts = [
    `/api/print/artifacts/${id}/plates/1/preview?entry=Metadata/project_secret.txt`,
    `/api/print/artifacts/${id}/plates/1/preview?path=../../../etc/passwd`,
    `/api/print/artifacts/${id}/plates/Metadata%2Fproject_secret.txt/preview`,
    `/api/print/artifacts/${id}/plates/..%2F..%2Fetc%2Fpasswd/preview`,
    `/api/print/artifacts/${id}/plates/1%2F..%2F..%2Fsecret/preview`
  ];
  for (const url of attempts) {
    const res = await app.inject({ method: "GET", url });
    // Either the declared preview (a PNG) or a refusal — never other content.
    if (res.statusCode === 200) {
      assert.equal(res.headers["content-type"], "image/png", url);
      assert.ok(!res.body.includes("SECRET-PROFILE-TOKEN"), url);
    } else {
      assert.ok(res.statusCode === 400 || res.statusCode === 404, `${url} → ${res.statusCode}`);
    }
  }
});

test("a declared thumbnail path pointing outside the package yields no preview", async () => {
  const { id, detail } = await upload(
    "escape.3mf",
    twoPlateProject(14, { thumbnailPath: "../../../etc/passwd" })
  );
  assert.equal(detail.analyses.at(-1).data.plates[0].preview, null);
  assert.equal(
    (await app.inject({ method: "GET", url: `/api/print/artifacts/${id}/plates/1/preview` })).statusCode,
    404
  );
});
