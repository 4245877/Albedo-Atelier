import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { PrinterConfig } from "../config";
import { AnycubicSession, type AnycubicMqttClient, type AnycubicTransport } from "./session";
import { anycubicPrivateUrl } from "./urls";
import { isCameraCommand, isLightCommand, isPrintControlCommand } from "./requests";
import { isPreparedAnycubicStart, prepareAnycubicStart } from "./start";

const BASE = "anycubic/anycubicCloud/v1/printer/public/20030/dev";
const PRINTER = { id: "test", name: "Kobra X" } as PrinterConfig;
const PIN = "11:".repeat(31) + "11";

async function featureFixture(controls: { light?: boolean; print?: boolean; upload?: boolean; start?: boolean } = {}) {
  const client = new EventEmitter() as AnycubicMqttClient;
  const published: { type: string; action: string; data: any }[] = [];
  const data: any = { state: "busy", version: "2.0.2.2", project: { state: "printing", pause: 0, filename: "local.gcode", task_id: "-1", print_time: 10 },
    urls: { rtspUrl: "http://192.0.2.10:18088/live/SECRET", fileUploadurl: "http://192.0.2.10:18910/gcode_upload?s=SECRET" } };
  let light = false;
  let apply = true;
  let naturalFinish = false;
  const files = [{ filename: "local.gcode", is_dir: false, size: 3 }];
  client.subscribe = () => {};
  client.end = () => {};
  client.publish = (_topic, payload, _opts, callback) => {
    const m = JSON.parse(payload);
    published.push(m);
    callback?.();
    queueMicrotask(() => {
      if (m.type === "info") report("info", { type: "info", action: "report", msgid: "rewritten", code: 200, data: structuredClone(data) });
      if (m.type === "light" && m.action === "query") report("light", { type: "light", action: "query", code: 200, data: { lights: [{ type: 3, status: light ? 1 : 0, brightness: light ? 100 : 0 }] } });
      if (m.type === "peripherie") report("peripherie", { type: "peripherie", action: "query", code: 200, data: { camera: 1, udisk: 0 } });
      if (m.type === "file") report("file", { type: "file", action: m.action, code: 200, data: { list_mode: 0, records: files } });
      if (m.type === "light" && m.action === "control" && apply) light = m.data.status === 1;
      if (m.type === "print" && apply) {
        if (m.action === "start") {
          data.state = "busy"; data.project = { state: "printing", pause: 0, filename: m.data.filename, task_id: "-1", print_time: 0 };
        } else if (m.action === "stop") {
          report("print", { type: "print", action: "stop", state: naturalFinish ? "finished" : "stoped", data: { filename: data.project.filename, taskid: "-1" } });
          data.state = "free"; data.project = null; data.last_project = naturalFinish ? { state: "stoped", filename: "older.gcode" } : {};
        } else { data.project.state = m.action === "pause" ? "paused" : "printing"; data.project.pause = m.action === "pause" ? 1 : 0; }
      }
    });
  };
  const transport: AnycubicTransport = {
    handshake: async () => ({ identity: { modelId: "20030", modelName: "Kobra X", serialNumber: null, deviceName: null }, credentials: { modelId: "20030", deviceId: "dev", username: "test", password: "test" } }),
    openTls: async () => new PassThrough(), createClient: () => client
  };
  const s = new AnycubicSession({ printerId: "test", host: "192.0.2.10", mqttPort: 9883, tlsFingerprint: PIN, transport, controls, confirmationPollMs: 0 });
  function report(type: string, payload: unknown) { client.emit("message", `${BASE}/${type}/report`, Buffer.from(JSON.stringify(payload))); }
  s.start();
  await new Promise(r => setImmediate(r));
  client.emit("connect");
  await new Promise(r => setImmediate(r));
  return { s, data, published, report, apply: (value: boolean) => { apply = value; }, naturalFinish: () => { naturalFinish = true; } };
}

