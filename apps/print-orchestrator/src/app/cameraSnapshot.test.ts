import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { CameraError } from "../core/errors";
import type { PrinterConfig } from "../infra/printers/config";
import { CameraService } from "./cameraService";

/*
 * captureFresh() is the manual-snapshot capture path. For go2rtc/WebRTC cameras
 * (Creality K2) it must: refuse honestly when there is no still endpoint, and
 * otherwise attempt the explicitly configured snapshotUrl (frame.jpeg) with a
 * short timeout — the "extended" variant from the brief.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function go2rtcPrinter(over: Partial<PrinterConfig> = {}): PrinterConfig {
  return {
    id: "k2",
    name: "Creality K2",
    model: "K2",
    type: "FDM",
    protocol: "moonraker",
    host: "192.168.0.132",
    material: "PETG",
    nozzleDiameterMm: null,
    nozzleType: "",
    swatch: "#4c4f55",
    snapshotUrl: "http://go2rtc:1984/api/frame.jpeg?src=k2",
    streamUrl: "http://go2rtc:1984/api/stream.mp4?src=k2",
    enabled: true,
    apiKey: "",
    serial: "",
    accessCode: "",
    light: {
      enabled: false,
      pin: "",
      invert: false,
      onGcode: "",
      offGcode: "",
      statusObject: "",
      statusField: "value",
      bambuNode: "chamber_light"
    },
    ...over
  };
}

test("a go2rtc camera with no configured snapshotUrl reports the snapshot unavailable", async () => {
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response(null, { status: 500 });
  }) as typeof fetch;

  const cameras = new CameraService();
  await assert.rejects(
    () => cameras.captureFresh(go2rtcPrinter({ snapshotUrl: "" })),
    (err: unknown) => err instanceof CameraError && /WebRTC/.test((err as CameraError).message)
  );
  assert.equal(fetched, false, "no still request is made when there is no still endpoint");
});

test("a go2rtc camera with a configured snapshotUrl captures via that URL", async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    requested.push(String(url));
    return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { "content-type": "image/jpeg" }
    });
  }) as typeof fetch;

  const cameras = new CameraService();
  const frame = await cameras.captureFresh(go2rtcPrinter());

  assert.deepEqual([...frame.data], [0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(frame.mime, "image/jpeg");
  assert.equal(requested[0], "http://go2rtc:1984/api/frame.jpeg?src=k2");
});

test("a go2rtc still capture that never yields a frame surfaces a clear error", async () => {
  globalThis.fetch = (async () => {
    // Stand in for frame.jpeg hanging until aborted: the fetch rejects.
    throw new Error("aborted");
  }) as typeof fetch;

  const cameras = new CameraService();
  await assert.rejects(
    () => cameras.captureFresh(go2rtcPrinter()),
    (err: unknown) => err instanceof CameraError && /go2rtc/.test((err as CameraError).message)
  );
});
