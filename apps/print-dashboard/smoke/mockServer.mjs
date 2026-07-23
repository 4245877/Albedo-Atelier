/* Static file server + mock orchestrator API for the browser smoke test.
   No dependencies. Serves the real dashboard files from disk and answers the
   handful of API routes the app calls on load, recording every request so the
   test can assert the app actually talked to the backend. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml"
};

/** Minimal but shape-correct payloads for the routes the dashboard fetches. */
const state = {
  service: { status: "ok", version: "v0.1.0", backend: "mock" },
  printers: [
    {
      id: "k2", name: "Creality K2", model: "K2 Plus", type: "FDM",
      status: "printing", job: "bracket.gcode", progress: 62, minutesLeft: 95,
      nozzle: [221, 220], bed: [60, 60], chamber: 31, material: "PETG", swatch: "#7a5cff",
      camera: "offline", snapshotAt: "21:14", light: true, lightSupported: true,
      snapshotAvailable: false, filesSupported: true, remoteStartSupported: true,
      liveMaterial: "PETG-CF", liveMaterialSource: "printer", liveMaterialColor: "#b04aff",
      nozzleDiameter: 0.4, nozzleDiameterSource: "printer", error: null,
      interfaceUrl: null, latestSnapshotUrl: null, cameraSrc: null, cameraStream: false
    },
    {
      id: "a1", name: "Bambu A1", model: "A1 Combo", type: "FDM",
      status: "idle", job: null, progress: null, minutesLeft: null,
      nozzle: [28, null], bed: [27, null], chamber: null, material: "PLA", swatch: "#2fd27d",
      camera: "none", light: null, lightSupported: false, snapshotAvailable: false,
      filesSupported: false, remoteStartSupported: false, liveMaterialSource: "config",
      nozzleDiameter: 0.4, nozzleDiameterSource: "config", error: null,
      interfaceUrl: null, latestSnapshotUrl: null, cameraSrc: null, cameraStream: false
    }
  ],
  lights: [],
  queue: [{ title: "Кронштейн", printer: "Creality K2", material: "PETG", eta: "3 ч", status: "ready", at: "22:00" }],
  night: { window: "21:30 – 07:30", windowStart: "21:30", windowEnd: "07:30", pick: 0, candidates: [] },
  critical: [], materials: { filament: [], resin: [], queueNeeds: [], mismatch: [] },
  today: { done: 4, active: 1, failed: 0, hoursUsed: 11, hoursQueued: 4 },
  perf: { load: 33, free: 1, busy: 1, avgPrint: "2 ч", successRate: 92 },
  automations: [], automationLastRun: null, maintenance: [], plan: [],
  system: [{ icon: "❖", text: "mock", kind: "ok" }], feed: [], warnings: []
};

const API = {
  "/api/dashboard": state,
  "/api/print/artifacts": { artifacts: [] },
  "/api/print/slicing/runtime": { runtime: { available: false, error: "mock" }, profileCounts: { active: 0, quarantined: 0, invalid: 0 }, missingParents: [], coverage: [] },
  "/api/print/slicing/profiles": { profiles: [] },
  "/api/print/slicing/profile-sets": { sets: [] },
  "/api/print/slicing/variants": { variants: [] },
  "/api/print/scheduler/queue": { queue: [] },
  "/api/print/scheduler/compatibility": { printers: [], rows: [] },
  "/api/print/scheduler/plans": { plans: [] },
  "/api/print/scheduler/night": null,
  "/api/monitoring/lease": { ok: true }
};

export function startMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let p = url.pathname;

    if (p.startsWith("/api/print-orchestrator/")) {
      const key = p.slice("/api/print-orchestrator".length);
      requests.push({ method: req.method, path: key });
      const body = API[key];
      if (body !== undefined) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      } else if (req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `mock: no ${key}` } }));
      }
      return;
    }

    if (p === "/") p = "/index.html";
    const file = path.join(DASHBOARD_DIR, p);
    if (!file.startsWith(DASHBOARD_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    // Freeze animations so the smoke run is deterministic and fast.
    let data = fs.readFileSync(file);
    if (p === "/index.html") {
      data = Buffer.from(
        data.toString("utf8").replace(
          "<head>",
          `<head><style>*,*::before,*::after{animation:none!important;transition:none!important}.reveal{opacity:1!important;transform:none!important}</style>`
        )
      );
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        requests,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}