test("each physical category is closed by default and the allowlists cannot cross categories", async () => {
  const f = await featureFixture();
  try {
    await assert.rejects(f.s.setLight(true), /не разрешена/);
    await assert.rejects(f.s.controlPrint("pause", f.s.status(PRINTER).controlJobKey!), /не разрешена/);
    assert.equal(f.published.some(x => x.action === "control" || x.action === "pause"), false);
    const message = { type: "light", action: "control", data: { type: 3, status: 1, brightness: 100 }, timestamp: 1, msgid: "m" };
    assert.equal(isLightCommand(message), true);
    assert.equal(isPrintControlCommand(message), false);
    assert.equal(isCameraCommand(message), false);
    assert.equal(isLightCommand({ ...message, data: { type: 2, status: 1, brightness: 100 } }), false);
    assert.equal(isPrintControlCommand({ ...message, type: "print", action: "update", data: { taskid: "-1" } }), false);
  } finally { f.s.stop(); }
});

test("light on/off require actual query convergence; a delivered control ACK never implies success", async () => {
  const f = await featureFixture({ light: true });
  try {
    await f.s.setLight(true);
    assert.equal(f.s.status(PRINTER).light, true);
    await f.s.setLight(false);
    assert.equal(f.s.status(PRINTER).light, false);
    f.apply(false);
    await assert.rejects(f.s.setLight(true), /не подтвердил/);
    assert.equal(f.s.status(PRINTER).light, false);
    f.data.version = "different-firmware";
    await f.s.refreshInfo();
    const count = f.published.length;
    await assert.rejects(f.s.setLight(true), /совместимого/);
    assert.equal(f.published.length, count);
  } finally { f.s.stop(); }
});

test("pause/resume/stop support screen-started task_id=-1 with a fresh observation key", async () => {
  const f = await featureFixture({ print: true });
  try {
    const key = f.s.status(PRINTER).controlJobKey!;
    await assert.rejects(f.s.controlPrint("pause"), /обновите карточку/);
    await assert.rejects(f.s.controlPrint("pause", "stale-key"), /обновите карточку/);
    await f.s.controlPrint("pause", key);
    assert.equal(f.s.status(PRINTER).status, "paused");
    await f.s.controlPrint("resume", key);
    assert.equal(f.s.status(PRINTER).status, "printing");
    await f.s.controlPrint("cancel", key);
    assert.equal(f.s.status(PRINTER).status, "idle");
    assert.deepEqual(f.published.filter(m => m.type === "print").map(m => [m.action, m.data]), [["pause", { taskid: "-1" }], ["resume", { taskid: "-1" }], ["stop", { taskid: "-1" }]]);
  } finally { f.s.stop(); }
});

test("uncertain print commands never retry; a natural finish does not confirm operator cancellation", async () => {
  const f = await featureFixture({ print: true });
  try {
    f.apply(false);
    const key = f.s.status(PRINTER).controlJobKey!;
    await assert.rejects(f.s.controlPrint("pause", key), /не подтверждено/);
    await assert.rejects(f.s.controlPrint("pause", key), /повторная отправка заблокирована/);
    assert.equal(f.published.filter(m => m.action === "pause").length, 1);
  } finally { f.s.stop(); }
  const g = await featureFixture({ print: true });
  try {
    g.naturalFinish();
    await assert.rejects(g.s.controlPrint("cancel", g.s.status(PRINTER).controlJobKey!), /не подтверждено/);
    assert.equal(g.s.status(PRINTER).stateText, "finished");
  } finally { g.s.stop(); }
});

test("same-file reprints with sentinel task ids get a new key; offline commands cannot publish", async () => {
  const f = await featureFixture({ print: true });
  try {
    const old = f.s.status(PRINTER).controlJobKey!;
    f.data.project.print_time = 0;
    await f.s.refreshInfo();
    assert.notEqual(f.s.status(PRINTER).controlJobKey, old);
    await assert.rejects(f.s.controlPrint("cancel", old), /обновите карточку/);
    assert.equal(f.published.some(m => m.action === "stop"), false);
    f.s.stop();
    await assert.rejects(f.s.controlPrint("pause", f.s.status(PRINTER).controlJobKey!), /актуального/);
  } finally { f.s.stop(); }
});

