import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import {
  AnycubicHandshakeError,
  decryptCtrlBundle,
  performAnycubicHandshake,
  signCtrlRequest
} from "./handshake";

/*
 * The LAN handshake against a local fake printer (127.0.0.1, ephemeral port):
 * real HTTP, real MD5 signing, real AES-128-CBC. No device is contacted.
 *
 * Fixture values are synthetic; the shapes follow the captures the module note
 * cites. What is pinned: the signature the printer checks, the decryption, the
 * refusals (cloud mode, a rejected signature, garbage, redirects, a hang), the
 * rule that the device never chooses the address we talk to, and that no secret
 * ever reaches an error message.
 */

const TOKEN = "0123456789abcdefFEDCBA9876543210"; // 32 chars: [0:16] signs, [16:32] is the AES key
const LOCAL_TOKEN = "IVIVIVIVIVIVIVIV"; // the AES IV, 16 bytes
const BUNDLE = {
  broker: "mqtts://203.0.113.50:9883", // a device-supplied address that must be ignored
  deviceId: "a1b2c3d4e5f6",
  modelId: "20030",
  modelName: "Anycubic Kobra X",
  username: "user-1",
  password: "secret-password-1",
  devicecrt: "-----CERT-----",
  devicepk: "-----KEY-----",
  ip: "203.0.113.50"
};

function encrypt(bundle: unknown, key = TOKEN.slice(16, 32), iv = LOCAL_TOKEN): string {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  return Buffer.concat([cipher.update(JSON.stringify(bundle), "utf8"), cipher.final()]).toString("base64");
}

type Handler = (req: http.IncomingMessage, url: URL, res: http.ServerResponse) => void;

let server: http.Server;
let port = 0;
let handler: Handler = () => {};
const seen: { method: string; path: string; query: URLSearchParams }[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams });
    handler(req, url, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A printer that answers like the captures: /info, then a signed /ctrl. */
function printer(overrides: { info?: Record<string, unknown>; ctrl?: (url: URL) => unknown } = {}): void {
  seen.length = 0;
  handler = (req, url, res) => {
    if (req.method === "GET" && url.pathname === "/info") {
      json(res, {
        token: TOKEN,
        ctrlInfoUrl: "http://203.0.113.99:18910/ctrl", // must NOT be followed
        modelId: 20030,
        modelName: "Anycubic Kobra X",
        cn: "KX2026ABC123",
        deviceName: "Кобра у окна",
        ctrlType: "lan",
        ...overrides.info
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/ctrl") {
      if (overrides.ctrl) {
        json(res, overrides.ctrl(url));
        return;
      }
      const ts = Number(url.searchParams.get("ts"));
      const nonce = url.searchParams.get("nonce") ?? "";
      const ok = url.searchParams.get("sign") === signCtrlRequest(TOKEN, ts, nonce);
      json(res, ok ? { code: 200, message: "success", data: { token: LOCAL_TOKEN, info: encrypt(BUNDLE) } } : { code: 401, message: "sign error" });
      return;
    }
    res.writeHead(404).end();
  };
}

const options = () => ({ clientId: "ATELIERTESTCLIENTID0000000000000", httpPort: port, timeoutMs: 1500 });

test("a printer in LAN mode yields its identity and broker login", async () => {
  printer();
  const result = await performAnycubicHandshake("127.0.0.1", options());

  assert.deepEqual(result.credentials, {
    username: "user-1",
    password: "secret-password-1",
    deviceId: "a1b2c3d4e5f6",
    modelId: "20030"
  });
  assert.deepEqual(result.identity, {
    modelId: "20030",
    modelName: "Anycubic Kobra X",
    serialNumber: "KX2026ABC123",
    deviceName: "Кобра у окна"
  });

  // The signed request went to the host we were given, not the device's ctrlInfoUrl.
  assert.deepEqual(seen.map((r) => `${r.method} ${r.path}`), ["GET /info", "POST /ctrl"]);
  const ctrl = seen[1];
  assert.equal(ctrl.query.get("did"), "ATELIERTESTCLIENTID0000000000000");
  assert.match(ctrl.query.get("nonce") ?? "", /^[A-Za-z0-9]{6}$/);
  assert.match(ctrl.query.get("sign") ?? "", /^[0-9a-f]{32}$/);
  // Nothing beyond the bundle's login reaches the caller: no cert, key or address.
  assert.ok(!JSON.stringify(result).includes("203.0.113.50"));
  assert.ok(!JSON.stringify(result).includes("-----KEY-----"));
});

test("the signature is md5(md5(token[0:16]) + ts + nonce) — what the printer checks", () => {
  // Recomputed by the documented formula, independently of the helper.
  const md5 = (v: string) => createHash("md5").update(v, "utf8").digest("hex");
  const computed = signCtrlRequest(TOKEN, 1788474900000, "Ab3dE9");
  assert.match(computed, /^[0-9a-f]{32}$/);
  assert.equal(computed, md5(md5(TOKEN.slice(0, 16)) + "1788474900000" + "Ab3dE9"));
  assert.notEqual(computed, signCtrlRequest(TOKEN, 1788474900001, "Ab3dE9"), "the timestamp is signed");
});

test("the bundle decrypts with key token[16:32] and the answer's own token as IV", () => {
  assert.deepEqual(decryptCtrlBundle(encrypt(BUNDLE), TOKEN, LOCAL_TOKEN), BUNDLE);
  assert.throws(() => decryptCtrlBundle(encrypt(BUNDLE, "wrongwrongwrong!"), TOKEN, LOCAL_TOKEN));
});

test("a rejected signature is an explicit refusal, not a retry with something else", async () => {
  printer({ ctrl: () => ({ code: 401, message: "sign error" }) });
  await assert.rejects(performAnycubicHandshake("127.0.0.1", options()), (error: unknown) => {
    assert.ok(error instanceof AnycubicHandshakeError);
    assert.equal(error.failure, "rejected");
    assert.match(error.message, /код 401/);
    return true;
  });
});

test("cloud mode is named for what it is", async () => {
  printer({ info: { ctrlType: "cloud" } });
  await assert.rejects(performAnycubicHandshake("127.0.0.1", options()), (error: unknown) => {
    assert.ok(error instanceof AnycubicHandshakeError);
    assert.equal(error.failure, "cloud_mode");
    assert.match(error.message, /режим LAN/);
    return true;
  });
  assert.deepEqual(seen.map((r) => r.path), ["/info"], "no signed request is made");
});

test("an /info without a LAN token (other firmware, LAN off) is unsupported", async () => {
  printer({ info: { token: undefined } });
  await assert.rejects(
    performAnycubicHandshake("127.0.0.1", options()),
    (error: unknown) => error instanceof AnycubicHandshakeError && error.failure === "unsupported"
  );
});

test("something that is not a printer is refused, whatever it says", async () => {
  seen.length = 0;
  handler = (_req, _url, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>router login</html>");
  };
  await assert.rejects(
    performAnycubicHandshake("127.0.0.1", options()),
    (error: unknown) => error instanceof AnycubicHandshakeError && error.failure === "not_a_printer"
  );
});

test("a redirect is refused, not followed to the host the device names", async () => {
  seen.length = 0;
  handler = (_req, _url, res) => {
    res.writeHead(302, { location: "http://203.0.113.77:18910/info" });
    res.end();
  };
  await assert.rejects(performAnycubicHandshake("127.0.0.1", options()), (error: unknown) => {
    assert.ok(error instanceof AnycubicHandshakeError);
    assert.match(error.message, /перенаправлением/);
    return true;
  });
  assert.equal(seen.length, 1);
});

test("a hung printer times out within the bound", async () => {
  seen.length = 0;
  handler = () => {
    /* never answers */
  };
  const started = Date.now();
  await assert.rejects(
    performAnycubicHandshake("127.0.0.1", { ...options(), timeoutMs: 300 }),
    (error: unknown) => error instanceof AnycubicHandshakeError && error.failure === "timeout"
  );
  assert.ok(Date.now() - started < 3000);
});

test("an unreachable address is reported with its OS code", async () => {
  // A closed port on loopback: refused immediately, no device involved.
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));

  await assert.rejects(
    performAnycubicHandshake("127.0.0.1", { ...options(), httpPort: closedPort }),
    (error: unknown) => {
      assert.ok(error instanceof AnycubicHandshakeError);
      assert.equal(error.failure, "unreachable");
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    }
  );
});

test("an oversized answer is refused before it is buffered", async () => {
  seen.length = 0;
  handler = (_req, _url, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: TOKEN, junk: "x".repeat(200 * 1024) }));
  };
  await assert.rejects(
    performAnycubicHandshake("127.0.0.1", options()),
    (error: unknown) => error instanceof AnycubicHandshakeError && error.failure === "not_a_printer"
  );
});

