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

/**
 * One resolved hardware characteristic, in the shape `/api/printers/config`
 * returns. `source` is the point of the whole structure — the card renders a
 * device-reported value differently from an operator-typed one — so the mock
 * carries real sources rather than a single placeholder.
 */
const spec = (value, source, via = null, observedAt = "2026-07-12T11:59:00.000Z") => ({
  value,
  source,
  via,
  observedAt,
  overriddenManual: null,
  catalogHint: null
});

/** Every characteristic unknown; spread first, then override the known ones. */
const unknownSpecs = () =>
  Object.fromEntries(
    [
      "model", "firmware", "deviceName", "technology", "buildVolume", "nozzleDiameterMm",
      "nozzleType", "material", "extruderCount", "ams", "materials", "chamberSensor",
      "heatedChamber", "filamentSensor", "kinematics"
    ].map((key) => [key, spec(null, "unknown", null, null)])
  );

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
  // Оператор и ручные операции. Расписание намеренно «пустое» (таймзона не
  // задана, presence UNKNOWN) — это и есть штатное начальное состояние фермы,
  // в котором автопродолжение заблокировано fail-closed.
  "/api/print/schedule": {
    schedule: {
      operator: { id: "op_default", name: "Оператор фермы", timeZone: null, active: true },
      available: [],
      sleep: [],
      exceptions: [],
      absences: [],
      availability: {
        presence: "UNKNOWN",
        reason: "таймзона оператора не задана",
        resolved: false,
        nextAvailableAt: null,
        availableUntil: null
      }
    },
    operators: [{ id: "op_default", name: "Оператор фермы", timeZone: null, active: true }],
    localToday: null
  },
  "/api/print/operations": { operations: [], holds: [] },
  "/api/print/operations/types": { types: [] },
  // Оборудование фермы. Учётные данные приходят СТАТУСОМ, а не значением —
  // ровно так, как их отдаёт настоящий backend; мок с настоящим кодом доступа
  // маскировал бы регресс, при котором секрет утёк бы в браузер.
  "/api/printers/config": {
    printers: [
      {
        id: "k2", name: "Creality K2", model: "Creality K2", type: "FDM", printerClass: "k2",
        protocol: "moonraker", host: "192.168.0.132", port: 4408,
        material: "PETG", nozzleDiameterMm: 0.4, nozzleType: "", buildVolume: null,
        swatch: "#4c4f55", snapshotUrl: "", streamUrl: "", interfaceUrl: "http://192.168.0.132:4408",
        enabled: true, allowInsecureTls: false,
        automaticContinuation: { allowed: false, mechanism: "", verifiedAt: null },
        light: { enabled: null, pin: "LED", invert: false, onGcode: "", offGcode: "", statusObject: "", statusField: "", bambuNode: "" },
        position: 10, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
        version: 1, metadata: {},
        secrets: {
          apiKey: { set: false, source: "none", envVar: null, resolved: false },
          serial: { set: false, source: "none", envVar: null, resolved: false },
          accessCode: { set: false, source: "none", envVar: null, resolved: false }
        },
        // Klipper публикует собственный конфиг, поэтому габариты и сопло тут
        // действительно прочитаны с устройства, а модель остаётся ручной —
        // протокол её не сообщает.
        discovery: { probedAt: "2026-07-12T11:59:00.000Z", succeeded: true, error: null },
        specs: {
          ...unknownSpecs(),
          model: spec("Creality K2", "manual", null, "2026-07-01T00:00:00.000Z"),
          buildVolume: spec(
            { x: 350, y: 350, z: 345 },
            "printer",
            "configfile.settings.stepper_{x,y,z}.position_max"
          ),
          nozzleDiameterMm: spec(0.4, "printer", "configfile.settings.extruder.nozzle_diameter"),
          material: spec("PETG", "manual", null, "2026-07-01T00:00:00.000Z"),
          kinematics: spec("corexy", "printer", "configfile.settings.printer.kinematics")
        }
      },
      {
        id: "bambu-a1", name: "Bambu A1", model: "Bambu Lab A1", type: "FDM", printerClass: "",
        protocol: "bambu", host: "192.168.0.187", port: 8883,
        material: "PLA", nozzleDiameterMm: 0.4, nozzleType: "", buildVolume: null,
        swatch: "#efe8d8", snapshotUrl: "", streamUrl: "", interfaceUrl: "",
        enabled: true, allowInsecureTls: true,
        automaticContinuation: { allowed: false, mechanism: "", verifiedAt: null },
        light: { enabled: null, pin: "", invert: false, onGcode: "", offGcode: "", statusObject: "", statusField: "", bambuNode: "chamber_light" },
        position: 20, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
        version: 1, metadata: {},
        secrets: {
          apiKey: { set: false, source: "none", envVar: null, resolved: false },
          serial: { set: true, source: "literal", envVar: null, resolved: true },
          accessCode: { set: true, source: "env", envVar: "BAMBU_A1_ACCESS_CODE", resolved: true }
        },
        // Пример из постановки задачи: A1 Combo с закалённым соплом 0,4. Всё,
        // кроме габаритов, прочитано с устройства; габариты MQTT не передаёт,
        // поэтому они «по модели» — и это видно по бейджу.
        discovery: { probedAt: "2026-07-12T11:59:30.000Z", succeeded: true, error: null },
        specs: {
          ...unknownSpecs(),
          model: spec("Bambu Lab A1", "printer", "MQTT info.get_version → ota.sn (серийный номер)"),
          firmware: spec("01.04.00.00", "printer", "MQTT info.get_version → ota.sw_ver"),
          buildVolume: spec({ x: 256, y: 256, z: 256 }, "catalog", "справочник моделей"),
          nozzleDiameterMm: spec(0.4, "printer", "MQTT print.nozzle_diameter"),
          nozzleType: spec("hardened_steel", "printer", "MQTT print.nozzle_type"),
          material: spec("PLA", "printer", "MQTT print.ams"),
          ams: spec({ present: true, kind: "AMS Lite", units: 1, slots: 4 }, "printer", "MQTT print.ams"),
          materials: spec(
            [
              { slot: 0, material: "PLA", color: "#EFE8D8", remainPct: 92, active: true },
              { slot: 1, material: "PETG", color: "#1A2B3C", remainPct: 40, active: false }
            ],
            "printer",
            "MQTT print.ams / vt_tray"
          )
        }
      }
    ]
  },
  "/api/printers/config/options": {
    protocols: [
      {
        id: "moonraker",
        label: "Moonraker",
        hint: "",
        credentials: ["apiKey"],
        autoFields: ["buildVolume", "nozzleDiameterMm"]
      },
      {
        id: "bambu",
        label: "Bambu Lab",
        hint: "",
        credentials: ["serial", "accessCode"],
        autoFields: ["model", "buildVolume", "nozzleDiameterMm", "nozzleType", "material"]
      },
      { id: "creality", label: "Creality", hint: "", credentials: [], autoFields: ["model"] }
    ],
    types: [{ id: "FDM", label: "FDM" }, { id: "Resin", label: "Фотополимер" }]
  },
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