test("late pause confirmation releases the hold without retrying pause and permits an explicit resume", async () => {
  const f = await featureFixture({ print: true });
  try {
    const key = f.s.status(PRINTER).controlJobKey!;
    f.apply(false);
    await assert.rejects(f.s.controlPrint("pause", key), /не подтверждено/);
    f.data.project.state = "paused";
    f.data.project.pause = 1;
    f.apply(true);
    await f.s.controlPrint("resume", key);
    assert.equal(f.s.status(PRINTER).status, "printing");
    assert.equal(f.published.filter(m => m.action === "pause").length, 1);
    assert.equal(f.published.filter(m => m.action === "resume").length, 1);
  } finally { f.s.stop(); }
});

test("private camera addresses are bounded to the printer; leases are exclusive, released and never exposed in status", async () => {
  const f = await featureFixture();
  try {
    assert.equal(anycubicPrivateUrl(f.data.urls.rtspUrl, "192.0.2.10", "camera"), f.data.urls.rtspUrl);
    for (const url of ["http://evil.example:18088/live/SECRET", "http://192.0.2.10:18088/live/SECRET#exec", "http://u:p@192.0.2.10:18088/live/SECRET", "http://192.0.2.10:18088/other"]) {
      assert.equal(anycubicPrivateUrl(url, "192.0.2.10", "camera"), null);
    }
    let closed = 0;
    const a = f.s.leaseCameraSource(() => { closed++; });
    assert.throws(() => f.s.leaseCameraSource(() => {}), /уже обслуживается/);
    a.release();
    f.s.leaseCameraSource(() => { closed++; });
    assert.equal(JSON.stringify(f.s.status(PRINTER)).includes("SECRET"), false);
    assert.equal(JSON.stringify(f.s.identity()).includes("SECRET"), false);
    f.s.stop();
    assert.equal(closed, 1);
  } finally { f.s.stop(); }
});

test("upload/start remain closed independently of print control; prepared start requires artifact identity and pinned feed", async () => {
  const f = await featureFixture({ print: true });
  const identity = { sizeBytes: 3, md5: "a".repeat(32) };
  const start = prepareAnycubicStart("local/local.gcode", identity, { kind: "external" });
  try {
    assert.equal(isPreparedAnycubicStart(start), true);
    assert.equal(isPreparedAnycubicStart({ ...start, extra: "smuggled" }), false);
    assert.throws(() => prepareAnycubicStart("local/a.gcode.3mf", identity, { kind: "external" }), /только для .gcode/);
    assert.throws(() => prepareAnycubicStart("a.gcode", undefined, { kind: "external" }), /MD5/);
    assert.throws(() => prepareAnycubicStart("a.gcode", identity, { kind: "ams" }), /ACE/);
    await assert.rejects(f.s.uploadAddress(), /не разрешена/);
    await assert.rejects(f.s.startPreparedFile(start), /не разрешена/);
    assert.equal(f.published.some(m => m.action === "start"), false);
  } finally { f.s.stop(); }
});

test("prepared start confirms a real printing report; ACK-only start is held without retries", async () => {
  const start = prepareAnycubicStart("local.gcode", { sizeBytes: 3, md5: "a".repeat(32) }, { kind: "external" });
  for (const apply of [true, false]) {
    const f = await featureFixture({ start: true });
    try {
      f.data.state = "free"; f.data.project = null;
      await f.s.refreshInfo();
      f.apply(apply);
      if (apply) {
        await f.s.startPreparedFile(start);
        assert.equal(f.s.status(PRINTER).status, "printing");
      } else {
        await assert.rejects(f.s.startPreparedFile(start), /реальный старт не подтверждён/);
        await assert.rejects(f.s.startPreparedFile(start), /повтор запрещён/);
      }
      assert.equal(f.published.filter(m => m.action === "start").length, 1);
    } finally { f.s.stop(); }
  }
});
