import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, mock, test } from "node:test";
import { CameraService } from "../../../app/cameraService";
import { anycubicTestHooks, getAnycubicSession, shutdownAnycubicConnections } from "../anycubic";
import type { AnycubicMqttClient } from "../anycubic/session";
import { normalizePrinterConfig } from "../config";

afterEach(() => { shutdownAnycubicConnections(); delete anycubicTestHooks.transport; mock.restoreAll(); });

test("the existing camera endpoint proxies native FLV 206 to go2rtc, hides tokens and releases one upstream lease", async () => {
  const client = new EventEmitter() as AnycubicMqttClient;
  const published: string[] = [];
  client.subscribe = () => {};
  client.end = () => {};
  let token = "FIRST_TOKEN";
  let cameraPresent = 1;
  client.publish = (_topic, text, _options, callback) => {
    const m = JSON.parse(text); published.push(m.type + "/" + m.action); callback?.();
    const data = m.type === "info" ? { state: "free", version: "2.0.2.2", project: null, urls: { rtspUrl: `http://192.0.2.10:18088/live/${token}` } } : m.type === "peripherie" ? { camera: cameraPresent, udisk: 0 } : { lights: [{ type: 3, status: 0 }] };
    queueMicrotask(() => client.emit("message", `anycubic/anycubicCloud/v1/printer/public/20030/dev/${m.type}/report`, Buffer.from(JSON.stringify({ type: m.type, action: m.type === "info" ? "report" : m.action, code: 200, data }))));
  };
  anycubicTestHooks.transport = {
    handshake: async () => ({ identity: { modelId: "20030", modelName: "Kobra X", serialNumber: null, deviceName: null }, credentials: { username: "test", password: "test", modelId: "20030", deviceId: "dev" } }),
    openTls: async () => new PassThrough(), createClient: () => client
  };
  const p = normalizePrinterConfig({ id: "anycubic-kobra-x", name: "Kobra X", protocol: "anycubic-lan", host: "192.0.2.10", tlsFingerprint: "11:".repeat(31) + "11", streamUrl: "http://go2rtc:1984/api/stream.mp4?src=anycubic-kobra-x" })!;
  getAnycubicSession(p);
  await new Promise(r => setImmediate(r)); client.emit("connect"); await new Promise(r => setImmediate(r));
  const fetched: string[] = [];
  const signals: AbortSignal[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    fetched.push(String(url)); signals.push(init.signal!);
    assert.equal(init.redirect, "error");
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([70, 76, 86, 1, 1, 0, 0, 0, 9])); } }), { status: 206, headers: { "Content-Type": "video/x-flv" } });
  });
  const cameras = new CameraService();
  const a = await cameras.getStream(p);
  assert.equal(a.mime, "video/x-flv");
  await assert.rejects(cameras.getStream(p), /нет видеопотока/);
  assert.equal(fetched.length, 1, "multiple viewers share go2rtc's single upstream");
  a.close(); a.close();
  assert.equal(signals[0].aborted, true);
  cameraPresent = 0;
  await cameras.probe(p);
  assert.equal(cameras.getEntry(p.id)?.state, "offline");
  await assert.rejects(cameras.getStream(p), /нет видеопотока/);
  assert.equal(fetched.length, 1, "missing hardware never opens a fake stream");
  cameraPresent = 1;
  token = "ROTATED_TOKEN";
  const b = await cameras.getStream(p);
  assert.match(fetched[1], /ROTATED_TOKEN$/);
  shutdownAnycubicConnections();
  assert.equal(signals[1].aborted, true);
  b.close();
  assert.equal(published.some(m => m.startsWith("video/")), false, "no startCapture/stopCapture is ever needed for passive viewing");
});