test("a host that is not a bare address is refused before any request", async () => {
  seen.length = 0;
  for (const host of ["http://127.0.0.1", "127.0.0.1/x", "user@127.0.0.1", "127.0.0.1:18910", ""]) {
    await assert.rejects(
      performAnycubicHandshake(host, options()),
      (error: unknown) => error instanceof AnycubicHandshakeError && error.failure === "unsupported"
    );
  }
  assert.equal(seen.length, 0);
});

test("a bundle whose device id could widen the MQTT subscription is refused", async () => {
  printer({
    ctrl: () => ({ code: 200, data: { token: LOCAL_TOKEN, info: encrypt({ ...BUNDLE, deviceId: "+/#" }) } })
  });
  await assert.rejects(
    performAnycubicHandshake("127.0.0.1", options()),
    (error: unknown) => error instanceof AnycubicHandshakeError && error.failure === "unsupported"
  );
});

test("no failure message carries the token, the password or the ciphertext", async () => {
  const messages: string[] = [];
  const attempts: (() => void)[] = [
    () => printer({ ctrl: () => ({ code: 500, message: `token ${TOKEN}` }) }),
    () => printer({ ctrl: () => ({ code: 200, data: { token: LOCAL_TOKEN, info: "bm90LWEtY2lwaGVydGV4dA==" } }) }),
    () => printer({ ctrl: () => ({ code: 200, data: { token: LOCAL_TOKEN, info: encrypt({ password: BUNDLE.password }) } }) })
  ];
  for (const setup of attempts) {
    setup();
    try {
      await performAnycubicHandshake("127.0.0.1", options());
      assert.fail("expected a refusal");
    } catch (error) {
      messages.push(String((error as Error).message));
    }
  }
  for (const message of messages) {
    assert.ok(!message.includes(TOKEN), message);
    assert.ok(!message.includes(TOKEN.slice(0, 16)), message);
    assert.ok(!message.includes(BUNDLE.password), message);
    assert.ok(!message.includes("bm90LWEtY2lwaGVydGV4dA"), message);
  }
});
