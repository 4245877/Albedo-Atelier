import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { PrinterConfig } from "../config";
import { uploadAnycubicFile } from "./anycubicUpload";

afterEach(() => mock.restoreAll());
const PRINTER = { id: "test", host: "192.0.2.10" } as PrinterConfig;
const page = (records: unknown[]) => ({ code: 200, data: { list_mode: 0, records } });

test("prepared HTTP upload uses filename/gcode fields and verifies returned name AND size without starting", async () => {
  let uploaded = false;
  let calls = 0;
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    const form = init.body as FormData;
    assert.equal(form.get("filename"), "test.gcode");
    assert.equal((form.get("gcode") as Blob).size, 3);
    assert.equal(form.get("print"), null);
    uploaded = true;
    return new Response(JSON.stringify({ code: 200 }));
  });
  const result = await uploadAnycubicFile(PRINTER, "local/test.gcode", new Uint8Array([1, 2, 3]), {
    uploadAddress: async () => "http://192.0.2.10:18910/gcode_upload?s=SECRET",
    withFileRead: async task => task(),
    readFilePage: async () => page(uploaded ? [{ filename: "test.gcode", is_dir: false, size: 3 }] : [])
  });
  assert.deepEqual(result, { remotePath: "local/test.gcode", sizeBytes: 3 });
  assert.equal(calls, 1);
});

test("existing files, unsafe names, unsupported formats and disabled gates refuse before bytes leave", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => { calls++; throw new Error("must not send"); });
  const session = { uploadAddress: async () => "http://192.0.2.10:18910/gcode_upload?s=SECRET", withFileRead: async <T>(task: () => Promise<T>) => task(), readFilePage: async () => page([{ filename: "a.gcode", is_dir: false, size: 3 }]) };
  for (const name of ["../a.gcode", "usb/a.gcode", "test.txt", "local/folder/a.gcode"]) {
    await assert.rejects(uploadAnycubicFile(PRINTER, name, new Uint8Array([1]), session));
  }
  await assert.rejects(uploadAnycubicFile(PRINTER, "a.gcode", new Uint8Array([1]), session), /перезапись/);
  await assert.rejects(uploadAnycubicFile(PRINTER, "b.gcode", new Uint8Array([1]), { ...session, uploadAddress: async () => { throw new Error("closed gate"); } }), /closed gate/);
  assert.equal(calls, 0);
});

test("upload timeout does not leak token or retry; a mismatched post-upload size is never verified", async () => {
  let calls = 0;
  const session = { uploadAddress: async () => "http://192.0.2.10:18910/gcode_upload?s=SECRET", withFileRead: async <T>(task: () => Promise<T>) => task(), readFilePage: async () => page([]) };
  mock.method(globalThis, "fetch", async () => { calls++; throw new Error("failed http://192.0.2.10/gcode_upload?s=SECRET"); });
  await assert.rejects(uploadAnycubicFile(PRINTER, "a.gcode", new Uint8Array([1]), session), e => {
    assert.equal(String(e).includes("SECRET"), false);
    return /исход загрузки неизвестен/.test(String(e));
  });
  assert.equal(calls, 1);
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ code: 200 })));
  await assert.rejects(uploadAnycubicFile(PRINTER, "a.gcode.3mf", new Uint8Array([1]), session), /имя и размер.*не подтверждены/);
});
